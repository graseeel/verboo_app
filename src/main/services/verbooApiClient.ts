import { getCliOAuthAccessToken, refreshCliOAuthAccessToken } from './cliCredentials'
import type { CredentialsStore } from './credentialsStore'

export type VerbooCredentialSource = 'cli' | 'api-key'
export type VerbooCredentialPreference = 'cli-first' | 'api-key-first'

export type VerbooBearerToken = {
  value: string
  source: VerbooCredentialSource
}

export class VerbooApiClient {
  constructor(private readonly credentials: CredentialsStore) {}

  async getBearerToken(preference: VerbooCredentialPreference = 'cli-first'): Promise<VerbooBearerToken | undefined> {
    const sources =
      preference === 'api-key-first'
        ? [() => this.getApiKeyBearerToken(), () => this.getCliBearerToken()]
        : [() => this.getCliBearerToken(), () => this.getApiKeyBearerToken()]

    for (const source of sources) {
      const token = await source()
      if (token) return token
    }

    return undefined
  }

  async getCliBearerToken(): Promise<VerbooBearerToken | undefined> {
    const value = await getCliOAuthAccessToken()
    return value ? { value, source: 'cli' } : undefined
  }

  async refreshCliBearerToken(): Promise<VerbooBearerToken | undefined> {
    const value = await refreshCliOAuthAccessToken()
    return value ? { value, source: 'cli' } : undefined
  }

  async getApiKeyBearerToken(): Promise<VerbooBearerToken | undefined> {
    const value = await this.credentials.getApiKey()
    return value ? { value, source: 'api-key' } : undefined
  }

  async requestJson(url: string, token: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    })

    if (!response.ok) {
      const body = scrubSensitive((await response.text().catch(() => '')).slice(0, 400)).slice(0, 200)
      throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ''}`)
    }

    return response.json() as Promise<unknown>
  }
}

function scrubSensitive(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9._-]{20,}/g, '[redacted]')
}
