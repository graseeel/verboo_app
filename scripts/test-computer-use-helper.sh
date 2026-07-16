#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT/src-tauri/swift-helper/build.sh" >/dev/null

case "$(uname -m)" in
  arm64) triple="aarch64-apple-darwin" ;;
  x86_64) triple="x86_64-apple-darwin" ;;
  *) echo "Unsupported architecture" >&2; exit 1 ;;
esac

helper="$ROOT/src-tauri/binaries/computer-use-helper-$triple"
response="$(printf '%s\n' '{"id":1,"method":"capabilities","params":{}}' | "$helper")"

node -e '
const response = JSON.parse(process.argv[1]);
const expected = [
  "screenshot", "left-click", "right-click", "middle-click", "double-click",
  "triple-click", "type-text", "press-key", "hold-key", "mouse-move", "scroll",
  "left-click-drag", "left-mouse-down", "left-mouse-up", "wait", "zoom",
  "inspect-keyboard-target"
];
const actual = new Set(response.result?.commands ?? []);
const missing = expected.filter(command => !actual.has(command));
if (missing.length) {
  console.error(`Missing helper commands: ${missing.join(", ")}`);
  process.exit(1);
}
' "$response"

node - "$helper" <<'NODE'
const { spawnSync } = require('node:child_process')

const helper = process.argv[2]
const preConsentRequests = [
  { id: 1, method: 'capabilities', params: {} },
  { id: 2, method: 'list-apps', params: {} },
  { id: 3, method: 'resolve-app', params: { app: 'contract.invalid.NoSuchApp' } },
  { id: 4, method: 'permissions', params: {} },
]
const privilegedRequests = [
  { id: 10, method: 'launch-app', params: { app: 'contract.invalid.NoSuchApp' } },
  { id: 11, method: 'list-windows', params: { app: 'contract.invalid.NoSuchApp' } },
  { id: 12, method: 'get-app-state', params: { app: 'contract.invalid.NoSuchApp' } },
  { id: 13, method: 'screenshot', params: { app: 'contract.invalid.NoSuchApp', no_screenshot: false } },
  { id: 14, method: 'zoom', params: { app: 'contract.invalid.NoSuchApp', capture_frame: { x: 0, y: 0, width: 1, height: 1 } } },
  { id: 15, method: 'inspect-pointer', params: { app: 'contract.invalid.NoSuchApp', x: 1, y: 1 } },
  { id: 16, method: 'inspect-keyboard-target', params: { app: 'contract.invalid.NoSuchApp' } },
  { id: 17, method: 'click', params: { app: 'contract.invalid.NoSuchApp', x: 1, y: 1 } },
  { id: 18, method: 'left-click', params: { app: 'contract.invalid.NoSuchApp', x: 1, y: 1 } },
  { id: 19, method: 'right-click', params: { app: 'contract.invalid.NoSuchApp', x: 1, y: 1 } },
  { id: 20, method: 'middle-click', params: { app: 'contract.invalid.NoSuchApp', x: 1, y: 1 } },
  { id: 21, method: 'double-click', params: { app: 'contract.invalid.NoSuchApp', x: 1, y: 1 } },
  { id: 22, method: 'triple-click', params: { app: 'contract.invalid.NoSuchApp', x: 1, y: 1 } },
  { id: 23, method: 'type-text', params: { app: 'contract.invalid.NoSuchApp', text: 'x', expected_content_state: 'empty', expected_selection_state: 'none' } },
  { id: 24, method: 'press-key', params: { app: 'contract.invalid.NoSuchApp', key: 'enter' } },
  { id: 25, method: 'hotkey', params: { app: 'contract.invalid.NoSuchApp', key: 'cmd+a' } },
  { id: 26, method: 'hold-key', params: { app: 'contract.invalid.NoSuchApp', key: 'a', duration: 0.1 } },
  { id: 27, method: 'mouse-move', params: { app: 'contract.invalid.NoSuchApp', x: 1, y: 1 } },
  { id: 28, method: 'scroll', params: { app: 'contract.invalid.NoSuchApp', x: 1, y: 1, amount: 1, direction: 'down' } },
  { id: 29, method: 'left-click-drag', params: { app: 'contract.invalid.NoSuchApp', start_x: 1, start_y: 1, x: 2, y: 2 } },
  { id: 30, method: 'left-mouse-down', params: { app: 'contract.invalid.NoSuchApp', x: 1, y: 1 } },
  { id: 31, method: 'left-mouse-up', params: { app: 'contract.invalid.NoSuchApp', x: 1, y: 1 } },
  { id: 32, method: 'wait', params: { duration: 0.1 } },
]
const requests = [...preConsentRequests, ...privilegedRequests]
const env = { ...process.env }
delete env.VERBOO_CU_TOKEN
delete env.VERBOO_CU_CAPABILITY_FILE
const run = spawnSync(helper, [], {
  input: `${requests.map(request => JSON.stringify(request)).join('\n')}\n`,
  encoding: 'utf8',
  env,
})
if (run.status !== 0) throw new Error(run.stderr || `helper exited ${run.status}`)
const responses = run.stdout.trim().split(/\n+/).filter(Boolean).map(JSON.parse)
if (responses.length !== requests.length) {
  throw new Error(`expected ${requests.length} authorization responses, received ${responses.length}`)
}
const byId = new Map(responses.map(response => [response.id, response]))
for (const request of preConsentRequests) {
  const response = byId.get(request.id)
  if (request.method === 'resolve-app') {
    if (response?.error?.code !== 'app_not_found') {
      throw new Error(`resolve-app must remain pre-consent: ${JSON.stringify(response)}`)
    }
  } else if (response?.error != null) {
    throw new Error(`${request.method} must remain pre-consent: ${JSON.stringify(response)}`)
  }
}
for (const request of privilegedRequests) {
  const response = byId.get(request.id)
  if (response?.error?.code !== 'capability_required') {
    throw new Error(`${request.method} must fail without capability: ${JSON.stringify(response)}`)
  }
}
NODE

node - "$helper" <<'NODE'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const helper = process.argv[2]
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verboo-cu-native-capability-'))
const now = Math.floor(Date.now() / 1000)
const token = 'contract-native-capability-token'

function approved(bundleId, tier) {
  return { bundle_id: bundleId, display_name: bundleId, tier, approved_at_wall: now }
}

function invoke(name, capability, request) {
  const capabilityPath = path.join(directory, `${name}.json`)
  fs.writeFileSync(capabilityPath, JSON.stringify({ token, paused: false, expires_at: now + 60, ...capability }))
  const run = spawnSync(helper, [], {
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    env: {
      ...process.env,
      VERBOO_CU_TOKEN: token,
      VERBOO_CU_CAPABILITY_FILE: capabilityPath,
    },
  })
  if (run.status !== 0) throw new Error(`${name}: ${run.stderr || `helper exited ${run.status}`}`)
  return JSON.parse(run.stdout.trim())
}

function expectError(name, capability, request, code) {
  const response = invoke(name, capability, request)
  if (response.error?.code !== code) {
    throw new Error(`${name}: expected ${code}, received ${JSON.stringify(response)}`)
  }
}

try {
  const app = 'com.example.ContractApp'
  const other = 'com.example.OtherApp'
  expectError(
    'paused',
    { app, approved_apps: [approved(app, 'full_control')], paused: true },
    { id: 1, method: 'wait', params: { duration: 0.1 } },
    'session_revoked',
  )
  expectError(
    'expired',
    { app, approved_apps: [approved(app, 'full_control')], expires_at: now - 1 },
    { id: 2, method: 'wait', params: { duration: 0.1 } },
    'session_revoked',
  )
  expectError(
    'token-mismatch',
    { token: 'wrong-contract-token', app, approved_apps: [approved(app, 'full_control')] },
    { id: 11, method: 'wait', params: { duration: 0.1 } },
    'session_revoked',
  )
  expectError(
    'unapproved-app',
    { app: other, approved_apps: [approved(app, 'full_control')] },
    { id: 3, method: 'screenshot', params: { app: other, no_screenshot: false } },
    'scope_denied',
  )
  expectError(
    'inactive-approved-app',
    { app, approved_apps: [approved(app, 'full_control'), approved(other, 'full_control')] },
    { id: 4, method: 'screenshot', params: { app: other, no_screenshot: false } },
    'scope_denied',
  )
  expectError(
    'view-tier-mutation',
    { app, approved_apps: [approved(app, 'view_only')] },
    { id: 5, method: 'left-click', params: { app, x: 1, y: 1 } },
    'scope_denied',
  )
  expectError(
    'click-tier-keyboard',
    { app, approved_apps: [approved(app, 'click_only')] },
    { id: 6, method: 'type-text', params: { app, text: 'x', expected_content_state: 'empty', expected_selection_state: 'none' } },
    'scope_denied',
  )
  expectError(
    'unknown-tier',
    { app, approved_apps: [approved(app, 'administrator')] },
    { id: 7, method: 'screenshot', params: { app, no_screenshot: false } },
    'scope_denied',
  )

  const viewAllowed = invoke(
    'view-tier-observation',
    { app, approved_apps: [approved(app, 'view_only')] },
    { id: 8, method: 'screenshot', params: { app, no_screenshot: false } },
  )
  if (['capability_required', 'session_revoked', 'scope_denied'].includes(viewAllowed.error?.code)) {
    throw new Error(`view-tier-observation: authorization unexpectedly denied: ${JSON.stringify(viewAllowed)}`)
  }

  const clickAllowed = invoke(
    'click-tier-launch',
    { app, approved_apps: [approved(app, 'click_only')] },
    { id: 9, method: 'launch-app', params: { app } },
  )
  if (!['app_not_found', 'os_permission_revoked'].includes(clickAllowed.error?.code)) {
    throw new Error(`click-tier-launch: expected a downstream launch/TCC error, received ${JSON.stringify(clickAllowed)}`)
  }

  const fullAllowed = invoke(
    'full-tier-wait',
    { app, approved_apps: [approved(app, 'full_control')] },
    { id: 10, method: 'wait', params: { duration: 0.1 } },
  )
  if (fullAllowed.error != null || fullAllowed.result?.performed !== true) {
    throw new Error(`full-tier-wait: expected success, received ${JSON.stringify(fullAllowed)}`)
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
NODE

node - "$helper" <<'NODE'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const helper = process.argv[2]
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verboo-cu-effect-guard-'))
const capabilityPath = path.join(directory, 'capability.json')
const token = 'contract-effect-token'
const app = 'com.example.ContractApp'

function capability(overrides = {}) {
  return {
    token,
    app,
    approved_apps: [{
      bundle_id: app,
      display_name: 'Contract App',
      tier: 'full_control',
      approved_at_wall: Math.floor(Date.now() / 1000),
    }],
    paused: false,
    expires_at: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  }
}

const env = {
  ...process.env,
  VERBOO_CU_TOKEN: token,
  VERBOO_CU_CAPABILITY_FILE: capabilityPath,
}

async function expectRevocationDuringEffectWindow() {
  fs.writeFileSync(capabilityPath, JSON.stringify(capability()))
  const child = spawn(helper, ['--contract-test'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.stdin.write(`${JSON.stringify({
    id: 1,
    method: 'authorize-effect-after-wait',
    params: { app, duration: 0.25, contract_screen_recording: true },
  })}\n`)
  const revokeTimer = setTimeout(
    () => fs.writeFileSync(capabilityPath, JSON.stringify(capability({ paused: true }))),
    50,
  )
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`effect guard timed out: ${stdout || stderr}`))
    }, 1500)
    child.stdout.on('data', () => {
      if (!stdout.includes('\n')) return
      clearTimeout(timer)
      child.stdin.end()
      resolve(JSON.parse(stdout.trim().split(/\n+/)[0]))
    })
  })
  clearTimeout(revokeTimer)
  if (response.error?.code !== 'session_revoked') {
    throw new Error(`effect guard must observe mid-flight pause: ${JSON.stringify(response)}`)
  }
}

async function run() {
  await expectRevocationDuringEffectWindow()

  fs.writeFileSync(capabilityPath, JSON.stringify(capability()))
  const deniedTcc = spawnSync(helper, ['--contract-test'], {
    env,
    input: `${JSON.stringify({
      id: 2,
      method: 'authorize-effect',
      params: { app, contract_screen_recording: false },
    })}\n`,
    encoding: 'utf8',
  })
  if (deniedTcc.status !== 0) throw new Error(deniedTcc.stderr || `helper exited ${deniedTcc.status}`)
  const response = JSON.parse(deniedTcc.stdout.trim())
  if (response.error?.code !== 'os_permission_revoked') {
    throw new Error(`effect guard must require Screen Recording: ${JSON.stringify(response)}`)
  }
}

run()
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }))
  .catch(error => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
NODE

node - "$ROOT/src-tauri/swift-helper/main.swift" <<'NODE'
const fs = require('node:fs')

const source = fs.readFileSync(process.argv[2], 'utf8')
const listAppsSection = source.slice(source.indexOf('func listApps()'), source.indexOf('func stringParam('))
if (/applicationWindows|AXUIElement/.test(listAppsSection)) {
  throw new Error('pre-consent list-apps must not inspect the Accessibility tree')
}
if (!source.includes('NSWorkspace.shared.fullPath(forApplication: selector)')) {
  throw new Error('installed app resolution must support an exact display name through NSWorkspace')
}
if (!/for _ in 0\.\.<600[\s\S]*?resolveRunningApp\(bundleId\)/.test(source)) {
  throw new Error('launch polling must use the resolved canonical bundle id')
}
const compactApply = source.slice(
  source.indexOf('private func applyCompactLayoutIfNeeded('),
  source.indexOf('private func activateTargetIfRequested('),
)
if (compactApply.indexOf('writeFocusRestoreRecords(') > compactApply.indexOf('setAccessibilityFrame(')) {
  throw new Error('compact layout must persist both original frames before the first mutation')
}
const focusTick = source.slice(
  source.indexOf('private func tick()'),
  source.indexOf('private func isolateVisibleApps('),
)
if (/\.activate\(|setAccessibilityFrame\(/.test(focusTick)) {
  throw new Error('focus timer must not directly activate apps or reapply window frames')
}
if (!source.includes('"compact_layout_applied": controller.compactLayoutApplied')) {
  throw new Error('focus-ready must report verified compact layout readiness')
}
if (!source.includes('NSRunningApplication(processIdentifier: controllerPid)')) {
  throw new Error('compact layout must bind the controller by its signed PID')
}
if (!source.includes('private func activateTargetIfRequested(')) {
  throw new Error('focus generation must route through one explicit target activation helper')
}
if (compactApply.includes('.activate(')) {
  throw new Error('compact layout application must not activate the target app')
}
if (!source.includes('panel.sharingType = .none')) {
  throw new Error('display edge overlay must be excluded from screen sharing')
}
if (!source.includes('compactFrames?.overlayAppKitFrame ?? selectedFocusScreen.screen.frame')) {
  throw new Error('overlay must cover the selected display rather than the target window')
}
const overlayView = source.slice(
  source.indexOf('private final class FocusOverlayView'),
  source.indexOf('private final class FocusSessionController'),
)
if (overlayView.includes('Verboo •') || overlayView.includes('pillRect')) {
  throw new Error('display edge overlay must not draw a focusable or visual label pill')
}
const eventPosts = source.match(/\.post\(tap: \.cghidEventTap\)/g) ?? []
if (eventPosts.length !== 2) {
  throw new Error(`all CGEvent posts must pass through one authorized wrapper plus one safety-release wrapper; found ${eventPosts.length}`)
}
if (!source.includes('private func postAuthorizedEvent(') || !source.includes('private func postSafetyReleaseEvent(')) {
  throw new Error('guarded and safety-release CGEvent wrappers are required')
}
const axActions = source.match(/AXUIElementPerformAction\(/g) ?? []
if (axActions.length !== 1 || !source.includes('private func performAuthorizedAXAction(')) {
  throw new Error('AXUIElementPerformAction must pass through the authorized wrapper')
}
const liveHandler = source.slice(source.indexOf('func handle(_ req: Request)'), source.indexOf('// MARK: - Stdio loop'))
if (/writeResponse\([^\n]*\["performed": true\]/.test(liveHandler)) {
  throw new Error('mutating helper success must pass through the shared UI-settle barrier')
}
if (!/let app = try launchApp[\s\S]*?writeMutationSuccess\(/.test(liveHandler)) {
  throw new Error('launch success must pass through the shared UI-settle barrier')
}
const settleCalls = source.match(/waitForUISettle\(\)/g) ?? []
if (settleCalls.length !== 2) {
  throw new Error(`UI settling must be centralized in one success barrier; found ${settleCalls.length} references`)
}
NODE

node - "$helper" "$ROOT/src-tauri/swift-helper/tests/contract-fixtures.json" <<'NODE'
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const { isDeepStrictEqual } = require('node:util')

const helper = process.argv[2]
const fixtures = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const input = `${fixtures.map(fixture => JSON.stringify(fixture.request)).join('\n')}\n`
const run = spawnSync(helper, ['--contract-test'], { input, encoding: 'utf8' })
if (run.status !== 0) {
  process.stderr.write(run.stderr)
  process.exit(run.status ?? 1)
}
const responses = run.stdout.trim().split(/\n+/).filter(Boolean).map(JSON.parse)
if (responses.length !== fixtures.length) {
  throw new Error(`Expected ${fixtures.length} responses, received ${responses.length}`)
}
for (let index = 0; index < fixtures.length; index += 1) {
  const fixture = fixtures[index]
  const response = responses[index]
  if (response.id !== fixture.request.id) throw new Error(`${fixture.name}: response id mismatch`)
  if (fixture.expect.errorCode) {
    if (response.error?.code !== fixture.expect.errorCode) {
      throw new Error(`${fixture.name}: expected ${fixture.expect.errorCode}, received ${JSON.stringify(response)}`)
    }
    continue
  }
  if (response.error != null) throw new Error(`${fixture.name}: ${JSON.stringify(response.error)}`)
  for (const key of fixture.expect.resultKeys ?? []) {
    if (!(key in (response.result ?? {}))) throw new Error(`${fixture.name}: missing result key ${key}`)
  }
  for (const [key, value] of Object.entries(fixture.expect.resultValues ?? {})) {
    if (!isDeepStrictEqual(response.result?.[key], value)) {
      throw new Error(`${fixture.name}: expected ${key}=${JSON.stringify(value)}, received ${JSON.stringify(response.result?.[key])}`)
    }
  }
}
NODE

node - "$helper" <<'NODE'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')

const helper = process.argv[2]
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verboo-cu-emergency-lifeline-'))
const capability = path.join(directory, 'capability.json')

function launch() {
  fs.writeFileSync(capability, '{}')
  const child = spawn(
    helper,
    ['--monitor-emergency', '--monitor-capability', capability],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('emergency monitor did not become ready')), 2000)
    readline.createInterface({ input: child.stdout }).once('line', line => {
      clearTimeout(timer)
      if (!line.includes('monitor-ready')) reject(new Error(`unexpected monitor line: ${line}`))
      else resolve()
    })
  })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  return { child, ready, exited }
}

async function expectPromptExit(run, label) {
  const timeout = new Promise((_, reject) => setTimeout(
    () => reject(new Error(`${label} did not stop the emergency monitor`)),
    2000,
  ))
  const result = await Promise.race([run.exited, timeout])
  if (result.code !== 0) throw new Error(`${label} exited unsuccessfully: ${JSON.stringify(result)}`)
}

async function run() {
  const revoked = launch()
  await revoked.ready
  fs.rmSync(capability, { force: true })
  await expectPromptExit(revoked, 'capability revocation')

  const orphaned = launch()
  await orphaned.ready
  orphaned.child.stdin.end()
  await expectPromptExit(orphaned, 'stdin lifeline EOF')
}

run()
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }))
  .catch(error => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
NODE

node - "$helper" <<'NODE'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const helper = process.argv[2]
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verboo-cu-cancel-'))
const capability = path.join(directory, 'capability.json')
const token = 'contract-cancel-token'
fs.writeFileSync(capability, JSON.stringify({
  token,
  app: 'com.example.ContractApp',
  approved_apps: [{
    bundle_id: 'com.example.ContractApp',
    display_name: 'Contract App',
    tier: 'full_control',
    approved_at_wall: Math.floor(Date.now() / 1000),
  }],
  paused: false,
  expires_at: Math.floor(Date.now() / 1000) + 60,
}))

const child = spawn(helper, ['--contract-test'], {
  env: { ...process.env, VERBOO_CU_TOKEN: token, VERBOO_CU_CAPABILITY_FILE: capability },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
const startedAt = Date.now()
child.stdin.write(`${JSON.stringify({ id: 99, method: 'cancellable-wait', params: { duration: 5 } })}\n`)
setTimeout(() => fs.rmSync(capability, { force: true }), 100)
const timeout = setTimeout(() => child.kill('SIGKILL'), 2000)
child.stdout.on('data', () => {
  if (!stdout.includes('\n')) return
  clearTimeout(timeout)
  child.stdin.end()
})
child.on('exit', code => {
  fs.rmSync(directory, { recursive: true, force: true })
  if (Date.now() - startedAt >= 1500) throw new Error('revocation did not interrupt contract wait promptly')
  const response = JSON.parse(stdout.trim().split(/\n+/)[0])
  if (response.error?.code !== 'aborted') {
    throw new Error(`expected aborted cancellation, received ${stdout || stderr || `exit ${code}`}`)
  }
})
NODE

node - "$helper" <<'NODE'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const helper = process.argv[2]
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verboo-cu-focus-restore-'))
try {
  const malformed = path.join(directory, 'malformed.json')
  fs.writeFileSync(malformed, '{not-json')
  const rejected = spawnSync(helper, ['--restore-focus-state', malformed], { encoding: 'utf8' })
  if (rejected.status === 0) throw new Error('malformed focus state must fail closed')
  if (!fs.existsSync(malformed)) throw new Error('malformed focus state must be preserved')

  const capability = path.join(directory, 'capability.json')
  const sessionRestore = path.join(directory, 'focus-restore.json')
  fs.writeFileSync(capability, JSON.stringify({
    expires_at: Math.floor(Date.now() / 1000) + 60,
    paused: false,
    approved_apps: [],
  }))
  fs.writeFileSync(sessionRestore, '{still-not-json')
  const refusedSession = spawnSync(
    helper,
    [
      '--focus-session', 'com.apple.Notes', capability,
      '--focus-generation', 'corrupt-state-generation',
    ],
    { encoding: 'utf8', timeout: 2000 },
  )
  if (refusedSession.status === 0) throw new Error('focus session must refuse corrupt stale state')
  if (refusedSession.stdout.includes('focus-ready')) {
    throw new Error('focus session must restore stale state before announcing readiness')
  }
  if (!fs.existsSync(sessionRestore)) throw new Error('refused focus session must preserve stale state')

  const unresolved = path.join(directory, 'unresolved.json')
  fs.chmodSync(directory, 0o755)
  const written = spawnSync(
    helper,
    ['--contract-test', '--contract-write-focus-state', unresolved],
    { encoding: 'utf8' },
  )
  if (written.status !== 0) {
    throw new Error(`focus state contract write failed: ${written.stderr || written.status}`)
  }
  if ((fs.statSync(unresolved).mode & 0o777) !== 0o600) {
    throw new Error('persisted focus state must use mode 0600')
  }
  if ((fs.statSync(directory).mode & 0o777) !== 0o700) {
    throw new Error('focus runtime directory must use mode 0700')
  }
  const unresolvedRestore = spawnSync(
    helper,
    ['--restore-focus-state', unresolved],
    { encoding: 'utf8' },
  )
  if (unresolvedRestore.status === 0) throw new Error('invalid PID restore record must fail closed')
  if (!fs.existsSync(unresolved)) throw new Error('unresolved focus state must remain persisted')

  const empty = path.join(directory, 'empty.json')
  fs.writeFileSync(empty, '[]')
  const restored = spawnSync(helper, ['--restore-focus-state', empty], { encoding: 'utf8' })
  if (restored.status !== 0) {
    throw new Error(`empty focus state should restore cleanly: ${restored.stderr || restored.status}`)
  }
  if (fs.existsSync(empty)) throw new Error('successfully restored focus state must be removed')
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
NODE

node - "$helper" <<'NODE'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')

const helper = process.argv[2]
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verboo-cu-focus-handshake-'))
const capability = path.join(directory, 'capability.json')
fs.writeFileSync(capability, JSON.stringify({
  expires_at: Math.floor(Date.now() / 1000) + 60,
  paused: false,
  approved_apps: [],
}))

function launch(generation) {
  const child = spawn(
    helper,
    [
      '--focus-session', 'contract.invalid.NoSuchApp', capability,
      '--focus-generation', generation,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const lines = []
  const pendingLines = []
  const waiters = []
  readline.createInterface({ input: child.stdout }).on('line', line => {
    lines.push(line)
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(line)
    else pendingLines.push(line)
  })
  const nextLine = (timeoutMs = 2000) => new Promise((resolve, reject) => {
    if (pendingLines.length) return resolve(pendingLines.shift())
    const waiter = { resolve: value => { clearTimeout(timer); resolve(value) }, reject }
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter)
      if (index >= 0) waiters.splice(index, 1)
      reject(new Error(`timed out waiting for focus protocol; lines=${JSON.stringify(lines)}`))
    }, timeoutMs)
    waiters.push(waiter)
  })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  return { child, lines, nextLine, exited }
}

function parseExpected(line, event, generation) {
  const value = JSON.parse(line)
  if (value.event !== event || value.generation !== generation) {
    throw new Error(`expected ${event}/${generation}, received ${line}`)
  }
}

async function run() {
  const uncommitted = launch('generation-before-commit')
  parseExpected(await uncommitted.nextLine(), 'focus-prepared', 'generation-before-commit')
  await new Promise(resolve => setTimeout(resolve, 150))
  if (uncommitted.lines.some(line => line.includes('focus-ready'))) {
    throw new Error('focus helper announced readiness before durable lease commit')
  }
  uncommitted.child.stdin.end()
  const uncommittedExit = await uncommitted.exited
  if (uncommittedExit.code === 0) throw new Error('EOF before focus commit must fail closed')

  const committed = launch('generation-after-commit')
  parseExpected(await committed.nextLine(), 'focus-prepared', 'generation-after-commit')
  committed.child.stdin.end(`${JSON.stringify({
    event: 'focus-commit',
    generation: 'generation-after-commit',
  })}\n`)
  parseExpected(await committed.nextLine(), 'focus-ready', 'generation-after-commit')
  committed.child.kill('SIGTERM')
  const committedExit = await committed.exited
  if (committedExit.code !== 0) {
    throw new Error(`committed focus helper did not restore cleanly: ${JSON.stringify(committedExit)}`)
  }
}

run()
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }))
  .catch(error => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
NODE

grep -q 'RegisterEventHotKey(UInt32(kVK_Escape), 0,' "$ROOT/src-tauri/swift-helper/main.swift"
grep -q '^import ScreenCaptureKit$' "$ROOT/src-tauri/swift-helper/main.swift"
grep -q 'SCContentFilter(desktopIndependentWindow:' "$ROOT/src-tauri/swift-helper/main.swift"
grep -q 'SCStream(filter:' "$ROOT/src-tauri/swift-helper/main.swift"

agent_app="$ROOT/src-tauri/binaries/Verboo Computer Use.app"
[[ "$(plutil -extract CFBundleIdentifier raw "$agent_app/Contents/Info.plist")" == "ai.verboo.code.computer-use" ]]
[[ "$(plutil -extract LSUIElement raw "$agent_app/Contents/Info.plist")" == "true" ]]
agent_verify_dir="$(mktemp -d "${TMPDIR:-/tmp}/verboo-agent-verify.XXXXXX")"
trap 'rm -rf "$agent_verify_dir"' EXIT
ditto --norsrc --noextattr "$agent_app" "$agent_verify_dir/Verboo Computer Use.app"
xattr -cr "$agent_verify_dir/Verboo Computer Use.app"
codesign --verify --deep --strict "$agent_verify_dir/Verboo Computer Use.app"

launch_plan="$(
  VERBOO_CU_TOKEN='contract-secret-token' \
  VERBOO_CU_CAPABILITY_FILE='/tmp/contract-capability.json' \
  "$helper" \
    --contract-test \
    --contract-agent-launch-plan \
    --launch-agent-app '/Applications/Verboo Code.app/Contents/Helpers/Verboo Computer Use.app' \
    --installed-agent-app '/Users/test/Library/Application Support/Verboo/Computer Use/Verboo Computer Use.app' \
    --launch-agent-socket '/tmp/verboo-contract.sock'
)"

node - "$launch_plan" <<'NODE'
const plan = JSON.parse(process.argv[2])
const expected = {
  source_app: '/Applications/Verboo Code.app/Contents/Helpers/Verboo Computer Use.app',
  installed_app: '/Users/test/Library/Application Support/Verboo/Computer Use/Verboo Computer Use.app',
  socket: '/tmp/verboo-contract.sock',
  activates: false,
  adds_to_recent_items: false,
  creates_new_application_instance: true,
  allows_running_application_substitution: false,
  capability_environment: true,
}
for (const [key, value] of Object.entries(expected)) {
  if (plan[key] !== value) {
    throw new Error(`launch plan ${key}: expected ${JSON.stringify(value)}, received ${JSON.stringify(plan[key])}`)
  }
}
const rendered = JSON.stringify(plan)
if (rendered.includes('contract-secret-token')) {
  throw new Error('launch plan leaked the capability token')
}
NODE

node - "$ROOT/src-tauri/swift-helper/main.swift" "$ROOT/src-tauri/src/services/computer_use_mcp.rs" <<'NODE'
const fs = require('node:fs')
const source = fs.readFileSync(process.argv[2], 'utf8')
const mcp = fs.readFileSync(process.argv[3], 'utf8')
const agentApplicationLoop = source.slice(
  source.indexOf('private func runAgentApplicationLoop('),
  source.indexOf('installAgentSocketTransportIfNeeded()'),
)
if (!agentApplicationLoop.includes('DispatchQueue.global')) {
  throw new Error('the bundled agent must move blocking IPC off the AppKit main thread')
}
if (!agentApplicationLoop.includes('.run()')) {
  throw new Error('the bundled agent must keep an AppKit run loop alive for asynchronous TCC registration')
}
if (!agentApplicationLoop.includes('dispatchRequestsOnMain: true')) {
  throw new Error('the bundled agent must dispatch AppKit and TCC requests onto its live main run loop')
}
if (!source.includes('DispatchQueue.main.sync')) {
  throw new Error('the bundled agent must execute requests on the AppKit main thread')
}
const permissionRequest = source.slice(
  source.indexOf('private func requestScreenCaptureAccess()'),
  source.indexOf('// MARK: - Stdio loop'),
)
const shareableContentRequest = source.slice(
  source.indexOf('private func shareableScreenContent('),
  source.indexOf('@available(macOS 12.3, *)\nprivate func screenCaptureKitWindow('),
)
if (!permissionRequest.includes('NSApplication.shared')) {
  throw new Error('screen capture registration must initialize the bundled agent as a macOS application')
}
if (!permissionRequest.includes('setActivationPolicy(.accessory)')) {
  throw new Error('the LSUIElement agent must remain an accessory app while registering with TCC')
}
if (!shareableContentRequest.includes('SCShareableContent.getExcludingDesktopWindows')) {
  throw new Error('screen capture registration must use ScreenCaptureKit when the legacy request does not register TCC')
}
if (permissionRequest.includes('DispatchSemaphore')) {
  throw new Error('screen capture registration must not block the AppKit main thread while awaiting ScreenCaptureKit')
}
if (!shareableContentRequest.includes('RunLoop.current.run')) {
  throw new Error('screen capture registration must keep the AppKit run loop responsive while awaiting shareable content')
}
if (
  permissionRequest.indexOf('shareableScreenContent()')
    > permissionRequest.indexOf('CGRequestScreenCaptureAccess')
) {
  throw new Error('screen capture registration must follow the Apple ScreenCaptureKit-first request flow')
}
if (!permissionRequest.includes('OneFrameCapture()')) {
  throw new Error('screen capture registration must use the real window capture output')
}
if (!permissionRequest.includes('permissionCapture.capture(filter: filter, configuration: configuration)')) {
  throw new Error('screen capture registration must start a real output-backed ScreenCaptureKit stream')
}
if (!source.includes('stream.addStreamOutput(self, type: .screen')) {
  throw new Error('the registration stream must attach a video output before starting capture')
}
if (!source.includes('stream.startCapture')) {
  throw new Error('screen capture registration must start capture so macOS creates the TCC entry')
}
const capture = source.slice(
  source.indexOf('private func screenCaptureKitWindow('),
  source.indexOf('private func legacyAuthorizedWindow('),
)
if (capture.includes('DispatchSemaphore')) {
  throw new Error('window capture must not block the AppKit main run loop while retrieving shareable content')
}
if (!shareableContentRequest.includes('RunLoop.current.run')) {
  throw new Error('window capture must keep the AppKit main run loop responsive while retrieving shareable content')
}
if (!capture.includes('SCContentFilter(desktopIndependentWindow: selected)')) {
  throw new Error('model capture must use the approved target window filter')
}
if (/SCContentFilter\([^)]*(display|excludingWindows)/.test(capture)) {
  throw new Error('model capture must not construct a full-display filter')
}
const focusController = source.slice(
  source.indexOf('private final class FocusSessionController'),
  source.indexOf('private func runFocusSession()'),
)
const tick = focusController.slice(
  focusController.indexOf('private func tick()'),
  focusController.indexOf('private func isolateVisibleApps'),
)
if (tick.includes('resolveRunningApp(selector)')) {
  throw new Error('focus timer must reuse the cached target application identity')
}
if (!focusController.includes('panel.sharingType = .none')) {
  throw new Error('focus overlay must be excluded from all sharing/capture')
}
if (!source.includes('"event": "focus-layout"')) {
  throw new Error('a target launched after the handshake must publish its layout result')
}
const launch = source.slice(
  source.indexOf('func launchApp('),
  source.indexOf('struct AXNode'),
)
const installedResolutions = launch.match(/resolveInstalledApplication\(selector\)/g) ?? []
if (installedResolutions.length !== 1) {
  throw new Error(`launch must resolve installed app metadata once; found ${installedResolutions.length}`)
}
if (!source.includes('for node in nodes where results.count < 120')) {
  throw new Error('interactive accessibility metadata must remain capped at 120 elements')
}
const dispatch = mcp.slice(
  mcp.indexOf('fn dispatch_compat_action('),
  mcp.indexOf('fn verify_observation_and_finalize('),
)
const ordinary = dispatch.slice(dispatch.indexOf('if pointer_confirmation_candidate'))
for (const [label, pattern] of [
  ['pointer preflight', /prepare_pointer_confirmation\(/g],
  ['canonical action', /invoke_canonical_action\(/g],
  ['fresh screenshot', /capture_canonical_screenshot\(/g],
]) {
  const count = ordinary.match(pattern)?.length ?? 0
  if (count !== 1) throw new Error(`ordinary action requires one ${label}; found ${count}`)
}
if (/\b(loop|while|for)\b/.test(ordinary)) {
  throw new Error('ordinary action dispatch must not contain an automatic retry loop')
}
const uncertain = mcp.slice(
  mcp.indexOf('fn action_effect_uncertain('),
  mcp.indexOf('fn remember_or_fail('),
)
if (/invoke_canonical_action|dispatch_compat_action/.test(uncertain)) {
  throw new Error('effect_uncertain must never retry or redispatch an action')
}
NODE
