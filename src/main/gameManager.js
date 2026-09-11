import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import https from 'https'
import http from 'http'
import { exec as execCb, spawn } from 'child_process'
import axios from 'axios'
import config from './config.js'

const { MANIFEST_URL, MANIFEST_FALLBACK_URL, REALMLIST, REALMLIST_LOCALE, CONFIRM_THRESHOLD_BYTES } = config

/**
 * Gère la vérification et le téléchargement des fichiers du client WoW.
 * Le manifest distant liste tous les fichiers attendus (chemin, taille, sha256).
 * On compare à l'état local et on télécharge uniquement ce qui manque ou diffère.
 */

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

// Fichiers qui ne doivent JAMAIS être synchronisés depuis le manifest, même si
// le générateur les a laissés passer :
//  - manifest.json : auto-référence, son hash est forcément périmé au moment où
//    le manifest est écrit → mismatch sha256 systématique → sync en échec.
//  - l'exe du launcher : verrouillé par Windows s'il tourne depuis le dossier
//    d'install → EPERM à la copie.
const NEVER_SYNCED = new Set(['manifest.json', 'krashlauncher.exe', 'krashland-launcher.exe'])

function isNeverSynced(relPath) {
  return NEVER_SYNCED.has(relPath.toLowerCase())
}

function getUrlForFile(manifestBaseUrl, relPath) {
  // Le manifest et les fichiers du client sont servis depuis le même dossier CDN
  const base = manifestBaseUrl.slice(0, manifestBaseUrl.lastIndexOf('/') + 1)
  return base + relPath.split('/').map(encodeURIComponent).join('/')
}

function sanitizeManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) return manifest
  const files = manifest.files.filter((f) => {
    if (!isNeverSynced(f.path)) return true
    console.warn(`[sync] entrée ignorée (non synchronisable) : ${f.path}`)
    return false
  })
  if (files.length === manifest.files.length) return manifest
  return { ...manifest, files, fileCount: files.length }
}

export async function fetchManifest() {
  try {
    const { data } = await axios.get(MANIFEST_URL, { timeout: 15000 })
    return sanitizeManifest(data)
  } catch (err) {
    if (!MANIFEST_FALLBACK_URL) throw err
    console.warn(`[sync] manifest primaire KO (${err.message}) — tentative sur le serveur de secours`)
    const { data } = await axios.get(MANIFEST_FALLBACK_URL, { timeout: 15000 })
    return sanitizeManifest(data)
  }
}

/**
 * Check léger : récupère uniquement la version du manifest distant, sans rien
 * comparer ni télécharger. Utilisé au démarrage pour savoir si un sync est
 * nécessaire, sans payer le coût d'un diff complet à chaque ouverture.
 */
export async function fetchManifestVersion() {
  const manifest = await fetchManifest()
  return manifest.version
}

// Nombre de fichiers vérifiés (hash) en parallèle. Limité pour ne pas saturer
// un disque mécanique (HDD) — sur un SSD ça pourrait monter plus haut, mais on
// reste prudent pour les configs modestes visées par le serveur.
const DIFF_CONCURRENCY = 5

async function checkSingleFile(installPath, file) {
  const localPath = path.join(installPath, file.path)

  if (!fs.existsSync(localPath)) {
    console.log(`[sync] ABSENT  : ${file.path}`)
    return true
  }

  const stat = fs.statSync(localPath)
  if (stat.size !== file.size) {
    console.log(`[sync] TAILLE  : ${file.path} (local=${stat.size} manifest=${file.size})`)
    return true
  }

  const localMtime = Math.floor(stat.mtimeMs / 1000)
  if (file.mtime && localMtime === file.mtime) {
    // Taille + date identiques : on fait confiance sans relire le fichier
    return false
  }

  // mtime différent ou absent dans le manifest → vérification sha256
  try {
    const localHash = await sha256File(localPath)
    if (localHash !== file.sha256) {
      console.log(`[sync] SHA256  : ${file.path} (mtime local=${localMtime} manifest=${file.mtime})`)
      return true
    }
    return false
  } catch {
    console.log(`[sync] ERREUR  : impossible de lire ${file.path}`)
    return true
  }
}

/**
 * Compare le manifest distant à l'installation locale.
 * Retourne la liste des fichiers à télécharger (absents ou hash différent)
 * et la taille totale à télécharger.
 *
 * Optimisation 1 : si taille ET date de modification (mtime) du fichier local
 * correspondent à celles du manifest, on considère le fichier intact sans le
 * relire entièrement (évite de re-hasher tous les fichiers à chaque lancement,
 * ce qui peut prendre plusieurs minutes sur un gros client). Le sha256 n'est
 * calculé que si mtime/taille diffèrent, ou si le manifest ne fournit pas de
 * mtime (rétrocompatibilité avec un ancien manifest).
 *
 * Optimisation 2 : les fichiers sont vérifiés par lots de DIFF_CONCURRENCY en
 * parallèle plutôt qu'un par un. Avant, un client avec beaucoup de fichiers
 * ratant le fast-path (ex: mtimes non préservés après une copie/transfert)
 * additionnait le temps de lecture de CHAQUE fichier en série — avec des MPQ
 * de plusieurs centaines de Mo, ça pouvait largement dépasser la minute. En
 * parallèle, le temps total se rapproche du fichier le plus lent du lot plutôt
 * que de leur somme.
 */
export async function diffManifest(installPath, manifest, onProgress) {
  const toDownload = []
  let checked = 0
  const startTime = Date.now()

  for (let i = 0; i < manifest.files.length; i += DIFF_CONCURRENCY) {
    const batch = manifest.files.slice(i, i + DIFF_CONCURRENCY)
    const results = await Promise.all(
      batch.map((file) => checkSingleFile(installPath, file))
    )

    results.forEach((needsDownload, idx) => {
      if (needsDownload) toDownload.push(batch[idx])
    })

    checked += batch.length
    const elapsedSec = (Date.now() - startTime) / 1000
    const rate = elapsedSec > 0.5 ? checked / elapsedSec : 0
    const etaSeconds = rate > 0 ? Math.round((manifest.files.length - checked) / rate) : null
    if (onProgress) onProgress({ phase: 'checking', checked, total: manifest.files.length, etaSeconds })
  }

  return {
    toDownload,
    totalBytes: toDownload.reduce((sum, f) => sum + f.size, 0)
  }
}

/**
 * Copie src → dest de façon robuste.
 *
 * - Chemin cloud (OneDrive, Dropbox…) : tue le client sync juste avant l'écriture
 *   (il peut s'être relancé depuis le kill initial en début de sync), attend que les
 *   handles soient libérés, puis essaie copyFile + fallback createWriteStream.
 * - Chemin local normal : unlink + copyFile direct, sans overhead taskkill.
 *   En cas d'EPERM (Defender scan court), retry avec backoff.
 *
 * La détection du chemin cloud est faite sur `dest` lui-même pour éviter de passer
 * le flag à travers toute la chaîne downloadFile → downloadFileOnce → safeCopyFile.
 */
async function safeCopyFile(src, dest) {
  const inCloud = isCloudSyncedPath(dest)
  const MAX = 3

  for (let attempt = 1; attempt <= MAX; attempt++) {
    if (inCloud) {
      // OneDrive peut s'être relancé pendant le téléchargement du fichier — on le
      // tue à nouveau juste avant l'écriture pour être sûr que ses handles sont libres.
      await new Promise(r => execCb('taskkill /f /im OneDrive.exe 2>nul', () => r()))
      await new Promise(r => setTimeout(r, 400))
    }

    // Supprimer l'ancienne version pour libérer un lock de lecture résiduel
    try { await fs.promises.unlink(dest) } catch {}

    try {
      await fs.promises.copyFile(src, dest)
      return
    } catch (err) {
      const retryable = err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY'
      if (!retryable) throw err

      if (inCloud) {
        // Fallback stream : libuv ouvre avec FILE_SHARE_READ|WRITE|DELETE (plus permissif
        // que CopyFileEx qui n'autorise que FILE_SHARE_READ sur la destination).
        try {
          await new Promise((res, rej) => {
            const rs = fs.createReadStream(src)
            const ws = fs.createWriteStream(dest, { flags: 'w' })
            rs.on('error', rej)
            ws.on('error', rej)
            ws.on('finish', res)
            rs.pipe(ws)
          })
          return
        } catch (streamErr) {
          if (attempt === MAX) throw streamErr
        }
      } else if (attempt === MAX) {
        throw err
      }

      await new Promise(r => setTimeout(r, 500 * attempt))
    }
  }
}

// Délai sans données avant d'aborter la connexion. 60s pour les gros fichiers MPQ
// sur des connexions lentes — 30s était trop agressif et causait des faux timeouts
// qui faisaient chuter la progression à 0% par soustraction des bytes du retry.
const STALL_TIMEOUT_MS = 60000

/**
 * Emplacement du fichier temporaire d'un téléchargement. Le nom est dérivé du
 * sha256 attendu (ou de l'URL), donc stable d'une tentative à l'autre et d'un
 * lancement du launcher à l'autre : c'est ce qui permet la reprise. Un fichier
 * dont le contenu change côté serveur obtient un nom différent, donc aucun
 * risque de reprendre sur un .part périmé.
 *
 * Le tmp vit dans os.tmpdir() et non à côté de la destination : OneDrive (ou un
 * autre client de sync cloud) verrouillait le .part pendant le téléchargement,
 * ce qui provoquait un EPERM au moment de le déplacer.
 */
function tmpPathFor(url, expectedHash) {
  const key = expectedHash || crypto.createHash('sha256').update(url).digest('hex')
  return path.join(os.tmpdir(), `krash-${key.slice(0, 32)}.part`)
}

function sizeOf(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

/**
 * Télécharge une fois, en reprenant le .part existant s'il y en a un.
 *
 * onBytes(total) reçoit le nombre d'octets présents sur le disque pour CE fichier
 * (reprise comprise), pas un delta : la progression reste juste même quand une
 * tentative échoue et repart, sans avoir à soustraire quoi que ce soit.
 */
function downloadFileOnce(url, destPath, onBytes, onFinalize, expectedHash, expectedSize) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })

    const tmpPath = tmpPathFor(url, expectedHash)
    let startByte = sizeOf(tmpPath)

    // Un .part plus gros que le fichier attendu ne peut venir que d'un reste
    // incohérent : on repart de zéro plutôt que de tenter un Range invalide.
    if (expectedSize && startByte >= expectedSize) {
      try { fs.unlinkSync(tmpPath) } catch {}
      startByte = 0
    }

    let received = startByte
    let fileStream = null
    const client = url.startsWith('https') ? https : http

    let done = false
    let stallTimer = null

    // failed() garde le .part sur le disque : c'est lui qui sera repris à la
    // tentative suivante. Seules les erreurs d'intégrité le suppriment.
    function failed(err) {
      if (done) return
      done = true
      if (stallTimer) clearTimeout(stallTimer)
      fileStream?.destroy()
      reject(err)
    }

    function discardAndFail(err) {
      if (done) return
      done = true
      if (stallTimer) clearTimeout(stallTimer)
      fileStream?.destroy()
      fs.unlink(tmpPath, () => {})
      reject(err)
    }

    function resetStall() {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        req.destroy(new Error(`Timeout : aucune donnée reçue depuis ${STALL_TIMEOUT_MS / 1000}s`))
      }, STALL_TIMEOUT_MS)
    }

    const headers = startByte > 0 ? { Range: `bytes=${startByte}-` } : {}
    const req = client.get(url, { headers }, (res) => {
      // 206 : le serveur honore la reprise, on complète le .part existant.
      // 200 avec une requête Range : il l'ignore et renvoie tout depuis le début,
      // on repart donc de zéro en écrasant le .part.
      const resuming = res.statusCode === 206
      const restarting = res.statusCode === 200

      if (!resuming && !restarting) {
        res.resume() // vide le corps, sinon le socket reste ouvert
        // 416 : le serveur juge la plage invalide (fichier raccourci côté serveur).
        // On jette le .part pour que la tentative suivante reparte proprement.
        if (res.statusCode === 416) {
          return discardAndFail(new Error(`Plage invalide pour ${path.basename(destPath)}, reprise abandonnée`))
        }
        return failed(new Error(`HTTP ${res.statusCode} pour ${url}`))
      }

      if (restarting && startByte > 0) {
        console.log(`[sync] reprise refusée par le serveur : ${path.basename(destPath)}, redémarrage depuis 0`)
        startByte = 0
        received = 0
      }

      if (resuming) {
        console.log(`[sync] reprise : ${path.basename(destPath)} à ${(startByte / 1048576).toFixed(0)} Mo`)
      }

      fileStream = fs.createWriteStream(tmpPath, { flags: startByte > 0 ? 'a' : 'w' })

      // Sans ce handler, une coupure socket en plein flux (ECONNRESET, serveur qui
      // ferme la connexion) émet un 'error' non géré sur la réponse → exception
      // non capturée dans le main process, donc crash du launcher au lieu d'un
      // simple retry sur le fichier en cours.
      res.on('error', (err) => failed(err))

      // Une erreur d'écriture disque (antivirus, disque plein, fichier verrouillé)
      // laissait sinon la Promise en suspens indéfiniment → blocage sur
      // "Finalisation..." sans jamais résoudre.
      fileStream.on('error', (err) => failed(err))

      resetStall()
      res.on('data', (chunk) => {
        received += chunk.length
        onBytes?.(received)
        resetStall() // réinitialise le timer tant que des données arrivent
      })
      res.pipe(fileStream)

      fileStream.on('finish', () => {
        if (done) return
        done = true
        if (stallTimer) clearTimeout(stallTimer)

        // Le stream se termine aussi quand la connexion est coupée proprement au
        // milieu : sans ce contrôle, on copiait un fichier tronqué avant de s'en
        // apercevoir au sha256, après plusieurs minutes de copie inutile.
        const written = sizeOf(tmpPath)
        if (expectedSize && written < expectedSize) {
          return failed(new Error(
            `Téléchargement incomplet : ${path.basename(destPath)} (${written}/${expectedSize} octets), repris à la prochaine tentative`
          ))
        }

        // close() avec callback : garantit que le handle source est libéré
        // avant qu'on commence à lire le fichier pour le copier.
        fileStream.close(() => {
          // Notifie l'UI que le DL est terminé et qu'on écrit sur le disque.
          // safeCopyFile peut prendre plusieurs secondes sur un gros MPQ.
          onFinalize?.()
          console.log(`[sync] écriture : ${path.basename(destPath)}`)
          safeCopyFile(tmpPath, destPath)
            .then(async () => {
              // Vérification SHA256 post-écriture : détecte les corruptions réseau
              // (bit-flip, téléchargement tronqué) avant que le joueur tente de jouer.
              // En cas de mismatch, on supprime le fichier ET le .part, puis on throw →
              // downloadFile() retentera un téléchargement complet.
              if (expectedHash) {
                try {
                  const writtenHash = await sha256File(destPath)
                  if (writtenHash !== expectedHash) {
                    console.warn(`[sync] SHA256 KO : ${path.basename(destPath)} — corrompu, sera retéléchargé`)
                    try { fs.unlinkSync(destPath) } catch {}
                    fs.unlink(tmpPath, () => {})
                    reject(new Error(`Fichier corrompu : ${path.basename(destPath)} (sha256 mismatch)`))
                    return
                  }
                  console.log(`[sync] SHA256 OK : ${path.basename(destPath)}`)
                } catch (hashErr) {
                  reject(hashErr)
                  return
                }
              }
              fs.unlink(tmpPath, () => {})
              resolve()
            })
            .catch((copyErr) => reject(copyErr))
        })
      })
    })

    req.on('error', (err) => failed(err))
  })
}

const MAX_RETRIES = 5
const RETRY_DELAY_MS = 1500

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Télécharge un fichier avec retry automatique (jusqu'à MAX_RETRIES tentatives).
 * Chaque tentative reprend là où la précédente s'est arrêtée grâce au .part
 * conservé : une coupure à 95% d'un MPQ de 4 Go ne refait plus les 95%. C'est
 * aussi pour ça que MAX_RETRIES peut être plus généreux qu'avant — une tentative
 * ratée ne coûte plus un téléchargement complet.
 *
 * onRetry informe l'UI à chaque nouvelle tentative (ex: "Nouvelle tentative 2/5
 * pour patch-3.MPQ").
 */
async function downloadFile(url, destPath, onBytes, onRetry, fileLabel, onFinalize, expectedHash, expectedSize) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await downloadFileOnce(url, destPath, onBytes, onFinalize, expectedHash, expectedSize)
      return
    } catch (err) {
      lastErr = err
      console.warn(`[sync] échec ${attempt}/${MAX_RETRIES} sur ${fileLabel} : ${err.message}`)
      // La progression repart de ce qui est réellement sur le disque, pas de zéro.
      onBytes?.(sizeOf(tmpPathFor(url, expectedHash)))
      if (attempt < MAX_RETRIES) {
        onRetry?.({ file: fileLabel, attempt: attempt + 1, maxAttempts: MAX_RETRIES, error: err.message })
        await wait(RETRY_DELAY_MS * attempt)
      }
    }
  }
  throw lastErr
}

/**
 * Vérifie qu'il reste assez d'espace disque libre sur le volume d'installPath
 * avant de démarrer un téléchargement potentiellement volumineux. Ajoute une
 * marge de 5% (ou 100 Mo minimum) pour couvrir l'overhead des fichiers temporaires
 * .part et les imprécisions d'estimation.
 */
async function checkDiskSpace(installPath, requiredBytes) {
  if (!requiredBytes) return { ok: true }
  fs.mkdirSync(installPath, { recursive: true })
  let free
  try {
    const stat = await fs.promises.statfs(installPath)
    free = stat.bavail * stat.bsize
  } catch {
    // statfs indisponible (vieille version de Node ou plateforme non supportée) :
    // on ne bloque pas le téléchargement, on ne peut juste pas vérifier en amont.
    return { ok: true, unknown: true }
  }

  const margin = Math.max(requiredBytes * 0.05, 100 * 1024 * 1024)
  const required = requiredBytes + margin

  if (free < required) {
    return { ok: false, free, required }
  }
  return { ok: true, free, required }
}

/**
 * Télécharge tous les fichiers manquants/modifiés, avec callback de progression
 * (bytes téléchargés / total) pour alimenter la barre de progression UI.
 */
async function downloadFiles(installPath, files, manifestBaseUrl, totalBytes, onProgress) {
  // Octets des fichiers déjà terminés. La progression affichée vaut toujours
  // completedBytes + ce qui est sur le disque pour le fichier en cours, donc une
  // tentative ratée puis reprise ne fait ni bondir ni chuter la barre.
  let completedBytes = 0
  let downloadedBytes = 0

  // Estimation de vitesse par fenêtre glissante (5 dernières secondes).
  const SPEED_WINDOW_MS = 5000
  const speedSamples = [] // { time: ms, bytes: number }
  let speedBps = 0

  function recordChunk(bytes) {
    if (bytes <= 0) return
    const now = Date.now()
    speedSamples.push({ time: now, bytes })
    while (speedSamples.length > 0 && now - speedSamples[0].time > SPEED_WINDOW_MS) {
      speedSamples.shift()
    }
    if (speedSamples.length >= 2) {
      const windowMs = now - speedSamples[0].time
      const windowBytes = speedSamples.reduce((s, x) => s + x.bytes, 0)
      speedBps = windowMs > 0 ? (windowBytes / windowMs) * 1000 : 0
    }
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const url = getUrlForFile(manifestBaseUrl, file.path)
    const dest = path.join(installPath, file.path)

    let fileBytes = 0
    const onBytes = (bytesForThisFile) => {
      recordChunk(bytesForThisFile - fileBytes)
      fileBytes = bytesForThisFile
      downloadedBytes = completedBytes + fileBytes
      const remaining = Math.max(0, totalBytes - downloadedBytes)
      const etaSeconds = speedBps > 0 ? Math.round(remaining / speedBps) : null
      onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes, currentFile: file.path, etaSeconds })
    }
    const onRetry = (retryInfo) => {
      onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes, currentFile: file.path, retry: retryInfo })
    }
    const onFinalize = () => {
      onProgress?.({
        phase: 'finalizing',
        currentFile: path.basename(file.path),
        filesDone: i,
        filesTotal: files.length,
        downloadedBytes,
        totalBytes
      })
    }

    try {
      await downloadFile(url, dest, onBytes, onRetry, file.path, onFinalize, file.sha256, file.size)
    } catch (primaryErr) {
      // Serveur principal injoignable après tous les retries → tentative sur le fallback
      if (!MANIFEST_FALLBACK_URL) throw primaryErr
      const fallbackUrl = getUrlForFile(MANIFEST_FALLBACK_URL, file.path)
      console.warn(`[sync] fallback pour ${file.path} : ${primaryErr.message}`)
      onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes, currentFile: file.path, fallback: true })
      await downloadFile(fallbackUrl, dest, onBytes, onRetry, file.path, onFinalize, file.sha256, file.size)
    }

    completedBytes += file.size
    downloadedBytes = completedBytes

    // On aligne la date de modification du fichier écrit sur celle du manifest.
    // Sans ça, le fichier fraîchement téléchargé porte la date de la copie, donc
    // le fast-path taille+mtime de diffManifest ne s'applique jamais : au
    // lancement suivant, le launcher re-hashe intégralement tout ce qu'il vient
    // de télécharger (plusieurs dizaines de Go de MPQ = plusieurs minutes).
    if (file.mtime) {
      try { fs.utimesSync(dest, file.mtime, file.mtime) } catch {}
    }
  }
}

/**
 * Retourne la liste des fichiers qui étaient dans le manifest précédent mais
 * qui ne sont plus dans le manifest actuel. Ce sont des candidats à la suppression
 * (patches retirés côté serveur), mais on ne supprime RIEN automatiquement —
 * c'est le joueur qui confirme via le bouton "Nettoyer" dans Options.
 *
 * On utilise uniquement prevManifestFiles (fichiers que le launcher a lui-même
 * posés) pour ne jamais proposer de supprimer les patches HD ou addons custom
 * ajoutés manuellement par le joueur.
 */
export function findObsoleteFiles(installPath, prevManifestFiles, currentManifest) {
  if (!prevManifestFiles || !prevManifestFiles.length) return []
  const currentSet = new Set(currentManifest.files.map(f => f.path))
  return prevManifestFiles.filter(rel => {
    if (currentSet.has(rel)) return false
    if (isNeverSynced(rel)) return false
    return fs.existsSync(path.join(installPath, rel))
  })
}

/**
 * Supprime les fichiers passés en paramètre (liste explicitement confirmée par
 * le joueur via l'UI). Appelé uniquement après confirmation dans Options.
 */
export function deleteObsoleteFiles(installPath, files) {
  const removed = []
  for (const rel of files) {
    const full = path.join(installPath, rel)
    try {
      fs.unlinkSync(full)
      removed.push(rel)
      console.log(`[cleanup] supprimé : ${rel}`)
    } catch (err) {
      console.warn(`[cleanup] impossible de supprimer ${rel} : ${err.message}`)
    }
  }
  return removed
}

function ensureRealmlist(installPath) {
  // Le seul realmlist.wtf réellement lu par le client 3.3.5 est celui dans
  // Data/<locale>/ — celui qu'on écrivait par erreur à la racine du dossier
  // d'install n'a jamais été pris en compte par le jeu, et est supprimé ici
  // chez les joueurs qui l'ont déjà (inutile, ne sert à rien).
  const legacyRootPath = path.join(installPath, 'realmlist.wtf')
  if (fs.existsSync(legacyRootPath)) {
    try {
      fs.unlinkSync(legacyRootPath)
    } catch {
      // Pas bloquant si la suppression échoue (ex: fichier verrouillé) —
      // il reste juste un fichier orphelin inoffensif.
    }
  }

  const realmlistPath = path.join(installPath, 'Data', REALMLIST_LOCALE, 'realmlist.wtf')
  // On n'écrase jamais ce fichier s'il existe déjà (au cas où le joueur l'a custom)
  if (!fs.existsSync(realmlistPath)) {
    fs.mkdirSync(path.dirname(realmlistPath), { recursive: true })
    fs.writeFileSync(realmlistPath, REALMLIST + '\r\n')
  }
}

/**
 * Détecte si un chemin est dans un dossier synchronisé par un client cloud.
 * OneDrive & co tiennent un lock FILE_SHARE_READ sans FILE_SHARE_DELETE sur les
 * fichiers en cours d'upload → fs.copyFile ET fs.unlink échouent avec EPERM.
 * Les gros fichiers MPQ peuvent rester lockés plusieurs minutes : aucun retry
 * ne suffit. La solution : suspendre le client cloud le temps du téléchargement.
 */
function isCloudSyncedPath(p) {
  const n = p.toLowerCase().replace(/\\/g, '/')
  return (
    n.includes('/onedrive/') ||
    n.includes('/onedrive - ') || // OneDrive pro "OneDrive - Entreprise"
    n.includes('/dropbox/') ||
    n.includes('/google drive/') ||
    n.includes('/icloud drive/')
  )
}

/**
 * Tue le process OneDrive pour libérer tous ses locks fichiers avant le DL.
 * C'est l'approche utilisée par Steam et Epic Games : on suspend le client cloud
 * le temps de l'installation, puis on le relance via resumeCloudSync().
 * On ignore les erreurs (OneDrive peut ne pas être lancé).
 */
async function suspendCloudSync() {
  return new Promise((resolve) => {
    execCb('taskkill /f /im OneDrive.exe', () => resolve())
  })
}

/**
 * Relance OneDrive après l'installation. On cherche l'exe dans les emplacements
 * standards Windows ; si on ne trouve pas, on laisse l'utilisateur le relancer
 * manuellement (il réapparaît au prochain redémarrage de toute façon).
 */
function resumeCloudSync() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'OneDrive', 'OneDrive.exe'),
    'C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe',
  ].filter(Boolean)

  for (const exe of candidates) {
    try {
      if (fs.existsSync(exe)) {
        const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
        child.unref()
        return
      }
    } catch {}
  }
}

/**
 * Point d'entrée principal : vérifie + télécharge si besoin.
 * onProgress(payload) est appelé régulièrement pour mettre à jour l'UI.
 * confirmDownload({ totalBytes, fileCount }) doit résoudre true/false ; s'il
 * n'est pas fourni, le téléchargement démarre sans demander.
 */
export async function syncGame(installPath, onProgress, confirmDownload) {
  onProgress?.({ phase: 'fetching-manifest' })
  const manifest = await fetchManifest()

  onProgress?.({ phase: 'checking', checked: 0, total: manifest.files.length })
  const { toDownload, totalBytes } = await diffManifest(installPath, manifest, onProgress)

  if (toDownload.length) {
    // Au-delà du seuil, on demande l'accord du joueur avant de lancer le
    // téléchargement : partir sur 20 Go sans prévenir, alors qu'il voulait juste
    // jouer, n'est pas acceptable. En dessous (petit patch), on ne l'embête pas.
    if (confirmDownload && totalBytes >= CONFIRM_THRESHOLD_BYTES) {
      const accepted = await confirmDownload({ totalBytes, fileCount: toDownload.length })
      if (!accepted) {
        console.log(`[sync] téléchargement refusé par le joueur (${toDownload.length} fichiers, ${totalBytes} octets)`)
        onProgress?.({ phase: 'cancelled', totalBytes, fileCount: toDownload.length })
        return { cancelled: true, updated: 0, version: manifest.version, totalBytes, fileCount: toDownload.length }
      }
    }

    const space = await checkDiskSpace(installPath, totalBytes)
    if (!space.ok) {
      const freeMB = (space.free / 1024 / 1024).toFixed(0)
      const requiredMB = (space.required / 1024 / 1024).toFixed(0)
      throw new Error(
        `Espace disque insuffisant : ${freeMB} Mo disponibles, ${requiredMB} Mo nécessaires. Libère de l'espace puis réessaie.`
      )
    }

    // Si le dossier d'install est dans un cloud sync (OneDrive, Dropbox…), on
    // suspend le client cloud le temps du téléchargement pour libérer ses locks.
    // Même approche que Steam / Epic Games : taskkill + respawn après le sync.
    // Sans ça, fs.copyFile vers un fichier MPQ en cours d'upload → EPERM, car
    // OneDrive tient un lock FILE_SHARE_READ sans FILE_SHARE_DELETE.
    const inCloud = isCloudSyncedPath(installPath)
    if (inCloud) {
      onProgress?.({ phase: 'suspending-cloud-sync' })
      await suspendCloudSync()
      // Courte pause pour laisser le process OneDrive terminer et libérer ses handles
      await new Promise(r => setTimeout(r, 1500))
    }

    onProgress?.({ phase: 'downloading', downloadedBytes: 0, totalBytes })
    try {
      await downloadFiles(installPath, toDownload, MANIFEST_URL, totalBytes, onProgress)
    } finally {
      // On redémarre OneDrive quoi qu'il arrive (succès ou erreur de téléchargement)
      if (inCloud) resumeCloudSync()
    }
  }

  ensureRealmlist(installPath)

  onProgress?.({ phase: 'ready' })
  return { updated: toDownload.length, version: manifest.version, manifestFiles: manifest.files.map(f => f.path) }
}
