import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import Store from 'electron-store'
import { syncGame, fetchManifestVersion, findObsoleteFiles, deleteObsoleteFiles } from './gameManager.js'
import { launchGame } from './gameLauncher.js'
import { setupAutoUpdate } from './autoUpdate.js'
import config from './config.js'

const store = new Store({
  encryptionKey: 'krashland-launcher-local-store' // chiffrement local basique (anti-lecture en clair sur disque)
})

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 680,
    minWidth: 900,
    minHeight: 560,
    frame: false,
    backgroundColor: '#0d0a04',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Expose au renderer la config publique (URL API, liens) résolue par le main process —
// seule source de vérité pour KRASH_API_URL, utilisée pour les news et la synchro du jeu.
// Aucune donnée sensible ici (pas de token, pas de clé).
ipcMain.handle('config:get', () => ({
  apiBaseUrl: config.API_BASE_URL,
  websiteUrl: config.WEBSITE_URL,
  discordUrl: config.DISCORD_URL,
  voteUrl: config.VOTE_URL,
  appVersion: app.getVersion()
}))

ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:close', () => mainWindow?.close())
ipcMain.on('window:maximize-toggle', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})

// Liste blanche : empêche le renderer de lire/écrire des clés arbitraires via ce canal générique.
const STORE_ALLOWED_KEYS = new Set(['game.installPath', 'game.installVerified', 'game.manifestVersion'])

ipcMain.handle('store:get', (_e, key) => {
  if (!STORE_ALLOWED_KEYS.has(key)) return undefined
  return store.get(key)
})
ipcMain.handle('store:set', (_e, key, value) => {
  if (!STORE_ALLOWED_KEYS.has(key)) return false
  store.set(key, value)
  return true
})
ipcMain.handle('store:delete', (_e, key) => {
  if (!STORE_ALLOWED_KEYS.has(key)) return false
  store.delete(key)
  return true
})


let syncInProgress = false

ipcMain.handle('game:chooseFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Choisir le dossier d'installation du jeu",
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || !res.filePaths.length) return { ok: false }
  store.set('game.installPath', res.filePaths[0])
  // Nouveau dossier choisi : on invalide toute vérification précédente, un nouveau
  // check complet sera nécessaire avant de pouvoir jouer depuis ce dossier.
  store.set('game.installVerified', false)
  return { ok: true, path: res.filePaths[0] }
})

// game:sync effectue toujours le check complet (1491 fichiers et plus) — appelé
// uniquement lors du premier lancement (onboarding) ou via le bouton "Vérifier les
// fichiers" dans les Options, jamais automatiquement à chaque démarrage du launcher.
ipcMain.handle('game:sync', async (event) => {
  if (syncInProgress) return { ok: false, error: 'Synchronisation déjà en cours' }
  const installPath = store.get('game.installPath')
  if (!installPath) return { ok: false, error: "Dossier d'installation non défini" }

  syncInProgress = true
  try {
    const result = await syncGame(installPath, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('game:sync-progress', progress)
      }
    })
    store.set('game.installVerified', true)
    if (result.version) store.set('game.manifestVersion', result.version)
    if (result.manifestFiles) {
      // On garde l'ancien manifest en "prev" pour que le bouton "Nettoyer" dans
      // Options puisse comparer avant/après et identifier les fichiers retirés.
      const prev = store.get('game.manifestFiles') || []
      store.set('game.prevManifestFiles', prev)
      store.set('game.manifestFiles', result.manifestFiles)
    }
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    syncInProgress = false
  }
})

// ── IPC : lancement du jeu (le joueur saisit ses identifiants dans le client lui-même) ──
let playInProgress = false

ipcMain.handle('game:play', async () => {
  if (playInProgress) return { ok: false, error: 'Lancement déjà en cours' }

  const installPath = store.get('game.installPath')
  if (!installPath) return { ok: false, error: "Dossier d'installation non défini" }

  playInProgress = true
  try {
    launchGame(installPath)
    // Ferme le launcher après le lancement du jeu — le joueur n'en a plus besoin
    // et WoW tourne en processus indépendant (child.unref() dans gameLauncher.js).
    setTimeout(() => mainWindow?.close(), 1000)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    playInProgress = false
  }
})

// Check léger appelé au démarrage si le joueur a déjà une installation vérifiée :
// récupère juste la version du manifest distant (1 requête JSON, quasi instantané),
// sans rien comparer fichier par fichier. Si la version diffère de celle mémorisée
// au dernier sync complet, le renderer sait qu'il doit relancer game:sync (qui,
// grâce au fast-path mtime+taille de diffManifest, ne re-téléchargera que ce qui
// a réellement changé — pas un check complet coûteux).
ipcMain.handle('game:checkVersion', async () => {
  try {
    const remoteVersion = await fetchManifestVersion()
    const localVersion = store.get('game.manifestVersion')
    return { ok: true, upToDate: localVersion === remoteVersion, remoteVersion, localVersion }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Retourne les fichiers retirés du manifest depuis le dernier sync.
// Comparaison prevManifestFiles (avant sync) vs manifestFiles (après sync).
// Seuls ces fichiers peuvent être proposés à la suppression — jamais les
// fichiers ajoutés manuellement par le joueur (patches HD, addons custom…).
ipcMain.handle('game:findObsolete', () => {
  const installPath = store.get('game.installPath')
  if (!installPath) return { ok: false, error: "Dossier d'installation non défini" }
  const prev    = store.get('game.prevManifestFiles') || []
  const current = { files: (store.get('game.manifestFiles') || []).map(p => ({ path: p })) }
  const files   = findObsoleteFiles(installPath, prev, current)
  return { ok: true, files }
})

// Supprime les fichiers confirmés par le joueur via la boîte de dialogue dans Options.
ipcMain.handle('game:deleteObsolete', (_e, files) => {
  const installPath = store.get('game.installPath')
  if (!installPath) return { ok: false, error: "Dossier d'installation non défini" }
  if (!Array.isArray(files) || !files.length) return { ok: true, removed: [] }
  const removed = deleteObsoleteFiles(installPath, files)
  return { ok: true, removed }
})

// Ouvre le dossier de logs du launcher dans l'explorateur Windows.
// Utile pour récupérer des infos de debug chez un joueur sans avoir à lui
// expliquer comment naviguer dans %AppData%.
ipcMain.handle('game:openLogs', () => {
  shell.openPath(app.getPath('logs'))
})

// ── Auto-update du launcher (GitHub Releases privé) ──
let updater = null

ipcMain.handle('update:check', async () => {
  if (!updater) return { ok: false, error: 'Auto-update indisponible' }
  return updater.checkNow()
})

ipcMain.handle('update:install', () => {
  updater?.quitAndInstall()
})

app.whenReady().then(() => {
  createWindow()
  updater = setupAutoUpdate((channel, payload) => {
    mainWindow?.webContents.send(channel, payload)
  })
  // Vérifie une update au démarrage, sans bloquer l'affichage de la fenêtre
  updater.checkNow?.()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
