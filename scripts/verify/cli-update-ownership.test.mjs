import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const read = path => readFileSync(path, 'utf8')

test('the app bundle owns Node but never owns a CLI payload', () => {
  const packageJson = JSON.parse(read('package.json'))
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'))
  const macos = JSON.parse(read('src-tauri/tauri.macos.conf.json'))
  const resources = [...tauri.bundle.resources, ...macos.bundle.resources]

  assert.equal(packageJson.dependencies?.['@verboo/code'], undefined)
  assert.doesNotMatch(packageJson.scripts['build:tauri-deps'], /cli-package|copy-cli|dedup-cli/)
  assert.equal(resources.some(resource => resource.includes('cli-package')), false)
  assert.equal(tauri.bundle.externalBin.includes('binaries/verboo-node'), true)
})

test('the obsolete app-owned CLI update path cannot return', () => {
  for (const path of [
    '.github/workflows/verboo-cli-update.yml',
    'scripts/verify/copy-cli-resource.mjs',
    'scripts/verify/dedup-cli-package.mjs',
    'scripts/verify/update-cli-dependency.mjs',
    'scripts/verify/update-cli-dependency.test.mjs',
  ]) {
    assert.equal(existsSync(path), false, `${path} must stay removed`)
  }
})

test('app and CLI release discovery remain separate authorities', () => {
  const appUpdater = read('src-tauri/src/services/update_service.rs')
  const cliUpdater = read('src-tauri/src/services/cli_update/service.rs')

  assert.match(appUpdater, /github\.com\/graseeel\/verboo_app\/releases/)
  assert.doesNotMatch(appUpdater, /verbeux-ai\/code/)
  assert.match(cliUpdater, /github\.com\/verbeux-ai\/code\/releases\/latest\/download/)
  assert.doesNotMatch(cliUpdater, /api\.github\.com/)
  assert.doesNotMatch(cliUpdater, /graseeel\/verboo_app/)
})

test('release builds embed the CLI trust root without bundling the CLI', () => {
  const workflow = read('.github/workflows/tauri-release.yml')

  assert.match(workflow, /VERBOO_CLI_MINISIGN_PUBLIC_KEY:.*secrets\.VERBOO_CLI_MINISIGN_PUBLIC_KEY/)
  assert.doesNotMatch(workflow, /resources\/cli-package|copy-cli-resource|dedup-cli-package/)
})

test('cross-platform Rust gates prepare every required external runtime', () => {
  const ci = read('.github/workflows/ci-verify.yml')
  const linuxBrowserGate = read('scripts/verify/browser-linux-check.sh')

  assert.equal(ci.match(/verboo-ios-simulator/g)?.length, 5)
  assert.match(
    ci,
    /Prepare macOS WebDriverAgent resource[\s\S]*?if: runner\.os == 'macOS'[\s\S]*?copy-wda-resource\.mjs/,
  )
  assert.match(linuxBrowserGate, /verboo-ios-simulator/)
  assert.match(
    linuxBrowserGate,
    /build-node-sidecar\.mjs --target "\$TRIPLE"/,
  )
  assert.match(linuxBrowserGate, /if \[ ! -d dist-renderer \]/)
  assert.match(linuxBrowserGate, /trap cleanup_frontend_dist EXIT/)
  assert.doesNotMatch(linuxBrowserGate, /DARWIN_COUNT_BEFORE[^\n]*-ne\s+\d+/)
})
