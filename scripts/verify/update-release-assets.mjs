import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const releaseDir = path.join(repoRoot, 'release')
const packageJsonPath = path.join(repoRoot, 'package.json')

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const version = packageJson.version

// Detect platform from process.platform — CI runs the script on each OS
const platform = process.platform
const metadataFile = platform === 'darwin' ? 'latest-mac.yml'
  : platform === 'win32' ? 'latest.yml'
  : 'latest-linux.yml'
const metadataPath = path.join(releaseDir, metadataFile)

function fail(message) {
  console.error(`Update release verification failed: ${message}`)
  process.exit(1)
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} does not exist at ${path.relative(repoRoot, filePath)}`)
  }
}

assertFile(metadataPath, metadataFile)

const releaseFiles = fs.readdirSync(releaseDir)
const metadata = fs.readFileSync(metadataPath, 'utf8')

if (!metadata.includes(`version: ${version}`)) {
  fail(`${metadataFile} does not contain version: ${version}`)
}

const referencedFiles = [...metadata.matchAll(/(?:url|path):\s*"?([^"\n]+)"?/g)]
  .map((match) => match[1].trim())
  .filter((value) => !value.startsWith('http://') && !value.startsWith('https://'))
  .map((value) => path.basename(value))

if (referencedFiles.length === 0) {
  fail(`${metadataFile} does not reference any local artifact path`)
}

for (const file of referencedFiles) {
  assertFile(path.join(releaseDir, file), `artifact referenced by ${metadataFile} (${file})`)
  if (!file.includes(version)) {
    fail(`${file} is referenced by ${metadataFile} but does not include package version ${version}`)
  }
  if (/\s/.test(file)) {
    fail(`${file} is referenced by ${metadataFile} but contains whitespace`)
  }
}

const cleanVersionedFiles = releaseFiles.filter((file) => file.includes(version) && !/\s/.test(file))

console.log('Update release verification passed.')
console.log(`Version: ${version}`)
console.log(`Platform: ${platform}`)
console.log(`Metadata: ${metadataFile}`)
console.log(`Artifacts: ${cleanVersionedFiles.join(', ')}`)
