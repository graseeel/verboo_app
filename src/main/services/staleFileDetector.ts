import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

type FileSnapshot = {
  mtimeMs: number
  sha256: string
}

export class StaleFileDetector {
  private snapshots = new Map<string, FileSnapshot>()

  private key(conversationId: string, filePath: string): string {
    return `${conversationId}::${filePath}`
  }

  async recordRead(conversationId: string, filePath: string): Promise<void> {
    try {
      const stats = await stat(filePath)
      const content = await readFile(filePath)
      const sha256 = createHash('sha256').update(content).digest('hex')
      this.snapshots.set(this.key(conversationId, filePath), {
        mtimeMs: stats.mtimeMs,
        sha256,
      })
    } catch {
      // File may not exist yet (create operation) — nothing to snapshot
    }
  }

  async recordWrite(conversationId: string, filePath: string): Promise<void> {
    try {
      const stats = await stat(filePath)
      const content = await readFile(filePath)
      const sha256 = createHash('sha256').update(content).digest('hex')
      this.snapshots.set(this.key(conversationId, filePath), {
        mtimeMs: stats.mtimeMs,
        sha256,
      })
    } catch {
      // File may have been deleted after write — nothing to snapshot
    }
  }

  async isStale(conversationId: string, filePath: string): Promise<boolean> {
    const snapshot = this.snapshots.get(this.key(conversationId, filePath))
    if (!snapshot) return false

    try {
      const stats = await stat(filePath)
      if (stats.mtimeMs !== snapshot.mtimeMs) {
        const content = await readFile(filePath)
        const currentSha = createHash('sha256').update(content).digest('hex')
        return currentSha !== snapshot.sha256
      }
      return false
    } catch {
      // File no longer exists — was deleted by another conversation
      return true
    }
  }

  clearConversation(conversationId: string): void {
    const prefix = `${conversationId}::`
    for (const key of this.snapshots.keys()) {
      if (key.startsWith(prefix)) this.snapshots.delete(key)
    }
  }

  dispose(): void {
    this.snapshots.clear()
  }
}
