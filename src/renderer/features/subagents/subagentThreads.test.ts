import { describe, expect, it } from 'vitest'
import { createConversation } from '../../state/chatStore'
import type { SubagentThreadUpdate } from '../../../shared/types'
import {
  applySubagentThreadUpdate,
  sanitizeSubagentThreads,
} from './subagentThreads'

function update(overrides: Partial<SubagentThreadUpdate> = {}): SubagentThreadUpdate {
  return {
    threadId: 'turn:1:subagent:tool:1',
    toolUseId: 'tool:1',
    label: 'Scout',
    mission: 'Inspect the parser',
    status: 'running',
    event: {
      id: 'event:mission',
      kind: 'mission',
      text: 'Inspect the parser',
      timestamp: 10,
    },
    ...overrides,
  }
}

describe('applySubagentThreadUpdate', () => {
  it('creates a persistent thread without changing transcript ordering metadata', () => {
    const conversation = createConversation()
    const updated = applySubagentThreadUpdate(conversation, 'turn:1', update())

    expect(updated.subagents).toHaveLength(1)
    expect(updated.subagents[0]).toMatchObject({
      id: 'turn:1:subagent:tool:1',
      parentTurnId: 'turn:1',
      toolUseId: 'tool:1',
      label: 'Scout',
      mission: 'Inspect the parser',
      status: 'running',
    })
    expect(updated.items).toEqual(conversation.items)
    expect(updated.lastTurnEndedAt).toBe(conversation.lastTurnEndedAt)
  })

  it('deduplicates stable event IDs and orders out-of-order events', () => {
    const conversation = createConversation()
    const first = applySubagentThreadUpdate(conversation, 'turn:1', update({
      event: { id: 'later', kind: 'status', text: 'Reading', timestamp: 30 },
    }))
    const second = applySubagentThreadUpdate(first, 'turn:1', update({
      event: { id: 'earlier', kind: 'status', text: 'Queued', timestamp: 20 },
    }))
    const duplicate = applySubagentThreadUpdate(second, 'turn:1', update({
      event: { id: 'later', kind: 'status', text: 'Duplicate', timestamp: 40 },
    }))

    expect(duplicate.subagents[0].events.map(event => event.id)).toEqual(['earlier', 'later'])
    expect(duplicate.subagents[0].events[1].text).toBe('Reading')
  })

  it('promotes an identical final message instead of duplicating it', () => {
    const conversation = createConversation()
    const message = applySubagentThreadUpdate(conversation, 'turn:1', update({
      event: { id: 'assistant:1', kind: 'agent-message', text: '# Result', timestamp: 20 },
    }))
    const completed = applySubagentThreadUpdate(message, 'turn:1', update({
      status: 'completed',
      event: { id: 'final:1', kind: 'final', text: '# Result', timestamp: 30 },
    }))

    expect(completed.subagents[0].events).toHaveLength(1)
    expect(completed.subagents[0].events.at(-1)).toMatchObject({
      id: 'assistant:1',
      kind: 'final',
      text: '# Result',
    })
    expect(completed.subagents[0].status).toBe('completed')
  })

  it('keeps full agent markdown but bounds tool results', () => {
    const markdown = `# Report\n\n${'m'.repeat(4_000)}`
    const conversation = createConversation()
    const withMarkdown = applySubagentThreadUpdate(conversation, 'turn:1', update({
      event: { id: 'assistant:long', kind: 'agent-message', text: markdown, timestamp: 20 },
    }))
    const withTool = applySubagentThreadUpdate(withMarkdown, 'turn:1', update({
      event: { id: 'tool:long', kind: 'tool-result', text: 't'.repeat(4_000), timestamp: 30 },
    }))

    expect(withTool.subagents[0].events.find(event => event.id === 'assistant:long')?.text).toBe(markdown)
    expect(withTool.subagents[0].events.find(event => event.id === 'tool:long')?.text.length).toBeLessThan(4_000)
  })

  it('drops duplicated mission messages and isolated thinking markers', () => {
    const conversation = createConversation()
    const withMissionEcho = applySubagentThreadUpdate(conversation, 'turn:1', update({
      event: { id: 'assistant:mission', kind: 'agent-message', text: '  Inspect   the parser  ', timestamp: 20 },
    }))
    const withThinkingMarker = applySubagentThreadUpdate(withMissionEcho, 'turn:1', update({
      event: { id: 'assistant:think', kind: 'agent-message', text: '</think>', timestamp: 30 },
    }))

    expect(withThinkingMarker.subagents[0].events).toEqual([])
  })
})

describe('sanitizeSubagentThreads', () => {
  it('drops malformed entries while preserving valid later threads and strips ANSI', () => {
    const valid = applySubagentThreadUpdate(createConversation(), 'turn:1', update({
      mission: '\u001b[31mInspect\u001b[0m',
      event: { id: 'status:1', kind: 'status', text: '\u001b[32mRunning\u001b[0m', timestamp: 10 },
    })).subagents[0]

    const sanitized = sanitizeSubagentThreads([null, { id: 'broken' }, valid])

    expect(sanitized).toHaveLength(1)
    expect(sanitized[0].mission).toBe('Inspect')
    expect(sanitized[0].events[0].text).toBe('Running')
  })

  it('removes previously persisted mission echoes and isolated thinking markers', () => {
    const valid = applySubagentThreadUpdate(createConversation(), 'turn:1', update()).subagents[0]
    valid.events = [
      { id: 'assistant:mission', kind: 'agent-message', text: 'Inspect the parser', timestamp: 20 },
      { id: 'assistant:think', kind: 'agent-message', text: '<think>', timestamp: 30 },
      { id: 'assistant:result', kind: 'agent-message', text: '# Result', timestamp: 40 },
    ]

    const sanitized = sanitizeSubagentThreads([valid])

    expect(sanitized[0].events).toHaveLength(1)
    expect(sanitized[0].events[0]).toMatchObject({
      id: 'assistant:result',
      kind: 'agent-message',
      text: '# Result',
      timestamp: 40,
    })
  })
})
