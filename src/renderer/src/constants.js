// Fichier conservé vide intentionnellement : ces URLs étaient codées en dur ici,
// ce qui faisait pointer le launcher vers la prod même en test local (KRASH_API_URL
// n'était lu que côté main process). Elles sont désormais résolues dynamiquement
// via window.krash.config.get() (IPC config:get → main/config.js), seule source
// de vérité, déjà utilisée pour l'auth/le sync. Voir MainView.vue (onMounted).
