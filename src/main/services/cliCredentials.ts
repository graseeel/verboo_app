import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'

const KEYCHAIN_SERVICE = 'Verboo Code-credentials'
const OAUTH_TOKEN_URL = 'https://code.verboo.ai/oauth/token'
const OAUTH_CLIENT_ID = 'verboo-code-cli'
const DEFAULT_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]
const TOKEN_REFRESH_SKEW_MS = 60_000
const execFileAsync = promisify(execFile)

export type CliOAuthCredentials = {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: number | null
  scopes?: string[]
  subscriptionType?: string | null
  rateLimitTier?: string | null
}

export async function readCliOAuthAccessToken(): Promise<string | undefined> {
  return getCliOAuthAccessToken()
}

export async function getCliOAuthAccessToken(): Promise<string | undefined> {
  const credentials = await readCliOAuthCredentials()
  if (!credentials) return undefined
  if (shouldRefresh(credentials)) {
    return refreshCliOAuthAccessToken()
  }
  return credentials.accessToken
}

export async function refreshCliOAuthAccessToken(): Promise<string | undefined> {
  const blob = await readCliCredentialsBlob()
  const credentials = normalizeOAuthCredentials(blob?.verbooOauth)
  if (!blob || !credentials?.refreshToken) return undefined

  try {
    const refreshed = await refreshOAuthCredentials(credentials)
    await writeCliCredentialsBlob({
      ...blob,
      verbooOauth: {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? credentials.refreshToken,
        expiresAt: refreshed.expiresAt,
        scopes: refreshed.scopes ?? credentials.scopes,
        subscriptionType: refreshed.subscriptionType ?? credentials.subscriptionType ?? null,
        rateLimitTier: refreshed.rateLimitTier ?? credentials.rateLimitTier ?? null,
      },
    })
    return refreshed.accessToken
  } catch {
    return undefined
  }
}

async function readCliOAuthCredentials(): Promise<CliOAuthCredentials | undefined> {
  const blob = await readCliCredentialsBlob()
  return normalizeOAuthCredentials(blob?.verbooOauth)
}

async function readCliCredentialsBlob(): Promise<Record<string, unknown> | undefined> {
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
    return parsed
  } catch {
    return undefined
  }
}

async function writeCliCredentialsBlob(blob: Record<string, unknown>): Promise<void> {
  if (process.platform !== 'darwin') return

  const account = process.env.USER || userInfo().username
  const payload = Buffer.from(JSON.stringify(blob), 'utf8').toString('hex')
  await execFileAsync('/usr/bin/security', [
    'add-generic-password',
    '-U',
    '-a',
    account,
    '-s',
    KEYCHAIN_SERVICE,
    '-X',
    payload,
  ], { timeout: 5_000, maxBuffer: 16_384 })
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

async function refreshOAuthCredentials(credentials: CliOAuthCredentials): Promise<CliOAuthCredentials> {
  if (!credentials.refreshToken) {
    throw new Error('No refresh token available.')
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope: (credentials.scopes?.length ? credentials.scopes : DEFAULT_OAUTH_SCOPES).join(' '),
  })
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!response.ok) {
    throw new Error(`OAuth refresh failed: HTTP ${response.status}`)
  }

  const payload = await response.json() as unknown
  if (!isRecord(payload)) throw new Error('OAuth refresh response is invalid.')

  const accessToken = stringValue(payload.access_token)
  if (!accessToken) throw new Error('OAuth refresh response did not include an access token.')

  const expiresIn = numberValue(payload.expires_in)
  return {
    accessToken,
    refreshToken: stringValue(payload.refresh_token) ?? credentials.refreshToken,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : credentials.expiresAt,
    scopes: parseScopes(stringValue(payload.scope)) ?? credentials.scopes,
    subscriptionType: credentials.subscriptionType,
    rateLimitTier: credentials.rateLimitTier,
  }
}

function normalizeOAuthCredentials(value: unknown): CliOAuthCredentials | undefined {
  if (!isRecord(value)) return undefined
  const accessToken = stringValue(value.accessToken)
  if (!accessToken) return undefined
  return {
    accessToken,
    refreshToken: stringValue(value.refreshToken) ?? null,
    expiresAt: numberValue(value.expiresAt) ?? null,
    scopes: stringArray(value.scopes),
    subscriptionType: stringValue(value.subscriptionType) ?? null,
    rateLimitTier: stringValue(value.rateLimitTier) ?? null,
  }
}

function shouldRefresh(credentials: CliOAuthCredentials): boolean {
  return Boolean(credentials.refreshToken && credentials.expiresAt && Date.now() >= credentials.expiresAt - TOKEN_REFRESH_SKEW_MS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return values.length ? values : undefined
}

function parseScopes(scope: string | undefined): string[] | undefined {
  const scopes = scope?.split(/\s+/).filter(Boolean)
  return scopes?.length ? scopes : undefined
}
