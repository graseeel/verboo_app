import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const releaseDir = path.join(repoRoot, 'release')
const metadataPath = path.join(releaseDir, 'latest-mac.yml')
const packageJsonPath = path.join(repoRoot, 'package.json')

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const version = packageJson.version

function fail(message) {
  console.error(`Update release verification failed: ${message}`)
  process.exit(1)
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} does not exist at ${path.relative(repoRoot, filePath)}`)
  }
}

assertFile(metadataPath, 'latest-mac.yml')

const releaseFiles = fs.readdirSync(releaseDir)
const metadata = fs.readFileSync(metadataPath, 'utf8')

if (!metadata.includes(`version: ${version}`)) {
  fail(`latest-mac.yml does not contain version: ${version}`)
}

const dmgFiles = releaseFiles.filter((file) => file.endsWith('.dmg') && file.includes(version))
const zipFiles = releaseFiles.filter((file) => file.endsWith('.zip') && file.includes(version))

if (dmgFiles.length === 0) {
  fail('no DMG artifact was generated')
}

if (zipFiles.length === 0) {
  fail('no ZIP artifact was generated; macOS auto-update requires the ZIP metadata')
}

for (const file of [...dmgFiles, ...zipFiles]) {
  if (/\s/.test(file)) {
    fail(`${file} contains whitespace; release artifact names must stay URL-friendly`)
  }
}

const referencedFiles = [...metadata.matchAll(/(?:url|path):\s*"?([^"\n]+)"?/g)]
  .map((match) => match[1].trim())
  .filter((value) => !value.startsWith('http://') && !value.startsWith('https://'))
  .map((value) => path.basename(value))

if (referencedFiles.length === 0) {
  fail('latest-mac.yml does not reference any local artifact path')
}

for (const file of referencedFiles) {
  assertFile(path.join(releaseDir, file), `artifact referenced by latest-mac.yml (${file})`)
}

console.log('Update release verification passed.')
console.log(`Version: ${version}`)
console.log(`DMG: ${dmgFiles.join(', ')}`)
console.log(`ZIP: ${zipFiles.join(', ')}`)
