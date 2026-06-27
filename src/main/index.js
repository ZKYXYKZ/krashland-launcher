import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import Store from 'electron-store'
import { createApiClient } from './apiClient.js'
import { syncGame } from './gameManager.js'
import { launchAndLogin } from './gameLauncher.js'
import { setupAutoUpdate } from './autoUpdate.js'
import config from './config.js'

const store = new Store({
  encryptionKey: 'krashland-launcher-local-store' // chiffrement local basique (anti-lecture en clair sur disque)
})

// Le token JWT ne quitte jamais le process main (pas exposé au renderer)
const api = createApiClient(() => store.get('auth.token') || null)

// Identifiants gardés UNIQUEMENT en mémoire (RAM du process main), jamais persistés sur
// disque, jamais exposés au renderer. Réinitialisés à chaque démarrage du launcher —
// nécessaires pour la saisie auto au lancement du jeu (le mdp n'est pas dans le JWT).
let sessionCredentials = null

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

// Expose au renderer la config publique (URL API) résolue par le main process —
// seule source de vérité pour KRASH_API_URL, déjà utilisée pour l'auth/le sync.
// Aucune donnée sensible ici (pas de token, pas de clé).
ipcMain.handle('config:get', () => ({
  apiBaseUrl: config.API_BASE_URL,
  websiteUrl: config.WEBSITE_URL,
  discordUrl: config.DISCORD_URL,
  voteUrl: config.VOTE_URL
}))

ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:close', () => mainWindow?.close())
ipcMain.on('window:maximize-toggle', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})

// Liste blanche : empêche le renderer de lire/écrire des clés sensibles
// (notamment auth.token, auth.user) via ce canal générique.
const STORE_ALLOWED_KEYS = new Set(['game.installPath', 'game.installVerified'])

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

ipcMain.handle('auth:login', async (_e, { username, password }) => {
  try {
    const { data } = await api.post('/auth/login', { username, password })
    store.set('auth.token', data.token)
    store.set('auth.user', data.user)
    // Gardé en RAM pour l'auto-login dans le jeu au clic JOUER (jamais écrit sur disque)
    sessionCredentials = { username, password }
    return { ok: true, user: data.user }
  } catch (err) {
    const message = err.response?.data?.error || 'Connexion impossible au serveur'
    return { ok: false, error: message, code: err.response?.data?.code }
  }
})

ipcMain.handle('auth:logout', () => {
  store.delete('auth.token')
  store.delete('auth.user')
  sessionCredentials = null
  return { ok: true }
})

ipcMain.handle('auth:me', async () => {
  const token = store.get('auth.token')
  const cachedUser = store.get('auth.user')
  if (!token) return { ok: false }
  try {
    const { data } = await api.get('/auth/me')
    store.set('auth.user', data)
    return { ok: true, user: data }
  } catch (err) {
    if (err.response?.status === 401) {
      store.delete('auth.token')
      store.delete('auth.user')
      return { ok: false }
    }
    if (cachedUser) return { ok: true, user: cachedUser, offline: true }
    return { ok: false }
  }
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
      event.sender.send('game:sync-progress', progress)
    })
    // Le check complet a réussi : on peut sauter ce check aux prochains lancements
    store.set('game.installVerified', true)
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    syncInProgress = false
  }
})

// ── IPC : lancement du jeu + auto-login simulé ──
let playInProgress = false

ipcMain.handle('game:play', async (event) => {
  if (playInProgress) return { ok: false, error: 'Lancement déjà en cours' }

  const installPath = store.get('game.installPath')
  if (!installPath) return { ok: false, error: "Dossier d'installation non défini" }

  if (!sessionCredentials) {
    // Cas : launcher redémarré et reconnecté via token caché (auth:me) sans
    // ressaisie du mot de passe — on ne peut pas auto-login dans le jeu.
    return {
      ok: false,
      error: 'Reconnexion requise pour activer la connexion automatique au jeu',
      code: 'NEEDS_RELOGIN'
    }
  }

  playInProgress = true
  try {
    await launchAndLogin(
      installPath,
      sessionCredentials.username,
      sessionCredentials.password,
      (status) => event.sender.send('game:play-status', status)
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    playInProgress = false
  }
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
