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

## Nettoyage et build 1.0.3

Version publiée la plus récente : tag `v1.0.1`. Les correctifs ci-dessus n'ayant jamais
été distribués, la version passe à `1.0.3`.

Code mort supprimé (rien ne l'importait) :

- `src/main/apiClient.js` — client axios authentifié, vestige de l'époque où le launcher
  gérait la connexion du joueur.
- `src/renderer/src/views/LoginView.vue` — même vestige, le joueur se connecte dans le
  client WoW.
- `src/renderer/src/constants.js` — fichier vide depuis le passage à `config:get`.
- `scripts/generate-manifest.js` — doublon obsolète de `tools/generate-manifest.js`,
  sans aucune exclusion. C'est exactement le script qui, s'il était relancé, réintroduirait
  `manifest.json` et le launcher dans le manifest. Seul `tools/generate-manifest.js`
  doit être utilisé.

Dépendances retirées de `package.json` (aucun import dans le code) :
`@nut-tree-fork/nut-js`, `active-win`, `extract-zip`. Elles restaient de la saisie
automatique des identifiants, abandonnée depuis. `@nut-tree-fork/nut-js` embarque en plus
des binaires natifs, source classique d'échec de packaging : 172 paquets en moins.

Build : `npx electron-builder --win --publish never` → `dist/Krashland Launcher Setup 1.0.3.exe`
(98 Mo) + `latest.yml` + `.blockmap`.

Attention pour la publication : `latest.yml` référence le fichier sous le nom
`Krashland-Launcher-Setup-1.0.3.exe` (tirets), alors que le fichier sur le disque porte
des espaces. Un upload manuel sur la release GitHub casse donc l'auto-update (404 côté
electron-updater). Publier avec `npm run release:win` (GH_TOKEN requis), qui téléverse
l'exe, le `.blockmap` et le `latest.yml` avec les bons noms, ou renommer l'exe en
`Krashland-Launcher-Setup-1.0.3.exe` avant l'upload manuel.

## Version 1.0.4 — journalisation, reprise de téléchargement, confirmation du volume

### Journalisation dans un fichier (`src/main/logger.js`)

Avant : aucun `console.log` du main process n'était écrit nulle part une fois l'app
packagée, et le bouton « Voir les logs » d'Options ouvrait `app.getPath('logs')`, un
dossier qui n'existait même pas. Aucune trace exploitable quand un joueur signalait un
problème.

- `electron-log` écrit désormais dans `<logs>/main.log`, rotation à 5 Mo.
- `Object.assign(console, log.functions)` redirige tous les `console.*` existants sans
  avoir à les réécrire.
- `autoUpdater.logger = log` : le détail des mises à jour du launcher est tracé aussi.
- `errorHandler.startCatching({ showDialog: false })` : une exception non capturée dans
  le main process est écrite dans le log au lieu d'afficher une boîte Electron brute.
- `game:openLogs` crée le dossier avant de l'ouvrir, donc le bouton fait toujours quelque chose.

### Reprise de téléchargement (`src/main/gameManager.js`)

Avant : un `patch.MPQ` de 4 Go coupé à 95 % repartait de zéro, trois fois, puis faisait
échouer tout le sync. Sur une connexion instable, un joueur pouvait ne jamais arriver au bout.

- Le fichier temporaire porte un nom dérivé du sha256 attendu, donc stable d'une tentative
  à l'autre et d'un lancement du launcher à l'autre. Un fichier modifié côté serveur obtient
  un nom différent : aucun risque de reprendre sur un `.part` périmé.
- En-tête `Range: bytes=<taille du .part>-` et écriture en append quand le `.part` existe.
  Réponse 206 → reprise ; 200 → le serveur ignore la reprise, on repart de zéro ;
  416 → le `.part` est jeté.
- Le `.part` n'est plus supprimé sur échec réseau (c'est lui qui sert de reprise). Il ne
  l'est que sur erreur d'intégrité : sha256 incorrect ou plage refusée.
- Contrôle de taille avant la copie : un stream terminé par une coupure propre ne passe
  plus par une copie complète de plusieurs minutes avant d'être détecté au sha256.
- `MAX_RETRIES` passe de 3 à 5, une tentative ratée ne coûtant plus un téléchargement complet.
- La progression est désormais calculée comme `octets des fichiers terminés + octets réellement
  sur le disque pour le fichier en cours`, au lieu d'additionner des deltas et de soustraire
  ceux des tentatives ratées. La barre ne peut plus reculer.

### Confirmation du volume avant téléchargement

Avant : un clic et le joueur était embarqué dans 20 Go sans être prévenu.

- `syncGame()` accepte un callback `confirmDownload({ totalBytes, fileCount })` appelé
  au-delà de `CONFIRM_THRESHOLD_BYTES` (1 Go par défaut, réglable dans `config.js` ou via
  `KRASH_CONFIRM_THRESHOLD`). En dessous du seuil, un petit patch s'installe sans rien demander.
- Côté main, `askDownloadConfirmation()` interroge le renderer et attend sa réponse ; si la
  fenêtre disparaît entre-temps, la promesse se résout à `false` au lieu de laisser le sync
  suspendu indéfiniment.
- Onboarding : écran « X Go à télécharger » avec Télécharger / Annuler. Annuler ramène à
  l'écran de départ.
- Vue principale : la barre affiche le volume, le bouton devient TÉLÉCHARGER et un bouton
  « Plus tard » apparaît. En cas de refus, l'état reste `pending-download`, le joueur relance
  quand il veut.
- Un refus ne pose pas `game.installVerified` : rien n'a été installé, l'état précédent est conservé.

### Vérifications

Test bout en bout sur serveur HTTP local avec coupures réseau provoquées en plein transfert
(socket détruit à 2 Mo puis 4 Mo sur un fichier de 6 Mo) :

- confirmation demandée, refus honoré, rien écrit sur le disque ;
- après acceptation, deux reprises via `Range: bytes=2097002-` puis `bytes=4193945-` ;
- progression jamais en arrière, progression finale égale au total ;
- fichier final intègre (sha256), mtime aligné sur le manifest, `.part` nettoyé ;
- relance immédiate : plus rien à télécharger, aucune nouvelle demande de confirmation.

ESLint : 0 erreur. `electron-vite build` : OK.
