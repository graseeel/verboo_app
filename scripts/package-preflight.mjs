import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const releaseAppPath = path.join(repoRoot, 'release', 'mac-arm64', 'Verboo Code.app')
const mode = process.argv.includes('--dir') ? 'app bundle' : 'DMG/ZIP release'

function runningReleaseProcesses() {
  if (process.platform !== 'darwin') {
    return []
  }

  let output = ''
  try {
    output = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
  } catch {
    return []
  }

  const appCommandPrefix = path.join(releaseAppPath, 'Contents')
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes(appCommandPrefix))
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/)
      if (!match) {
        return line
      }

      const [, pid, command] = match
      const label = command.includes('Helper')
        ? command.match(/Verboo Code Helper(?: \(Renderer\))?/)?.[0] ?? 'Verboo Code Helper'
        : 'Verboo Code'
      const type = command.match(/--type=([^\s]+)/)?.[1]
      return type ? `${pid} ${label} (${type})` : `${pid} ${label}`
    })
}

function mountedVerbooVolumes() {
  if (process.platform !== 'darwin') {
    return []
  }

  try {
    return fs
      .readdirSync('/Volumes', { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('Verboo Code'))
      .map((entry) => path.join('/Volumes', entry.name))
  } catch {
    return []
  }
}

const blockers = []
const running = runningReleaseProcesses()
const mounted = mountedVerbooVolumes()

if (running.length > 0) {
  blockers.push([
    'The previous packaged app is still running from release/mac-arm64.',
    'Close Verboo Code before packaging, or run:',
    '  osascript -e \'quit app "Verboo Code"\'',
    '  pkill -f "release/mac-arm64/Verboo Code.app"',
    '',
    'Running processes:',
    ...running.map((line) => `  ${line}`)
  ].join('\n'))
}

if (mounted.length > 0) {
  blockers.push([
    'A previous Verboo Code DMG is still mounted.',
    'Eject it in Finder before packaging, or run:',
    ...mounted.map((volume) => `  hdiutil detach ${JSON.stringify(volume)}`)
  ].join('\n'))
}

if (blockers.length > 0) {
  console.error(`\nPackaging preflight blocked the ${mode}.`)
  console.error('This prevents electron-builder/hdiutil from hanging on busy macOS resources.\n')
  console.error(blockers.join('\n\n'))
  process.exit(1)
}

console.log(`Packaging preflight passed for ${mode}.`)
