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

const referencedFiles = [...metadata.matchAll(/(?:url|path):\s*"?([^"\n]+)"?/g)]
  .map((match) => match[1].trim())
  .filter((value) => !value.startsWith('http://') && !value.startsWith('https://'))
  .map((value) => path.basename(value))

if (referencedFiles.length === 0) {
  fail('latest-mac.yml does not reference any local artifact path')
}

for (const file of referencedFiles) {
  assertFile(path.join(releaseDir, file), `artifact referenced by latest-mac.yml (${file})`)
  if (!file.includes(version)) {
    fail(`${file} is referenced by latest-mac.yml but does not include package version ${version}`)
  }
  if (/\s/.test(file)) {
    fail(`${file} is referenced by latest-mac.yml but contains whitespace`)
  }
}

const cleanVersionedFiles = releaseFiles.filter((file) => file.includes(version) && !/\s/.test(file))
const dmgFiles = cleanVersionedFiles.filter((file) => file.endsWith('.dmg'))
const zipFiles = cleanVersionedFiles.filter((file) => file.endsWith('.zip'))

if (dmgFiles.length === 0) {
  fail('no URL-friendly DMG artifact was generated for the current version')
}

if (zipFiles.length === 0) {
  fail('no URL-friendly ZIP artifact was generated for the current version; macOS auto-update requires the ZIP metadata')
}

console.log('Update release verification passed.')
console.log(`Version: ${version}`)
console.log(`DMG: ${dmgFiles.join(', ')}`)
console.log(`ZIP: ${zipFiles.join(', ')}`)
