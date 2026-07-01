import { app, safeStorage } from 'electron'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CredentialStatus } from '../../shared/types'

type StoredCredentials = {
  encryptedApiKey?: string
  apiKeyHint?: string
}

export class CredentialsStore {
  private readonly filePath = join(app.getPath('userData'), 'secure', 'credentials.json')

  async getStatus(): Promise<CredentialStatus> {
    const stored = await this.read()
    const apiKey = this.decryptApiKey(stored)
    return {
      hasApiKey: Boolean(apiKey),
      apiKeyHint: apiKey ? stored.apiKeyHint : undefined,
    }
  }

  async setApiKey(apiKey: string): Promise<CredentialStatus> {
    const clean = apiKey.trim()
    if (!clean) {
      throw new Error('A chave API esta vazia.')
    }

    const encrypted = safeStorage.encryptString(clean).toString('base64')
    const hint = this.createHint(clean)
    await this.write({ encryptedApiKey: encrypted, apiKeyHint: hint })
    return { hasApiKey: true, apiKeyHint: hint }
  }

  async clearApiKey(): Promise<CredentialStatus> {
    await this.write({})
    return { hasApiKey: false }
  }

  async getApiKey(): Promise<string | undefined> {
    const stored = await this.read()
    return this.decryptApiKey(stored)
  }

  private decryptApiKey(stored: StoredCredentials): string | undefined {
    if (!stored.encryptedApiKey) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'))
    } catch {
      return undefined
    }
  }

  private createHint(apiKey: string): string {
    if (apiKey.length <= 10) return 'configurada'
    return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
  }

  private async read(): Promise<StoredCredentials> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      return JSON.parse(raw) as StoredCredentials
    } catch {
      return {}
    }
  }

  private async write(value: StoredCredentials): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    await writeFile(this.filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    await chmod(this.filePath, 0o600)
  }
}
