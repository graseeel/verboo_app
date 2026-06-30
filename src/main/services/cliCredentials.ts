import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'

const KEYCHAIN_SERVICE = 'Verboo Code-credentials'
const execFileAsync = promisify(execFile)

export async function readCliOAuthAccessToken(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined

  const account = process.env.USER || userInfo().username

  try {
    let stdout = account
      ? await readKeychainPassword([
          'find-generic-password',
          '-a',
          account,
          '-w',
          '-s',
          KEYCHAIN_SERVICE,
        ])
      : undefined

    stdout ??= await readKeychainPassword([
      'find-generic-password',
      '-w',
      '-s',
      KEYCHAIN_SERVICE,
    ])

    if (!stdout) return undefined

    const parsed = JSON.parse(stdout.trim()) as unknown
    if (!isRecord(parsed)) return undefined

    const oauth = isRecord(parsed.verbooOauth) ? parsed.verbooOauth : undefined
    return stringValue(oauth?.accessToken)
  } catch {
    return undefined
  }
}

async function readKeychainPassword(args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', args, { timeout: 5_000, maxBuffer: 16_384 })
    return stdout
  } catch (error) {
    if (process.env.VERBOO_DEBUG_KEYCHAIN === '1') {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[verboo:keychain] read failed for args=${args.filter(arg => arg !== KEYCHAIN_SERVICE).join(' ')}: ${message}`)
    }
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
