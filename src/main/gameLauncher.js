import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'

/**
 * Lance le client WoW (Wow.exe / wow sur mac/linux via wine, selon install du joueur)
 * puis simule la connexion automatique : attend que la fenêtre du jeu soit active,
 * saisit identifiant + mot de passe au champ de login, puis valide avec ENTER.
 *
 * Dépendances chargées en lazy import dynamique : sur Mac/Linux sans wine configuré,
 * ou si l'utilisateur n'a pas encore le client installé, on ne veut pas planter
 * le launcher juste parce que les libs natives ne sont pas dispo pour cette plateforme.
 */

const GAME_WINDOW_TITLE_HINTS = ['World of Warcraft', 'WoW']
const WINDOW_WAIT_TIMEOUT_MS = 30000
const WINDOW_POLL_INTERVAL_MS = 400
// Laisse le temps à l'écran de login de finir de s'afficher après détection de la fenêtre
// (le process existe avant que l'UI ne soit prête à recevoir des clics/saisies — 1.2s
// était trop court, les premières frappes du nom de compte étaient perdues)
const POST_DETECT_SETTLE_MS = 3000

function resolveExecutable(installPath) {
  if (process.platform === 'win32') {
    return path.join(installPath, 'Wow.exe')
  }
  // Sur mac/linux, le client tourne généralement via un wrapper Wine fourni par le joueur.
  // On laisse la résolution à une éventuelle config future ; pour l'instant on tente Wow.exe
  // tel quel (l'utilisateur peut avoir un script `wow` dans son dossier d'install).
  return path.join(installPath, 'Wow.exe')
}

function launchProcess(installPath) {
  const exePath = resolveExecutable(installPath)

  // Vérification immédiate plutôt que de laisser échouer spawn silencieusement
  // (sans ça, on attendrait 30s pour un timeout "fenêtre non détectée" trompeur).
  if (!fs.existsSync(exePath)) {
    throw new Error(`Exécutable du jeu introuvable : ${exePath}`)
  }

  const child = spawn(exePath, [], {
    cwd: installPath,
    detached: true,
    stdio: 'ignore'
  })

  // spawn() est asynchrone : une erreur (ex: ENOENT, permission refusée) arrive
  // via l'event 'error', pas via une exception synchrone. Sans ce listener,
  // l'erreur serait perdue silencieusement (ou pourrait crasher le process main).
  child.on('error', (err) => {
    console.error('[gameLauncher] Erreur de lancement du processus jeu :', err.message)
  })

  child.unref()
  return child
}

/**
 * Attend que la fenêtre du jeu apparaisse et devienne active, en sondant
 * périodiquement via active-win. Résout dès qu'une fenêtre correspondante
 * est détectée ; rejette si le délai max est dépassé.
 */
async function waitForGameWindow(timeoutMs = WINDOW_WAIT_TIMEOUT_MS) {
  const { default: activeWin } = await import('active-win')
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    let win
    try {
      win = await activeWin()
    } catch {
      win = null
    }
    const title = win?.title || ''
    if (GAME_WINDOW_TITLE_HINTS.some((hint) => title.includes(hint))) {
      return win
    }
    await sleep(WINDOW_POLL_INTERVAL_MS)
  }
  throw new Error('La fenêtre du jeu n\'a pas été détectée à temps (le client a-t-il bien démarré ?)')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Simule la saisie des identifiants sur l'écran de login WoW puis valide avec ENTER.
 * Utilise nut-js (cross-platform : Win/Mac/Linux), chargé en lazy import car c'est
 * un module natif qui peut ne pas être présent sur toutes les plateformes de build.
 */
async function autoTypeCredentials(username, password) {
  const { keyboard, Key } = await import('@nut-tree-fork/nut-js')
  keyboard.config.autoDelayMs = 35 // saisie volontairement non instantanée (évite les ratés de focus)

  await keyboard.type(username)
  await keyboard.pressKey(Key.Tab)
  await keyboard.releaseKey(Key.Tab)
  await sleep(150)
  await keyboard.type(password)
  await sleep(150)
  await keyboard.pressKey(Key.Enter)
  await keyboard.releaseKey(Key.Enter)
}

/**
 * Point d'entrée : lance le client, attend la fenêtre de login, saisit les identifiants.
 * onStatus(status) reçoit des mises à jour textuelles pour affichage dans l'UI.
 */
export async function launchAndLogin(installPath, username, password, onStatus) {
  onStatus?.('launching')
  launchProcess(installPath)

  onStatus?.('waiting-window')
  await waitForGameWindow()

  // Laisse l'écran de login finir de se dessiner avant de saisir
  await sleep(POST_DETECT_SETTLE_MS)

  onStatus?.('typing-credentials')
  await autoTypeCredentials(username, password)

  onStatus?.('done')
}
