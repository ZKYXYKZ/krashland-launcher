# Mettre à jour le client du jeu — procédure admin

À faire à chaque fois qu'un fichier du client change (nouveau patch MPQ, correction d'un
DLL, ajout d'un addon). Le launcher ne découvre pas les fichiers tout seul : il lit
`manifest.json`, qui doit donc être régénéré après chaque modification.

## Prérequis

- Node.js installé sur le PC qui génère le manifest : https://nodejs.org (version LTS).
- Une copie locale complète du dossier client, identique à ce qui est servi en ligne.

## 1. Modifier les fichiers en local

Ajoute, remplace ou supprime les fichiers dans ta copie locale du client.

## 2. Régénérer le manifest

Ouvre un terminal dans le dossier du launcher et lance :

```bash
node tools/generate-manifest.js "D:\chemin\vers\le\client" 1.0.16
```

- Premier argument : le dossier du client.
- Deuxième argument : le nouveau numéro de version. **Il doit être différent du précédent**,
  sinon les joueurs ne verront pas la mise à jour. Incrémente simplement le dernier chiffre
  (1.0.15 → 1.0.16).

Le script écrit un `manifest.json` dans le dossier courant. Il réutilise les hash de
l'ancien manifest pour les fichiers inchangés, donc c'est rapide même sur 20 Go : seuls
les fichiers réellement modifiés sont relus.

À la fin, il affiche le nombre de fichiers et la taille totale. Vérifie que ça correspond
à ce que tu attends avant d'uploader.

## 3. Uploader, dans cet ordre

**L'ordre est important.**

1. D'abord **les fichiers du client** vers `krashland.fr/repo/client/` (FileZilla).
2. Une fois tous les transferts terminés, **le `manifest.json`** par-dessus l'ancien.

Si le manifest part en premier, les joueurs qui lancent le launcher entre les deux
cherchent des fichiers pas encore uploadés et se prennent des erreurs 404.

Dans FileZilla, active **Transfert → Utiliser un nom de fichier temporaire** : le fichier
n'apparaît sous son vrai nom qu'une fois le transfert terminé, ce qui évite qu'un joueur
télécharge un MPQ à moitié uploadé.

## 4. Vérifier

Ouvre `https://www.krashland.fr/repo/client/manifest.json` dans un navigateur : la ligne
`version` en haut doit afficher le nouveau numéro. Lance le launcher, il doit détecter
la mise à jour et ne télécharger que les fichiers modifiés.

## À ne jamais faire

- **Ne pas ajouter `manifest.json` ni `krashlauncher.exe` au manifest.** Le script les
  exclut automatiquement, ne contourne pas cette exclusion : c'est la panne de septembre
  2026, qui bloquait tous les joueurs dans une boucle de vérification sans fin
  (voir [sync-fixes.md](sync-fixes.md)).
- **Ne pas utiliser un autre script de génération.** Seul `tools/generate-manifest.js`
  applique les exclusions correctes.
- **Ne pas réutiliser le même numéro de version** : les joueurs ne verraient rien.
- **Ne pas toucher aux dossiers `WTF`, `Cache`, `Errors`, `Logs`, `Screenshots` ni à
  `realmlist.wtf` et `config.wtf`** : ils appartiennent à chaque joueur et sont
  volontairement exclus du manifest.

## Ce que le launcher fait de son côté

- Il compare taille + date de modification en premier, et ne recalcule le sha256 que si
  ça diffère. Une vérification sur un client déjà à jour est donc quasi instantanée.
- Un fichier téléchargé dont le sha256 ne correspond pas est supprimé et retéléchargé,
  jusqu'à 3 fois.
- Les fichiers retirés du manifest ne sont jamais supprimés automatiquement chez le
  joueur : c'est le bouton « Rechercher des fichiers obsolètes » dans Options qui les
  propose, et le joueur confirme.
