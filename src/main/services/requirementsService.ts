import { app, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { release } from 'node:os'
import { createNodeRuntimeEnv, resolveNodeRuntimePath, resolvePackedJavaScriptEntryPath } from './nodeRuntime'

type RequirementStatus = 'pass' | 'warn' | 'fail'

type RequirementCheck = {
  id: string
  label: string
  status: RequirementStatus
  required: boolean
  message: string
}

type RequirementsResult = {
  ok: boolean
  checks: RequirementCheck[]
  fatalMessages: string[]
}

type RequirementsMarker = {
  schemaVersion: number
  appVersion: string
  checkedAt: string
}

const require = createRequire(import.meta.url)
const REQUIREMENTS_SCHEMA_VERSION = 1
const MIN_MACOS_MAJOR = 12
const MIN_MACOS_VERSION = '12.0'

export async function runFirstLaunchRequirementsCheck(): Promise<RequirementsResult> {
  const result = await validateRuntimeRequirements()

  if (result.ok) {
    await writeRequirementsMarker().catch(() => undefined)
    return result
  }

  await showRequirementsFailure(result)
  return result
}

export async function shouldRunFirstLaunchRequirementsCheck(): Promise<boolean> {
  if (process.env.VERBOO_SKIP_REQUIREMENTS_CHECK === '1') return false
  if (process.env.VERBOO_REQUIREMENTS_CHECK === 'always') return true

  try {
    const marker = JSON.parse(await readFile(requirementsMarkerPath(), 'utf8')) as Partial<RequirementsMarker>
    return marker.schemaVersion !== REQUIREMENTS_SCHEMA_VERSION || marker.appVersion !== app.getVersion()
  } catch {
    return true
  }
}

export async function validateRuntimeRequirements(): Promise<RequirementsResult> {
  const checks: RequirementCheck[] = []
  checks.push(checkPlatform())
  checks.push(checkArchitecture())
  checks.push(checkMacOsVersion())
  checks.push(await checkEmbeddedCli())
  checks.push(await checkPackageResolution('node-pty/package.json', 'Terminal native module', true))
  checks.push(await checkPackageResolution('sharp/package.json', 'Image processing module', true))
  checks.push(await checkPackageResolution('tesseract.js/package.json', 'OCR module', true))
  checks.push(await checkOptionalCommand('/usr/bin/git', ['--version'], 'Git command line tools'))

  const fatalMessages = checks
    .filter(check => check.required && check.status === 'fail')
    .map(check => `${check.label}: ${check.message}`)

  return { ok: fatalMessages.length === 0, checks, fatalMessages }
}

function checkPlatform(): RequirementCheck {
  if (process.platform === 'darwin') {
    return pass('platform', 'Operating system', true, 'macOS detected.')
  }
  return fail('platform', 'Operating system', true, 'This build currently supports macOS only.')
}

function checkArchitecture(): RequirementCheck {
  if (process.arch === 'arm64') {
    return pass('architecture', 'CPU architecture', true, 'Apple Silicon arm64 detected.')
  }
  return fail('architecture', 'CPU architecture', true, 'This build supports Apple Silicon arm64 Macs only.')
}

function checkMacOsVersion(): RequirementCheck {
  if (process.platform !== 'darwin') return fail('macos-version', 'macOS version', true, 'macOS version unavailable.')

  const version = readMacOsVersion()
  const major = Number(version.split('.')[0])
  if (Number.isFinite(major) && major >= MIN_MACOS_MAJOR) {
    return pass('macos-version', 'macOS version', true, `macOS ${version} detected.`)
  }
  return fail('macos-version', 'macOS version', true, `macOS ${MIN_MACOS_VERSION}+ is required. Detected: ${version}.`)
}

async function checkEmbeddedCli(): Promise<RequirementCheck> {
  try {
    const nodePath = await resolveNodeRuntimePath()
    const cliPath = resolveEmbeddedCliPath()
    if (!existsSync(cliPath)) {
      return fail('embedded-cli', 'Embedded Verboo CLI', true, 'The packaged CLI entrypoint was not found.')
    }

    const result = await runCommand(nodePath, [cliPath, '--version'], 10_000, createNodeRuntimeEnv())
    if (result.exitCode === 0 && result.output.trim()) {
      return pass('embedded-cli', 'Embedded Verboo CLI', true, result.output.trim())
    }

    const detail = result.error.trim() || result.output.trim() || `Exit code ${result.exitCode ?? 'unknown'}.`
    return fail('embedded-cli', 'Embedded Verboo CLI', true, detail)
  } catch (error) {
    return fail('embedded-cli', 'Embedded Verboo CLI', true, error instanceof Error ? error.message : String(error))
  }
}

async function checkPackageResolution(packageName: string, label: string, required: boolean): Promise<RequirementCheck> {
  try {
    require.resolve(packageName)
    return pass(packageName, label, required, 'Bundled dependency resolved.')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return required ? fail(packageName, label, required, message) : warn(packageName, label, required, message)
  }
}

async function checkOptionalCommand(command: string, args: string[], label: string): Promise<RequirementCheck> {
  const result = await runCommand(command, args, 5_000)
  if (result.exitCode === 0) return pass(command, label, false, result.output.trim() || 'Available.')
  return warn(command, label, false, 'Not found. Repository-specific Git features may be limited, but the app can still start.')
}

function resolveEmbeddedCliPath(): string {
  const packagePath = require.resolve('@verboo/code/package.json')
  const packageJson = require(packagePath) as { bin?: string | Record<string, string> }
  const binPath = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.verboo
  return resolvePackedJavaScriptEntryPath(join(dirname(packagePath), binPath ?? 'dist/cli.mjs'))
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number | null; output: string; error: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const output: string[] = []
    const errors: string[] = []
    let settled = false

    const finish = (result: { exitCode: number | null; output: string; error: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ exitCode: null, output: output.join(''), error: errors.join('') || 'Timed out.' })
    }, timeoutMs)

    child.stdout.on('data', chunk => output.push(String(chunk)))
    child.stderr.on('data', chunk => errors.push(String(chunk)))
    child.on('error', error => finish({ exitCode: null, output: output.join(''), error: error.message }))
    child.on('close', exitCode => finish({ exitCode, output: output.join(''), error: errors.join('') }))
  })
}

function readMacOsVersion(): string {
  const getSystemVersion = (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion
  return getSystemVersion ? getSystemVersion() : release()
}

async function writeRequirementsMarker(): Promise<void> {
  const markerPath = requirementsMarkerPath()
  await mkdir(dirname(markerPath), { recursive: true })
  const marker: RequirementsMarker = {
    schemaVersion: REQUIREMENTS_SCHEMA_VERSION,
    appVersion: app.getVersion(),
    checkedAt: new Date().toISOString(),
  }
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

function requirementsMarkerPath(): string {
  return join(app.getPath('userData'), 'requirements-state.json')
}

async function showRequirementsFailure(result: RequirementsResult): Promise<void> {
  await dialog.showMessageBox({
    type: 'error',
    title: 'Verboo Code cannot start',
    message: 'This Verboo Code build is not ready to run on this Mac.',
    detail: [
      'Required checks failed:',
      ...result.fatalMessages.map(message => `- ${message}`),
      '',
      'Install the Apple Silicon build again. Node.js, npm, and a global Verboo CLI are not required for the packaged app.',
    ].join('\n'),
  })
}

function pass(id: string, label: string, required: boolean, message: string): RequirementCheck {
  return { id, label, required, message, status: 'pass' }
}

function warn(id: string, label: string, required: boolean, message: string): RequirementCheck {
  return { id, label, required, message, status: 'warn' }
}

function fail(id: string, label: string, required: boolean, message: string): RequirementCheck {
  return { id, label, required, message, status: 'fail' }
}
