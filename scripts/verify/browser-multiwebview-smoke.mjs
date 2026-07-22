import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const appPath = process.argv[2]
if (!appPath?.endsWith('.app')) throw new Error('usage: browser-multiwebview-smoke.mjs /path/to/Verboo Code.app')

const workDir = await mkdtemp(join(tmpdir(), 'verboo-browser-smoke-'))
const reportPath = join(workDir, 'report.json')
const infoPlist = await readFile(join(appPath, 'Contents', 'Info.plist'), 'utf8')
const executableName = infoPlist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
if (!executableName) throw new Error('CFBundleExecutable is missing from Info.plist')
const executable = join(appPath, 'Contents', 'MacOS', executableName)

try {
  const child = spawn(executable, [], {
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
  if (!report.success || !report.navigated || !report.boundsUpdated || !report.destroyed) {
    throw new Error(`incomplete runtime smoke: ${JSON.stringify(report)}`)
  }
  if (!(report.snapshotBytes > 0) || !(report.snapshotMs <= 100)) {
    throw new Error(`snapshot budget failed: ${JSON.stringify(report)}`)
  }
  console.log(JSON.stringify(report))
} finally {
  await rm(workDir, { recursive: true, force: true })
}
