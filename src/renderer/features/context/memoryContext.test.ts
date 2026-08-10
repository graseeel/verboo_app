import { describe, expect, it } from 'vitest'
import type { ChatStore, UserSettings } from '../../../shared/types'
import { buildMemoryContext } from './memoryContext'

const settings = {
  memoriesEnabled: true,
  ignoreToolChatsForMemory: false,
} as UserSettings

describe('buildMemoryContext', () => {
  it('excludes local-only provider account activity from model memory', () => {
    const store = {
      version: 4,
      projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', createdAt: 1, updatedAt: 1, collapsed: false }],
      conversations: [
        {
          id: 'chat-current', title: 'Current', projectId: 'project-1', items: [],
          createdAt: 1, updatedAt: 2, lastTurnEndedAt: 2, subagents: [],
        },
        {
          id: 'chat-related', title: 'Related', projectId: 'project-1',
          items: [
            { id: 'activity', role: 'system', kind: 'activity', localOnly: true, text: 'Conta alterada para Codex 2', timestamp: 2 },
            { id: 'user', role: 'user', text: 'Continue a tarefa', timestamp: 1 },
          ],
          createdAt: 1, updatedAt: 1, lastTurnEndedAt: 1, subagents: [],
        },
      ],
    } as ChatStore

    expect(buildMemoryContext(store, 'chat-current', settings)).toBe('Chat: Related\nuser: Continue a tarefa')
  })
})
