import { describe, expect, it } from 'vitest'
import type { RuntimeActivity } from '../../../shared/types'
import { registerRuntimeActivity } from './runtimeActivity'

describe('runtime activity transcript registration', () => {
  it('drops Checklist-owned TodoWrite activities and deduplicates a repeated tool_use_id', () => {
    const seenKeys = new Set<string>()
    const seenToolUseIds = new Set<string>()
    const toolUseId = 'call_fa685df1555f47879c165be8'

    const streamStart: RuntimeActivity = {
      key: `${toolUseId}:`,
      label: 'Atualizou tarefas',
      kind: 'planning',
      toolUseId,
    }
    const assistantReplay: RuntimeActivity = {
      ...streamStart,
      key: `${toolUseId}:replayed`,
      todos: [
        { content: 'tarefa A', status: 'pending', activeForm: 'Executando tarefa A' },
        { content: 'tarefa B', status: 'pending', activeForm: 'Executando tarefa B' },
      ],
    }
    const browserStart: RuntimeActivity = {
      key: 'browser-call:',
      label: 'Leu página no Chrome',
      kind: 'browser',
      toolUseId: 'browser-call',
    }
    const browserReplay: RuntimeActivity = {
      ...browserStart,
      key: 'browser-call:replayed',
    }

    expect(registerRuntimeActivity(streamStart, seenKeys, seenToolUseIds)).toBe(false)
    expect(registerRuntimeActivity(assistantReplay, seenKeys, seenToolUseIds)).toBe(false)
    expect(registerRuntimeActivity(browserStart, seenKeys, seenToolUseIds)).toBe(true)
    expect(registerRuntimeActivity(browserReplay, seenKeys, seenToolUseIds)).toBe(false)
  })
})
