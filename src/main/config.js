// Configuration centrale du launcher — à adapter à la prod
export default {
  // URL de l'API backend Krashland (même backend que le site web)
  API_BASE_URL: process.env.KRASH_API_URL || 'https://krashland.fr/api',

  // URL du manifest de fichiers du jeu (liste + hash, hébergé sur le serveur web Krashland).
  // Le manifest ET tous les fichiers du client (Wow.exe, Data/, etc.) doivent vivre dans
  // CE MÊME dossier distant : le launcher déduit l'URL de chaque fichier en remplaçant
  // juste "manifest.json" par son chemin relatif (voir gameManager.js, getUrlForFile).
  MANIFEST_URL: process.env.KRASH_MANIFEST_URL || 'https://www.krashland.fr/repo/client/manifest.json',

  // Serveur de secours : utilisé si le serveur principal est injoignable pour le manifest
  // ou pour un fichier individuel (après épuisement des retries sur le primaire).
  // Doit exposer la même arborescence que MANIFEST_URL (manifest.json + Data/, etc.).
  // null = pas de fallback configuré.
  // 2026-09 : l'ancien serveur de secours (51.75.19.40) a été coupé. Le laisser
  // configuré ne servait qu'à ajouter 3 retries vers une IP morte après chaque
  // échec du primaire, et à remonter dans l'UI l'erreur du fallback (ECONNREFUSED)
  // au lieu de la vraie cause côté krashland.fr.
  MANIFEST_FALLBACK_URL: process.env.KRASH_MANIFEST_FALLBACK_URL || null,

  // Volume (en octets) à partir duquel le launcher demande confirmation au joueur
  // avant de lancer un téléchargement. En dessous, il télécharge sans l'interrompre.
  CONFIRM_THRESHOLD_BYTES: Number(process.env.KRASH_CONFIRM_THRESHOLD) || 1024 * 1024 * 1024,

  // Liens externes
  WEBSITE_URL: process.env.KRASH_WEBSITE_URL || 'https://krashland.fr',
  DISCORD_URL: 'https://discord.gg/MfWpPBDCcm',
  VOTE_URL: 'https://serveur-prive.net/world-of-warcraft/krashland/vote',

  // Realmlist par défaut écrit dans Data/frFR/realmlist.wtf lors de l'install
  // (c'est le seul realmlist.wtf lu par le client 3.3.5 — celui à la racine
  // du dossier d'install n'est jamais pris en compte par le jeu).
  REALMLIST: 'set realmlist krashland.fr',

  // Locale du client distribué : dossier Data/<LOCALE>/ où vit le vrai realmlist.wtf.
  REALMLIST_LOCALE: 'frFR'
}
