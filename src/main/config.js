// Configuration centrale du launcher — à adapter à la prod
export default {
  // URL de l'API backend Krashland (même backend que le site web)
  API_BASE_URL: process.env.KRASH_API_URL || 'https://krashland.fr/api',

  // URL du manifest de fichiers du jeu (liste + hash, hébergé sur ton serveur/CDN)
  MANIFEST_URL: process.env.KRASH_MANIFEST_URL || 'https://cdn.krashland.fr/client/manifest.json',

  // Liens externes
  WEBSITE_URL: process.env.KRASH_WEBSITE_URL || 'https://krashland.fr',
  DISCORD_URL: 'https://discord.gg/MfWpPBDCcm',
  VOTE_URL: 'https://serveur-prive.net/world-of-warcraft/krashland/vote',

  // Realmlist par défaut écrit dans realmlist.wtf lors de l'install
  REALMLIST: 'set realmlist logon.krashland.fr'
}
