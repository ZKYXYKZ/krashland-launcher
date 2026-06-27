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
 * Compare le manifest distant à l'installation locale.
 * Retourne la liste des fichiers à télécharger (absents ou hash différent)
 * et la taille totale à télécharger.
 *
 * Optimisation : si taille ET date de modification (mtime) du fichier local
 * correspondent à celles du manifest, on considère le fichier intact sans le
 * relire entièrement (évite de re-hasher tous les fichiers à chaque lancement,
 * ce qui peut prendre plusieurs minutes sur un gros client). Le sha256 n'est
 * calculé que si mtime/taille diffèrent, ou si le manifest ne fournit pas de
 * mtime (rétrocompatibilité avec un ancien manifest).
 */
export async function diffManifest(installPath, manifest, onProgress) {
  const toDownload = []
  let checked = 0

  for (const file of manifest.files) {
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

    if (needsDownload) toDownload.push(file)

    checked++
    if (onProgress) onProgress({ phase: 'checking', checked, total: manifest.files.length })
  }

  return {
    toDownload,
    totalBytes: toDownload.reduce((sum, f) => sum + f.size, 0)
  }
}

function downloadFile(url, destPath, onChunk) {
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

/**
 * Télécharge tous les fichiers manquants/modifiés, avec callback de progression
 * (bytes téléchargés / total) pour alimenter la barre de progression UI.
 */
async function downloadFiles(installPath, files, manifestBaseUrl, totalBytes, onProgress) {
  let downloadedBytes = 0

  for (const file of files) {
    const url = getUrlForFile(manifestBaseUrl, file.path)
    const dest = path.join(installPath, file.path)

    await downloadFile(url, dest, (chunkLen) => {
      downloadedBytes += chunkLen
      onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes, currentFile: file.path })
    })
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
    onProgress?.({ phase: 'downloading', downloadedBytes: 0, totalBytes })
    await downloadFiles(installPath, toDownload, MANIFEST_URL, totalBytes, onProgress)
  }

  ensureRealmlist(installPath)

  onProgress?.({ phase: 'ready' })
  return { updated: toDownload.length, version: manifest.version }
}
