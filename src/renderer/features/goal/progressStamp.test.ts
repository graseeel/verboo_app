/**
 * D-C: the batch progress stamp — behavior and NON-SILENCE.
 *
 * The stamp writes "Tarefa k de N" on the latest turn's summary item.
 * The defect class the Maestro called part of D-C: a missing target used
 * to return without a trace. These tests pin what writes, what refuses
 * to write, and — for every failure — that a visible log carries the
 * turnId. Legitimate no-ops (first cycle, already-current line) must
 * stay silent BY DESIGN; both are pinned as NOT logging.
 */
import { describe, expect, it } from 'vitest'
import type { GoalState, StoredConversation, TranscriptItem } from '../../../shared/types'
import { createTranslator } from '../../i18n'
import { stampBatchProgressLine } from './progressStamp'

function makeConversation(items: TranscriptItem[]): StoredConversation {
  return { id: 'conv-1', items, updatedAt: 0 } as unknown as StoredConversation
}

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    ownerConversationId: 'conv-1',
    lastTurnId: 'turn-1',
    ...overrides,
  } as unknown as GoalState
}

function summaryItem(extra: Partial<TranscriptItem> = {}): TranscriptItem {
  return {
    id: 'turn-1:summary',
    role: 'system',
    kind: 'summary',
    text: 'Worked for 3s',
    timestamp: 1,
    ...extra,
  }
}

function makeHarness(conversations: StoredConversation[]) {
  const failures: string[] = []
  const writes: StoredConversation[] = []
  return {
    failures,
    writes,
    stamp: (goal: GoalState | undefined) =>
      stampBatchProgressLine({
        goal,
        fallbackConversationId: undefined,
        batchProgress: { current: 2, total: 5 },
        conversations,
        updateConversation: (_id, updater) => {
          const target = conversations[0]
          writes.push(updater(target))
        },
        t: createTranslator('pt-BR'),
        onStampFailure: message => failures.push(message),
      }),
  }
}

describe('stampBatchProgressLine', () => {
  it('stamps the line on the summary item and leaves every other item untouched', () => {
    const other: TranscriptItem = { id: 'turn-1:text:0', role: 'assistant', text: 'done', timestamp: 0 }
    const conv = makeConversation([other, summaryItem()])
    const harness = makeHarness([conv])

    harness.stamp(makeGoal())

    expect(harness.failures).toEqual([])
    expect(harness.writes).toHaveLength(1)
    const items = harness.writes[0].items
    expect(items.find(i => i.id === 'turn-1:summary')?.progressLine).toBe('Tarefa 2 de 5')
    expect(items.find(i => i.id === 'turn-1:text:0')?.progressLine).toBeUndefined()
  })

  it('missing summary item → LOGS the failure with the turnId and writes NOTHING', () => {
    const conv = makeConversation([{ id: 'turn-1:text:0', role: 'assistant', text: 'x', timestamp: 0 }])
    const harness = makeHarness([conv])

    harness.stamp(makeGoal())

    expect(harness.writes).toHaveLength(0)
    expect(harness.failures).toHaveLength(1)
    expect(harness.failures[0]).toContain('turn-1:summary')
    expect(harness.failures[0]).toContain('conv-1')
  })

  it('missing owner conversation → LOGS and writes NOTHING', () => {
    const harness = makeHarness([])

    harness.stamp(makeGoal())

    expect(harness.writes).toHaveLength(0)
    expect(harness.failures).toHaveLength(1)
    expect(harness.failures[0]).toContain('conv-1')
  })

  it('already-current line → silent no-churn (legitimate no-op must NOT log)', () => {
    const conv = makeConversation([summaryItem({ progressLine: 'Tarefa 2 de 5' })])
    const harness = makeHarness([conv])

    harness.stamp(makeGoal())

    expect(harness.writes).toHaveLength(0)
    expect(harness.failures).toEqual([])
  })

  it('first cycle (no lastTurnId) → silent no-op by design', () => {
    const conv = makeConversation([])
    const harness = makeHarness([conv])

    harness.stamp(makeGoal({ lastTurnId: undefined }))

    expect(harness.writes).toHaveLength(0)
    expect(harness.failures).toEqual([])
  })

  it('a STALE line is replaced (the in-place update the user sees between tasks)', () => {
    const conv = makeConversation([summaryItem({ progressLine: 'Tarefa 1 de 5' })])
    const harness = makeHarness([conv])

    harness.stamp(makeGoal())

    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].items[0].progressLine).toBe('Tarefa 2 de 5')
  })
})
