import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function assertExactSemver(value) {
  const match = typeof value === 'string' ? EXACT_SEMVER.exec(value) : null
  const hasInvalidNumericPrerelease = match?.[4]
    ?.split('.')
    .some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))
  if (!match || hasInvalidNumericPrerelease) {
    throw new Error(`Expected exact SemVer, received ${value ?? 'missing'}`)
  }
  return value
}

export function needsCliUpdate(current, latest) {
  return current !== latest
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
  })
  if (result.status !== 0) {
    throw new Error(`${command} failed with ${result.status ?? 'no exit status'}`)
  }
}

export function applyCliUpdate(version) {
  const exact = assertExactSemver(version)
  run('npm', [
    'install',
    '--save-exact',
    '--package-lock-only',
    '--ignore-scripts',
    `@verboo/code@${exact}`,
  ])
  run('corepack', ['pnpm', 'install', '--lockfile-only', '--ignore-scripts'])
}

async function main() {
  const versionIndex = process.argv.indexOf('--version')
  const requested = versionIndex >= 0 ? process.argv[versionIndex + 1] : undefined
  if (!requested) throw new Error('Missing --version')

  const latest = assertExactSemver(requested)
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
  const current = assertExactSemver(packageJson.dependencies?.['@verboo/code'])
  if (!needsCliUpdate(current, latest)) {
    console.log(`Bundled CLI already uses ${latest}`)
    return
  }

  applyCliUpdate(latest)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
