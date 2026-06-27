import { autoUpdater } from 'electron-updater'
import { app } from 'electron'

/**
 * Auto-update du LAUNCHER lui-même (pas du jeu) via GitHub Releases.
 * Le repo GitHub (ZKYXYKZ/krashland-launcher) est PUBLIC : aucun token n'est
 * nécessaire côté joueur pour lire les releases (autoUpdater fonctionne sans
 * authentification). Le GH_TOKEN reste utile uniquement côté développeur, au
 * moment de PUBLIER une release (npm run release:win / release.bat), jamais
 * embarqué dans le launcher distribué. En dev (npm run dev), on désactive
 * complètement les checks pour ne pas polluer les logs/réseau.
 *
 * Émet des événements vers le renderer via send(channel, payload) — fonction
 * injectée pour ne pas dépendre directement de mainWindow ici.
 */
export function setupAutoUpdate(send) {
  if (!app.isPackaged) {
    console.log('[autoUpdate] Désactivé en mode développement')
    return { checkNow: async () => ({ ok: false, error: 'Désactivé en dev' }) }
  }

  autoUpdater.autoDownload = false // on télécharge seulement après accord implicite (statut affiché à l'utilisateur)
  autoUpdater.autoInstallOnAppQuit = false // on installe nous-mêmes via quitAndInstall() dès le téléchargement terminé (cf. update-downloaded), pour éviter une course entre la fermeture "normale" de l'app et le lancement de l'installeur NSIS

  autoUpdater.on('checking-for-update', () => {
    send('update:status', { phase: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    send('update:status', { phase: 'available', version: info.version })
    autoUpdater.downloadUpdate().catch((err) => {
      send('update:status', { phase: 'error', error: err.message })
    })
  })

  autoUpdater.on('update-not-available', () => {
    send('update:status', { phase: 'up-to-date' })
  })

  autoUpdater.on('download-progress', (progress) => {
    send('update:status', {
      phase: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    send('update:status', { phase: 'ready', version: info.version })
    // Installation automatique, sans action du joueur : quitAndInstall() ferme proprement
    // le launcher puis lance l'installeur, ce qui évite le blocage NSIS observé quand
    // l'app se fermait "normalement" pendant que l'installeur tentait déjà de la tuer.
    setTimeout(() => autoUpdater.quitAndInstall(), 1500)
  })

  autoUpdater.on('error', (err) => {
    send('update:status', { phase: 'error', error: err.message })
  })

  async function checkNow() {
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  function quitAndInstall() {
    autoUpdater.quitAndInstall()
  }

  return { checkNow, quitAndInstall }
}
