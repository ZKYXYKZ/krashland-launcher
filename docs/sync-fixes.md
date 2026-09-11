# Correctifs synchronisation — 2026-09-11

Contexte : les joueurs signalaient un launcher qui télécharge tout le client, échoue
en fin de synchronisation, puis relance une vérification complète à chaque redémarrage
sans jamais proposer de lancer le jeu.

## Cause racine

Le manifest 1.0.14 (régénéré avec `tools/generate-manifest.js`) contenait deux entrées
qui ne pouvaient jamais être satisfaites :

| Entrée | Problème |
|---|---|
| `manifest.json` | Auto-référence. Le générateur scanne le dossier **avant** d'écrire le nouveau manifest : la taille et le sha256 enregistrés sont donc ceux de l'ancien fichier. Après téléchargement, le manifest servi ne correspond jamais au hash attendu → `Fichier corrompu (sha256 mismatch)` → 3 retries → échec de tout le sync. |
| `krashlauncher.exe` | 84 Mo, et verrouillé par Windows si le launcher tourne depuis le dossier d'installation → `EPERM` sur la copie. |

Ces deux entrées sont en position 63 et 64 sur 71, d'où l'échec « à la fin ».

Effet en cascade : `game:sync` ne pose `game.installVerified = true` qu'en cas de succès
complet. L'échec systématique laissait donc le flag à `false` → retour à l'onboarding
au redémarrage → nouvelle vérification complète → nouvel échec. Boucle infinie.

Second facteur aggravant : les fichiers téléchargés recevaient la date d'écriture et non
celle du manifest. Le fast-path `taille + mtime` de `diffManifest` ne s'appliquait donc
jamais aux fichiers fraîchement téléchargés, et chaque relance re-hashait les ~21 Go de MPQ.

## Modifications

### `manifest.json`
- Suppression des entrées `manifest.json` et `krashlauncher.exe`.
- Version passée à `1.0.15`, `fileCount` et `totalSize` recalculés (69 fichiers, 20,99 Go).

### `tools/generate-manifest.js`
- `EXCLUDED_FILES` : ajout de `manifest.json`, `krashlauncher.exe`, `krashland-launcher.exe`.
- `EXCLUDED_EXT` : ajout de `.part` et `.tmp`.
- Le nom de fichier passé en `--out` et `--prev` est automatiquement exclu du scan.
- Suppression d'une variable morte dans `collectFiles`.

### `src/main/gameManager.js`
- `NEVER_SYNCED` + `sanitizeManifest()` : garde-fou côté client, les entrées non
  synchronisables sont retirées à la réception du manifest, même si un futur manifest
  les réintroduit. Un launcher à jour ne peut donc plus se bloquer là-dessus.
- `findObsoleteFiles()` ne propose jamais ces fichiers à la suppression.
- `downloadFiles()` applique `fs.utimesSync(dest, file.mtime, file.mtime)` après écriture :
  le fast-path taille + mtime fonctionne dès la relance suivante, plus aucun re-hash
  des fichiers déjà téléchargés.
- `downloadFileOnce()` : ajout de `res.on('error')` (une coupure socket en plein flux
  émettait un `error` non géré sur la réponse → exception non capturée dans le main
  process) et de `res.resume()` sur réponse non-200 (socket laissé ouvert).

### `src/main/config.js`
- `MANIFEST_FALLBACK_URL` passé à `null` : le serveur de secours `51.75.19.40` a été coupé.
  Le laisser configuré ajoutait 3 retries vers une IP morte après chaque échec du primaire,
  et remontait dans l'UI l'erreur du fallback (`ECONNREFUSED`) à la place de la vraie cause.
  Pour réactiver un secours, repasser une URL ici ou via `KRASH_MANIFEST_FALLBACK_URL`.

### `src/renderer/src/views/OnboardingView.vue`
- Nouvelle prop `resumePath` : si un dossier d'installation est déjà mémorisé mais non
  vérifié, la synchro reprend directement au lieu de reposer la question
  « le jeu est-il déjà installé ? ».
- Écran d'erreur : bouton « Réessayer » qui relance la synchro sur le même dossier
  (avant, il renvoyait au choix de dossier), plus « Changer de dossier ».

### `src/renderer/src/views/MainView.vue`
- Passage de `installPath` à l'onboarding pour la reprise.
- Le bouton de la barre basse devient « RÉESSAYER » en état d'erreur et relance la synchro.

### `package.json`
- Version `1.0.1` → `1.0.2`.

## Déploiement

1. **Uploader le `manifest.json` corrigé** sur `https://www.krashland.fr/repo/client/`.
   Cette étape seule débloque les joueurs déjà installés, sans nouveau launcher :
   la version passe de 1.0.14 à 1.0.15, le check de version déclenche un sync qui
   cette fois aboutit.
2. Supprimer `krashlauncher.exe` et `manifest.json` du dossier client servi si on ne
   veut pas qu'ils restent téléchargeables (facultatif, ils ne sont plus référencés).
3. Builder et publier le launcher 1.0.2 (`npm run release:win`) pour le fast-path mtime,
   la reprise après erreur et le garde-fou client.

## Vérifications effectuées

- `electron-vite build` : OK (main, preload, renderer).
- ESLint 9 + eslint-plugin-vue sur `src/`, `tools/`, `scripts/` : 0 erreur
  (6 warnings cosmétiques de saut de ligne, préexistants).
- Test fonctionnel bout en bout sur serveur HTTP local avec un manifest reproduisant
  le bug (entrées `manifest.json` au hash volontairement faux et `krashlauncher.exe`) :
  - passe 1 : les deux entrées sont ignorées, les 3 vrais fichiers sont téléchargés,
    sha256 validés, `realmlist.wtf` écrit, sync `ready` ;
  - passe 2 : 0 fichier à retélécharger et **0 fichier relu/re-hashé** (fast-path actif,
    mtimes alignés sur le manifest) ;
  - `krashlauncher.exe` et `manifest.json` absents du dossier d'installation.

## Correctif complémentaire — crash « Object has been destroyed »

Symptôme : boîte d'erreur Electron au premier lancement après réinstallation,
`TypeError: Object has been destroyed` levé depuis le handler `data` d'un
téléchargement (`onChunk` → `onProgress` → `event.sender.send`).

Cause : le launcher fraîchement installé était en retard d'une version, l'auto-update
s'est déclenché au démarrage et `quitAndInstall()` a détruit la fenêtre pendant que la
synchro du jeu tournait encore. L'event de progression suivant a appelé `send()` sur un
WebContents détruit — le test `isDestroyed()` ne couvre pas la destruction survenant
côté natif entre le test et l'envoi, et l'exception non capturée remonte jusqu'au
handler par défaut d'Electron.

- `src/main/index.js` : helper `safeSend()` (test `isDestroyed()` + `try/catch`) utilisé
  pour la progression de sync et pour les events de l'auto-updater.
- `src/main/autoUpdate.js` : `setupAutoUpdate(send, isBusy)`. L'installation de la mise
  à jour du launcher est reportée par tranches de 20 s tant qu'une synchro du jeu est en
  cours, au lieu de redémarrer en plein téléchargement de plusieurs Go.
- `src/renderer/src/components/UpdateBanner.vue` : phase `ready-waiting` affichée
  pendant ce report.
