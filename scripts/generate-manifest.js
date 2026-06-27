/**
 * Génère un manifest.json à partir d'un dossier client WoW existant.
 * Usage : node scripts/generate-manifest.js "C:\chemin\vers\WoWLocal" [version]
 *
 * Parcourt récursivement le dossier, calcule taille + sha256 de chaque fichier,
 * et écrit manifest.json dans le dossier courant (à servir ensuite via http-server).
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const sourceDir = process.argv[2]
const version = process.argv[3] || '1.0.0-local'

if (!sourceDir) {
  console.error('Usage: node generate-manifest.js <dossier-client-wow> [version]')
  process.exit(1)
}

if (!fs.existsSync(sourceDir)) {
  console.error(`Dossier introuvable : ${sourceDir}`)
  process.exit(1)
}

// Extensions/dossiers à ignorer (logs, cache, configs locales qui n'ont pas à être synchronisés)
const IGNORE_NAMES = new Set(['Cache', 'Errors', 'Logs', 'WTF', 'Screenshots', '.git'])
const IGNORE_EXT = new Set(['.log', '.wtf'])

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function walk(dir, baseDir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_NAMES.has(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, baseDir, files)
    } else {
      const ext = path.extname(entry.name).toLowerCase()
      if (IGNORE_EXT.has(ext)) continue
      files.push(fullPath)
    }
  }
  return files
}

async function main() {
  console.log(`Scan de ${sourceDir} ...`)
  const allFiles = walk(sourceDir, sourceDir)
  console.log(`${allFiles.length} fichiers trouvés. Calcul des hash (peut prendre quelques minutes pour un gros client)...`)

  const manifestFiles = []
  let done = 0
  for (const fullPath of allFiles) {
    const relPath = path.relative(sourceDir, fullPath).split(path.sep).join('/')
    const stat = fs.statSync(fullPath)
    const sha256 = await sha256File(fullPath)
    const mtime = Math.floor(stat.mtimeMs / 1000)
    manifestFiles.push({ path: relPath, size: stat.size, sha256, mtime })
    done++
    if (done % 20 === 0 || done === allFiles.length) {
      console.log(`  ${done}/${allFiles.length}`)
    }
  }

  const manifest = { version, files: manifestFiles }
  fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2))
  console.log(`\nmanifest.json généré (${manifestFiles.length} fichiers, version ${version})`)
}

main().catch((err) => {
  console.error('Erreur :', err.message)
  process.exit(1)
})
