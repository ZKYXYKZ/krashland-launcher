#!/usr/bin/env node
/**
 * Génère le manifest.json du client WoW pour le launcher Krashland.
 *
 * Usage :
 *   node tools/generate-manifest.js <dossier_client> [version] [--out=manifest.json]
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
    console.error('Usage: node generate-manifest.js <dossier_client> [version] [--out=manifest.json]')
    process.exit(1)
  }
  const clientDir = path.resolve(args[0])
  let version = '1.0.0'
  let out = 'manifest.json'
  for (const a of args.slice(1)) {
    if (a.startsWith('--out=')) out = a.slice('--out='.length)
    else if (!a.startsWith('--')) version = a
  }
  return { clientDir, version, out }
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function walk(dir, baseDir, acc) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(baseDir, full).split(path.sep).join('/')

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name.toLowerCase())) continue
      walk(full, baseDir, acc)
    } else if (entry.isFile()) {
      if (EXCLUDED_FILES.has(entry.name.toLowerCase())) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (EXCLUDED_EXT.has(ext)) continue

      const stat = fs.statSync(full)
      acc.push({
        path: rel,
        size: stat.size,
        sha256: sha256File(full),
        mtime: Math.floor(stat.mtimeMs / 1000)
      })
    }
  }
}

function main() {
  const { clientDir, version, out } = parseArgs()

  if (!fs.existsSync(clientDir)) {
    console.error(`Dossier introuvable : ${clientDir}`)
    process.exit(1)
  }

  console.log(`Scan de ${clientDir}...`)
  const files = []
  walk(clientDir, clientDir, files)
  console.log(`${files.length} fichiers trouvés. Calcul des hash (peut prendre plusieurs minutes pour un gros client)...`)

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    files
  }

  fs.writeFileSync(out, JSON.stringify(manifest, null, 2))

  const sizeMB = (manifest.totalSize / 1024 / 1024).toFixed(1)
  console.log(`Manifest généré : ${out}`)
  console.log(`  ${files.length} fichiers, ${sizeMB} Mo, version ${version}`)
  console.log(`\nN'oublie pas d'uploader ${out} ET les fichiers du client sur ton CDN`)
  console.log(`à l'URL configurée dans launcher/src/main/config.js (MANIFEST_URL).`)
}

main()
