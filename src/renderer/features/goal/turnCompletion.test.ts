/**
 * D-C: the turn-completion ORDERING contract (the field-test race).
 *
 * Before the fix, the App's done handler resolved the goal turn deferred
 * SYNCHRONOUSLY while appendTurnSummary was still awaiting its IPC — the
 * scheduler's continuation then stamped the batch progress line onto a
 * `${turnId}:summary` item that did not exist yet, and the stamp
 * returned SILENTLY, never retrying. These tests pin:
 *   1. the deferred resolves ONLY AFTER the summary settles;
 *   2. cleanup runs BEFORE resolution;
 *   3. a summary FAILURE still resolves (the loop never hangs);
 *   4. the end-to-end repro: stamp-after-summary lands the line, while
 *      the OLD order loses it — and the loss is now LOGGED, not silent.
 */
import { describe, expect, it } from 'vitest'
import type { GoalState, StoredConversation, TranscriptItem } from '../../../shared/types'
import { createTranslator } from '../../i18n'
import { settleGoalTurnAfterSummary } from './turnCompletion'
import { stampBatchProgressLine } from './progressStamp'

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('settleGoalTurnAfterSummary — ordering contract', () => {
  it('resolves ONLY AFTER the summary settles; cleanup runs before resolution', async () => {
    let resolveSummary!: () => void
    const summary = new Promise<void>(resolve => { resolveSummary = resolve })
    const order: string[] = []

    settleGoalTurnAfterSummary(summary, {
      cleanup: () => order.push('cleanup'),
      resolveGoalTurn: () => order.push('resolve'),
    })

    // The pre-D-C bug resolved HERE, synchronously. Pin the absence.
    expect(order).toEqual([])

    resolveSummary()
    await flush()
    expect(order).toEqual(['cleanup', 'resolve'])
  })

  it('a REJECTED summary still resolves — the goal loop must never hang on a summary failure', async () => {
    const summary = Promise.reject(new Error('IPC down'))
    const order: string[] = []

    settleGoalTurnAfterSummary(summary, {
      cleanup: () => order.push('cleanup'),
      resolveGoalTurn: () => order.push('resolve'),
    })

    await flush()
    expect(order).toEqual(['cleanup', 'resolve'])
  })
})

describe('D-C repro — stamp-after-summary, with contrafactual', () => {
  function makeHarness() {
    const items: TranscriptItem[] = []
    const conv = { id: 'conv-1', items, updatedAt: 0 } as unknown as StoredConversation
    const updates: StoredConversation[] = []
    const failures: string[] = []
    const goal = {
      ownerConversationId: 'conv-1',
      lastTurnId: 'turn-1',
    } as unknown as GoalState
    const stamp = () =>
      stampBatchProgressLine({
        goal,
        fallbackConversationId: undefined,
        batchProgress: { current: 2, total: 3 },
        conversations: [conv],
        updateConversation: (_id, updater) => {
          updates.push(updater(conv))
        },
        t: createTranslator('en-US'),
        onStampFailure: message => failures.push(message),
      })
    // Mirrors appendTurnSummary: the item appears only AFTER an await.
    const appendSummary = async () => {
      await flush()
      items.push({
        id: 'turn-1:summary',
        role: 'system',
        kind: 'summary',
        text: 'Worked for 3s',
        timestamp: Date.now(),
      })
    }
    return { items, updates, failures, stamp, appendSummary }
  }

  it('FIXED ORDER: deferred resolves after the summary → the stamp finds the item and lands the line', async () => {
    const { updates, failures, stamp, appendSummary } = makeHarness()

    settleGoalTurnAfterSummary(appendSummary(), {
      cleanup: () => {},
      resolveGoalTurn: stamp, // the scheduler's continuation
    })
    await flush()
    await flush()

    expect(failures).toEqual([]) // no failure logged…
    expect(updates).toHaveLength(1) // …because the item existed when stamping
    const stamped = updates[0].items.find(i => i.id === 'turn-1:summary')
    expect(stamped?.progressLine).toBe('Task 2 of 3')
  })

  it('CONTRAFACTUAL — the OLD order: stamping before the summary settles LOSES the line, and the loss is LOGGED', async () => {
    const { updates, failures, stamp, appendSummary } = makeHarness()

    // Pre-D-C behavior: resolve (stamp) synchronously, summary still in flight.
    void appendSummary()
    stamp()

    expect(updates).toHaveLength(0) // the line is lost…
    expect(failures).toHaveLength(1) // …but NEVER silently again
    expect(failures[0]).toContain('turn-1:summary')
    expect(failures[0]).toContain('conv-1')
  })
})
