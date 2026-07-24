import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      executable: join(appPath, 'Contents', 'MacOS', executableName),
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
export function assertRuntimeReport(report) {
  // ── Single-tab lifecycle (original contract) ──────────────
  if (!report.success || !report.navigated || !report.boundsUpdated || !report.destroyed) {
    throw new Error(`incomplete runtime smoke: ${JSON.stringify(report)}`)
  }
  if (!(report.snapshotBytes > 0) || !(report.snapshotMs <= 100)) {
    throw new Error(`snapshot budget failed: ${JSON.stringify(report)}`)
  }

  // ── Smoke itself reported an error (e.g. timeout) ─────────
  if (report.error) {
    throw new Error(`smoke reported error: ${report.error}`)
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
  const infoPlist = await readFile(join(appPath, 'Contents', 'Info.plist'), 'utf8')
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
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('packaged browser runtime smoke timed out after 30s'))
    }, 30_000)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  if (exitCode !== 0) throw new Error(`packaged app exited with ${exitCode}`)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assertRuntimeReport(report)
  console.log(JSON.stringify(report))
} finally {
  await rm(workDir, { recursive: true, force: true })
}
}
