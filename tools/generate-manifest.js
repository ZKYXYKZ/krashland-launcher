#!/usr/bin/env node
/**
 * Génère le manifest.json du client WoW pour le launcher Krashland.
 *
 * Usage :
 *   node tools/generate-manifest.js <dossier_client> [version] [--out=manifest.json] [--full] [--prev=ancien-manifest.json]
 *
 * Exemple :
 *   node tools/generate-manifest.js "D:\Krashland-Client" 1.0.3
 *
 * Le manifest produit liste tous les fichiers du dossier (récursif), avec leur
 * taille, un hash SHA-256 et leur mtime (date de modification, en secondes).
 * Le launcher (voir launcher/src/main/gameManager.js, fonction diffManifest)
 * compare ce manifest à l'état local : si taille + mtime correspondent déjà,
 * il fait confiance sans relire/rehasher le fichier (gain de temps important
 * sur un gros client). Le sha256 reste la source de vérité en cas de doute.
 *
 * CACHE INCRÉMENTAL : par défaut, le script charge l'ancien manifest (celui à
 * l'emplacement --out, ou --prev=... si fourni) et, pour chaque fichier dont
 * taille + mtime n'ont PAS changé depuis, réutilise le sha256 déjà calculé au
 * lieu de relire tout le fichier. Sur un serveur WoW privé, seuls quelques
 * Data/*.MPQ changent généralement d'une version à l'autre — tout le reste
 * (Wow.exe, fichiers inchangés) est donc traité quasi instantanément, sans
 * pour autant exclure aucun dossier du scan (la détection reste complète :
 * un Wow.exe altéré serait quand même re-hashé puisque son mtime aurait changé).
 * Utilise --full pour ignorer le cache et tout rehasher (ex: après un doute
 * sur l'intégrité, ou changement d'algorithme).
 *
 * Le hash est calculé en flux (streaming) plutôt que via readFileSync, pour
 * supporter les fichiers de client WoW qui dépassent largement 2 Go (limite
 * dure de readFileSync côté Node) sans jamais charger un fichier entier en RAM.
 *
 * Fichiers/dossiers exclus par défaut : Cache, Errors, Logs, WTF, Screenshots
 * (configs perso, logs, captures — propres à chaque joueur, ne doivent jamais
 * être écrasés par un update), ainsi que realmlist.wtf et config.wtf.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const EXCLUDED_DIRS = new Set(['cache', 'errors', 'logs', 'wtf', 'screenshots', '.git'])
const EXCLUDED_FILES = new Set(['realmlist.wtf', 'config.wtf'])
const EXCLUDED_EXT = new Set(['.log'])

function parseArgs() {
  const args = process.argv.slice(2)
  if (!args.length) {
    console.error('Usage: node generate-manifest.js <dossier_client> [version] [--out=manifest.json] [--full] [--prev=ancien-manifest.json]')
    process.exit(1)
  }
  const clientDir = path.resolve(args[0])
  let version = '1.0.0'
  let out = 'manifest.json'
  let full = false
  let prev = null
  for (const a of args.slice(1)) {
    if (a.startsWith('--out=')) out = a.slice('--out='.length)
    else if (a.startsWith('--prev=')) prev = a.slice('--prev='.length)
    else if (a === '--full') full = true
    else if (!a.startsWith('--')) version = a
  }
  return { clientDir, version, out, full, prev: prev || out }
}

// Hash en streaming : ne charge jamais le fichier entier en mémoire, donc pas
// de limite de taille (contrairement à readFileSync, plafonné à 2 GiB).
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function collectFiles(dir, baseDir, acc = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(baseDir, full).split(path.sep).join('/')

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name.toLowerCase())) continue
      collectFiles(full, baseDir, acc)
    } else if (entry.isFile()) {
      if (EXCLUDED_FILES.has(entry.name.toLowerCase())) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (EXCLUDED_EXT.has(ext)) continue
      acc.push(full)
    }
  }
  return acc
}

// Charge l'ancien manifest (s'il existe) et l'indexe par chemin relatif, pour
// retrouver rapidement le sha256 déjà connu d'un fichier inchangé.
function loadPreviousIndex(prevPath) {
  if (!fs.existsSync(prevPath)) return new Map()
  try {
    const data = JSON.parse(fs.readFileSync(prevPath, 'utf8'))
    const index = new Map()
    for (const f of data.files || []) index.set(f.path, f)
    return index
  } catch {
    return new Map()
  }
}

async function buildManifestEntries(clientDir, allFiles, prevIndex, useCache) {
  const files = []
  let done = 0
  let reused = 0

  for (const fullPath of allFiles) {
    const rel = path.relative(clientDir, fullPath).split(path.sep).join('/')
    const stat = fs.statSync(fullPath)
    const mtime = Math.floor(stat.mtimeMs / 1000)

    const cached = useCache ? prevIndex.get(rel) : null
    let sha256
    if (cached && cached.size === stat.size && cached.mtime === mtime && cached.sha256) {
      sha256 = cached.sha256
      reused++
    } else {
      sha256 = await sha256File(fullPath)
    }

    files.push({ path: rel, size: stat.size, sha256, mtime })

    done++
    if (done % 10 === 0 || done === allFiles.length) {
      console.log(`  ${done}/${allFiles.length} (hash recalculés : ${done - reused})`)
    }
  }

  return { files, reused }
}

async function main() {
  const { clientDir, version, out, full, prev } = parseArgs()

  if (!fs.existsSync(clientDir)) {
    console.error(`Dossier introuvable : ${clientDir}`)
    process.exit(1)
  }

  console.log(`Scan de ${clientDir}...`)
  const allFiles = collectFiles(clientDir, clientDir)

  const prevIndex = full ? new Map() : loadPreviousIndex(prev)
  if (!full && prevIndex.size) {
    console.log(`Cache trouvé (${prev}, ${prevIndex.size} fichiers) — réutilisation des hash inchangés (taille + mtime identiques).`)
  } else if (full) {
    console.log(`--full : cache ignoré, tous les fichiers seront rehashés.`)
  }

  console.log(`${allFiles.length} fichiers trouvés. Calcul des hash...`)
  const { files, reused } = await buildManifestEntries(clientDir, allFiles, prevIndex, !full)

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    files
  }

  fs.writeFileSync(out, JSON.stringify(manifest, null, 2))

  const sizeMB = (manifest.totalSize / 1024 / 1024).toFixed(1)
  console.log(`\nManifest généré : ${out}`)
  console.log(`  ${files.length} fichiers, ${sizeMB} Mo, version ${version}`)
  console.log(`  Hash réutilisés depuis le cache : ${reused}/${files.length}`)
  console.log(`\nN'oublie pas d'uploader ${out} ET les fichiers du client sur ton serveur`)
  console.log(`à l'URL configurée dans launcher/src/main/config.js (MANIFEST_URL).`)
}

main().catch((err) => {
  console.error('Erreur :', err.message)
  process.exit(1)
})
