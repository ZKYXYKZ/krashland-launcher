import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import https from 'https'
import http from 'http'
import axios from 'axios'
import config from './config.js'

const { MANIFEST_URL, REALMLIST } = config

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

function getUrlForFile(manifestBaseUrl, relPath) {
  // Le manifest et les fichiers du client sont servis depuis le même dossier CDN
  const base = manifestBaseUrl.slice(0, manifestBaseUrl.lastIndexOf('/') + 1)
  return base + relPath.split('/').map(encodeURIComponent).join('/')
}

export async function fetchManifest() {
  const { data } = await axios.get(MANIFEST_URL, { timeout: 15000 })
  return data
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
  let needsDownload = true

  if (fs.existsSync(localPath)) {
    const stat = fs.statSync(localPath)
    if (stat.size === file.size) {
      const localMtime = Math.floor(stat.mtimeMs / 1000)
      if (file.mtime && localMtime === file.mtime) {
        // Taille + date identiques : on fait confiance sans relire le fichier
        needsDownload = false
      } else {
        try {
          const localHash = await sha256File(localPath)
          needsDownload = localHash !== file.sha256
        } catch {
          needsDownload = true
        }
      }
    }
  }

  return needsDownload
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

  for (let i = 0; i < manifest.files.length; i += DIFF_CONCURRENCY) {
    const batch = manifest.files.slice(i, i + DIFF_CONCURRENCY)
    const results = await Promise.all(
      batch.map((file) => checkSingleFile(installPath, file))
    )

    results.forEach((needsDownload, idx) => {
      if (needsDownload) toDownload.push(batch[idx])
    })

    checked += batch.length
    if (onProgress) onProgress({ phase: 'checking', checked, total: manifest.files.length })
  }

  return {
    toDownload,
    totalBytes: toDownload.reduce((sum, f) => sum + f.size, 0)
  }
}

function downloadFileOnce(url, destPath, onChunk) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const tmpPath = destPath + '.part'
    const fileStream = fs.createWriteStream(tmpPath)
    const client = url.startsWith('https') ? https : http

    const req = client.get(url, (res) => {
      if (res.statusCode !== 200) {
        fileStream.close()
        fs.unlink(tmpPath, () => {})
        return reject(new Error(`HTTP ${res.statusCode} pour ${url}`))
      }
      res.on('data', (chunk) => onChunk?.(chunk.length))
      res.pipe(fileStream)
      fileStream.on('finish', () => {
        fileStream.close()
        fs.rename(tmpPath, destPath, (err) => (err ? reject(err) : resolve()))
      })
    })
    req.on('error', (err) => {
      fileStream.close()
      fs.unlink(tmpPath, () => {})
      reject(err)
    })
  })
}

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1500

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Télécharge un fichier avec retry automatique (jusqu'à MAX_RETRIES tentatives).
 * Une coupure réseau ponctuelle ne fait donc plus échouer tout le sync : seul
 * le fichier en cours est retenté, après un court délai. Si onRetry est fourni,
 * il est appelé à chaque nouvelle tentative pour informer l'UI (ex: "Nouvelle
 * tentative 2/3 pour patch-3.MPQ"). Les bytes déjà comptés pour les tentatives
 * ratées sont retirés via onChunk(-bytesDejaComptes) pour ne pas fausser la
 * barre de progression globale.
 */
async function downloadFile(url, destPath, onChunk, onRetry, fileLabel) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let bytesThisAttempt = 0
    try {
      await downloadFileOnce(url, destPath, (len) => {
        bytesThisAttempt += len
        onChunk?.(len)
      })
      return
    } catch (err) {
      lastErr = err
      // On retire de la progression les bytes comptés pour cette tentative ratée
      if (bytesThisAttempt) onChunk?.(-bytesThisAttempt)
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
  let downloadedBytes = 0

  for (const file of files) {
    const url = getUrlForFile(manifestBaseUrl, file.path)
    const dest = path.join(installPath, file.path)

    await downloadFile(
      url,
      dest,
      (chunkLen) => {
        downloadedBytes += chunkLen
        onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes, currentFile: file.path })
      },
      (retryInfo) => {
        onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes, currentFile: file.path, retry: retryInfo })
      },
      file.path
    )
  }
}

function ensureRealmlist(installPath) {
  const realmlistPath = path.join(installPath, 'realmlist.wtf')
  // On n'écrase jamais ce fichier s'il existe déjà (au cas où le joueur l'a custom)
  if (!fs.existsSync(realmlistPath)) {
    fs.mkdirSync(installPath, { recursive: true })
    fs.writeFileSync(realmlistPath, REALMLIST + '\r\n')
  }
}

/**
 * Point d'entrée principal : vérifie + télécharge si besoin.
 * onProgress(payload) est appelé régulièrement pour mettre à jour l'UI.
 */
export async function syncGame(installPath, onProgress) {
  onProgress?.({ phase: 'fetching-manifest' })
  const manifest = await fetchManifest()

  onProgress?.({ phase: 'checking', checked: 0, total: manifest.files.length })
  const { toDownload, totalBytes } = await diffManifest(installPath, manifest, onProgress)

  if (toDownload.length) {
    const space = await checkDiskSpace(installPath, totalBytes)
    if (!space.ok) {
      const freeMB = (space.free / 1024 / 1024).toFixed(0)
      const requiredMB = (space.required / 1024 / 1024).toFixed(0)
      throw new Error(
        `Espace disque insuffisant : ${freeMB} Mo disponibles, ${requiredMB} Mo nécessaires. Libère de l'espace puis réessaie.`
      )
    }

    onProgress?.({ phase: 'downloading', downloadedBytes: 0, totalBytes })
    await downloadFiles(installPath, toDownload, MANIFEST_URL, totalBytes, onProgress)
  }

  ensureRealmlist(installPath)

  onProgress?.({ phase: 'ready' })
  return { updated: toDownload.length, version: manifest.version }
}
