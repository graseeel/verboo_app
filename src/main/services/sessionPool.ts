import type { AgentEvent, AgentTurnRequest, UserSettings } from '../../shared/types'
import type { AgentEventHandler } from '../runtime/agentRuntime'
import { VerbooCliService } from './verbooCliService'
import type { CredentialsStore } from './credentialsStore'

type CliSession = {
  cli: VerbooCliService
  turnId: string
  startedAt: number
}

export class SessionPool {
  private sessions = new Map<string, CliSession>()

  constructor(private readonly credentials?: CredentialsStore) {}

  async startTurn(
    conversationId: string,
    request: AgentTurnRequest,
    onEvent: AgentEventHandler,
    settings?: UserSettings,
    resumeSessionId?: string,
  ): Promise<string> {
    const existing = this.sessions.get(conversationId)
    if (existing) {
      const turnId = await existing.cli.sendTurn(request, event => {
        onEvent({ ...event, conversationId } as AgentEvent)
      }, settings, resumeSessionId)
      existing.turnId = turnId
      existing.startedAt = Date.now()
      return turnId
    }

    const cli = new VerbooCliService(this.credentials)
    const turnId = await cli.sendTurn(request, event => {
      onEvent({ ...event, conversationId } as AgentEvent)
    }, settings, resumeSessionId)

    this.sessions.set(conversationId, { cli, turnId, startedAt: Date.now() })
    return turnId
  }

  interrupt(conversationId?: string): void {
    if (conversationId) {
      this.sessions.get(conversationId)?.cli.interrupt()
      return
    }
    for (const session of this.sessions.values()) {
      session.cli.interrupt()
    }
  }

  getActiveConversations(): string[] {
    return Array.from(this.sessions.keys())
  }

  removeConversation(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (!session) return
    session.cli.interrupt()
    this.sessions.delete(conversationId)
  }

  dispose(): void {
    for (const [id, session] of this.sessions) {
      session.cli.interrupt()
    }
    this.sessions.clear()
  }
}
