import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import log from 'electron-log/main'

/**
 * Journalisation dans un fichier. Sans ça, tous les console.log du main process
 * partaient dans le vide une fois l'app packagée, et le bouton "Voir les logs"
 * d'Options ouvrait un dossier qui n'existait même pas : aucune trace exploitable
 * quand un joueur signale un problème de synchro.
 *
 * Le fichier est écrit dans app.getPath('logs') — exactement le dossier qu'ouvre
 * ce bouton — et tourne à 5 Mo (l'ancien devient main.old.log).
 */
export function setupLogging() {
  const logDir = app.getPath('logs')
  fs.mkdirSync(logDir, { recursive: true })

  log.transports.file.resolvePathFn = () => path.join(logDir, 'main.log')
  log.transports.file.level = 'info'
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.console.level = app.isPackaged ? false : 'debug'

  // Redirige les console.log/warn/error existants (gameManager, autoUpdate…)
  // vers le fichier, sans avoir à les réécrire un par un.
  Object.assign(console, log.functions)

  // Une exception non capturée dans le main process affiche sinon une boîte
  // Electron brute et illisible pour un joueur. On la trace et on laisse l'app
  // debout : les erreurs qui comptent vraiment remontent déjà via l'UI de sync.
  log.errorHandler.startCatching({ showDialog: false })

  log.initialize()

  log.info(`[launcher] démarrage — version ${app.getVersion()}, logs dans ${logDir}`)
  return log
}

export default log
