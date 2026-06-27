import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'

/**
 * Lance le client WoW (Wow.exe). Le joueur saisit ses identifiants directement
 * dans l'écran de connexion du client, comme sur un serveur privé classique —
 * le launcher ne gère plus aucune notion de compte ni de saisie automatique.
 */

function resolveExecutable(installPath) {
  if (process.platform === 'win32') {
    return path.join(installPath, 'Wow.exe')
  }
  // Sur mac/linux, le client tourne généralement via un wrapper Wine fourni par le joueur.
  return path.join(installPath, 'Wow.exe')
}

export function launchGame(installPath) {
  const exePath = resolveExecutable(installPath)

  // Vérification immédiate plutôt que de laisser échouer spawn silencieusement.
  if (!fs.existsSync(exePath)) {
    throw new Error(`Exécutable du jeu introuvable : ${exePath}`)
  }

  const child = spawn(exePath, [], {
    cwd: installPath,
    detached: true,
    stdio: 'ignore'
  })

  // spawn() est asynchrone : une erreur (ex: ENOENT, permission refusée) arrive
  // via l'event 'error', pas via une exception synchrone.
  child.on('error', (err) => {
    console.error('[gameLauncher] Erreur de lancement du processus jeu :', err.message)
  })

  child.unref()
  return child
}
