// Configuration centrale du launcher — à adapter à la prod
export default {
  // URL de l'API backend Krashland (même backend que le site web)
  API_BASE_URL: process.env.KRASH_API_URL || 'https://krashland.fr/api',

  // URL du manifest de fichiers du jeu (liste + hash, hébergé sur le serveur web Krashland).
  // Le manifest ET tous les fichiers du client (Wow.exe, Data/, etc.) doivent vivre dans
  // CE MÊME dossier distant : le launcher déduit l'URL de chaque fichier en remplaçant
  // juste "manifest.json" par son chemin relatif (voir gameManager.js, getUrlForFile).
  MANIFEST_URL: process.env.KRASH_MANIFEST_URL || 'https://www.krashland.fr/repo/client/manifest.json',

  // Liens externes
  WEBSITE_URL: process.env.KRASH_WEBSITE_URL || 'https://krashland.fr',
  DISCORD_URL: 'https://discord.gg/MfWpPBDCcm',
  VOTE_URL: 'https://serveur-prive.net/world-of-warcraft/krashland/vote',

  // Realmlist par défaut écrit dans realmlist.wtf lors de l'install
  REALMLIST: 'set realmlist logon.krashland.fr'
}
