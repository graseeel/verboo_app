import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Guard the side-effecting entrypoint so importing this module for tests
// does not trigger argv parsing / spawn.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href

// Pure, platform-neutral launcher resolver. Testable with a deterministic
// default executableName; the real macOS caller reads CFBundleExecutable from
// the bundle's Info.plist and passes it explicitly, so the smoke never
// hardcodes a binary name in a product shipped to many users.
export function resolveLaunch(appPath, platform, executableName = 'verboo-desktop') {
  const isMacBundle = appPath.endsWith('.app')
  if (platform === 'darwin' && isMacBundle) {
    return {
      // Bundle .app internal structure is always POSIX, regardless of
      // host OS. resolveLaunch receives platform as a parameter and is
      // called with 'darwin' from any machine, so host-dependent path
      // separators (node:path join on Windows) would violate the
      // contract. posix.join yields '/' everywhere.
      executable: posix.join(appPath, 'Contents', 'MacOS', executableName),
      args: [],
    }
  }
  // Windows .exe and Linux binaries (and any unknown extension on darwin)
  // resolve as-is.
  return {
    executable: appPath,
    args: [],
  }
}

// Validates a BrowserRuntimeSmokeReport emitted by the Rust runtime smoke
// (browser_panel::start_runtime_smoke). Throws an Error citing the first
// field that fails so CI logs show exactly which parity contract broke.
// Every condition below has a corresponding test in the .test.mjs file.
//
// Snapshot is NON-BLOCKING: on headless CI runners WKWebView never composes
// a frame, so takeSnapshot times out even with correct code. The Rust side
// sets report.error = "snapshot ... timed out" and report.success = false
// (because success = error.is_none()). We tolerate that single failure mode
// and emit a WARNING; every other contract field stays blocking.
export function assertRuntimeReport(report) {
  // ── Detect the only tolerable failure: snapshot-only ──────
  // A snapshot-only failure is: snapshotBytes === 0 AND report.error mentions
  // "snapshot". Anything else with a non-null error is a real regression.
  const snapshotOnlyFailure =
    report.error &&
    report.snapshotBytes === 0 &&
    /snapshot/i.test(String(report.error))

  if (snapshotOnlyFailure) {
    console.error(
      `WARNING: snapshot unavailable in this environment (headless) — not blocking. ` +
      `error=${JSON.stringify(report.error)}`
    )
  } else if (report.error) {
    // ── Non-snapshot error: always blocking ─────────────────
    throw new Error(`smoke reported error: ${report.error}`)
  }

  // ── Single-tab lifecycle (original contract) ──────────────
  // success is skipped when snapshotOnlyFailure (it's false because error is
  // set, but the underlying contract is fine). All other lifecycle fields
  // remain blocking.
  const successRequired = !snapshotOnlyFailure
  if (
    (successRequired && !report.success) ||
    !report.navigated ||
    !report.boundsUpdated ||
    !report.destroyed
  ) {
    throw new Error(`incomplete runtime smoke: ${JSON.stringify(report)}`)
  }

  // ── Snapshot budget: only enforced when a snapshot was produced ──
  // If snapshotBytes > 0, the snapshot succeeded and must be within budget.
  // If snapshotBytes === 0 with a snapshot-only error, we already warned above.
  // If snapshotBytes === 0 WITHOUT a snapshot-only error (no error string),
  // that's a real regression — the smoke produced no bytes and no explanation.
  if (report.snapshotBytes > 0 && !(report.snapshotMs <= 100)) {
    throw new Error(`snapshot budget failed: ${JSON.stringify(report)}`)
  }
  if (report.snapshotBytes === 0 && !snapshotOnlyFailure) {
    throw new Error(`snapshot produced no bytes and no snapshot error: ${JSON.stringify(report)}`)
  }

  // ── Multi-tab parity contract (Tasks 3/4) ─────────────────
  if (!report.bridgeReceived) {
    throw new Error(`bridge not received: ${JSON.stringify(report)}`)
  }
  if (!report.evaluated) {
    throw new Error(`evaluate did not return Tab-Two: ${JSON.stringify(report)}`)
  }
  if (!(report.createdTabs >= 2)) {
    throw new Error(`expected >= 2 created tabs, got ${report.createdTabs}`)
  }
  if (!report.activatedSecondTab) {
    throw new Error(`second tab not activated: ${JSON.stringify(report)}`)
  }
  if (!(report.closedTabs >= 2)) {
    throw new Error(`expected >= 2 closed tabs, got ${report.closedTabs}`)
  }
}

export const SMOKE_WALL_TIMEOUT_MS = 180_000

if (isMain) {
const appPath = process.argv[2]
if (!appPath) {
  throw new Error(
    'usage: browser-multiwebview-smoke.mjs /path/to/Verboo Code.app | /path/to/verboo-desktop.exe | /path/to/verboo-desktop'
  )
}

const workDir = await mkdtemp(join(tmpdir(), 'verboo-browser-smoke-'))
const reportPath = join(workDir, 'report.json')

// Resolve the executable for the current platform. On macOS, read the real
// binary name from the bundle's Info.plist (do not hardcode it) and pass it
// to resolveLaunch so the product stays portable across rename/rebrand.
const platform = process.platform
let launch
if (platform === 'darwin' && appPath.endsWith('.app')) {
  // Same class as resolveLaunch: .app internal paths are always POSIX.
  // Guarded by platform==='darwin' today, but build it correctly so a
  // future test on any host can't break.
  const infoPlist = await readFile(posix.join(appPath, 'Contents', 'Info.plist'), 'utf8')
  const executableName = infoPlist.match(
    /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/
  )?.[1]
  if (!executableName) throw new Error('CFBundleExecutable is missing from Info.plist')
  launch = resolveLaunch(appPath, platform, executableName)
} else {
  launch = resolveLaunch(appPath, platform)
}

try {
  const child = spawn(launch.executable, launch.args, {
    env: { ...process.env, VERBOO_BROWSER_SMOKE_REPORT: reportPath },
    stdio: 'inherit',
  })
  const start = Date.now()
  const heartbeat = setInterval(() => {
    process.stdout.write(`[smoke] still running t=${((Date.now() - start) / 1000).toFixed(1)}s\n`)
  }, 10_000)
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`packaged browser runtime smoke timed out after ${SMOKE_WALL_TIMEOUT_MS}ms`))
    }, SMOKE_WALL_TIMEOUT_MS)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  clearInterval(heartbeat)
  if (exitCode !== 0) throw new Error(`packaged app exited with ${exitCode}`)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assertRuntimeReport(report)
  console.log(JSON.stringify(report))
} finally {
  await rm(workDir, { recursive: true, force: true })
}
}
