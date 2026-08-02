/**
 * T2: the batch STATE MATRIX and the global K guard — one test per row.
 *
 *   1  complete WITH evidence   → task done, batch active, advance i+1
 *   2  complete WITHOUT evidence → task running, no-progress ring (T1)
 *   3  continue                  → task running, next turn same task
 *   4  pause needsUser           → task blocked, batch paused, resumable
 *   5  pause unsafe              → task failed, batch PAUSED, whole batch
 *   6  infraError below max      → task running, retry (existing)
 *   7  infraError AT max         → task failed, batch paused (existing)
 *   8  LOOP detected             → task failed, batch STAYS ACTIVE, advance
 *   9  K consecutive failures    → batch paused, pauseReason batchStagnation
 *  10  user pauses               → frozen, resumable
 *  11  user cancels              → batch cancelled, end
 *  12  USER SKIPS blocked task   → task skipped, batch active, advance,
 *                                  NEVER feeds K (user intent ≠ system health)
 *  13  LAST task reaches terminal → batch completed (beats K: nothing
 *                                  left to pause FOR)
 *
 *  D-D pause taskImpossible      → task blocked (NEVER failed —
 *                                  resumability depends on it), batch
 *                                  paused, K untouched; reply resumes
 *                                  the SAME task.
 *
 * K = 2 (BATCH_STAGNATION_K): counts only CONSECUTIVE failed tasks,
 * resets on any done, is TRANSPARENT to skips, and is bypassed by
 * unsafe/infraError-at-max (those pause on the FIRST occurrence —
 * they already are systemic diagnoses).
 */

import { describe, it, expect } from 'vitest'
import type { GoalEvaluationResult, GoalState, GoalTask, TranscriptItem } from '../../../shared/types'
import type { Translator } from '../../i18n'
import { createTranslator } from '../../i18n'
import { runGoalCycle, BATCH_STAGNATION_K, MAX_EVALUATION_ERRORS, type GoalSchedulerDelegate } from './goalScheduler'
import { createGoalState, skipBlockedGoalTask } from './goalState'
import { buildGoalUsageLine } from './goalPrompt'
import { buildBatchReportLines } from './goalReport'

const t: Translator = ((key: string, params?: Record<string, unknown>) => {
  if (!params) return key
  return key + ':' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')
}) as Translator

function makeEval(overrides: Partial<GoalEvaluationResult> = {}): GoalEvaluationResult {
  return {
    decision: 'continue',
    reasonId: 'taskIncomplete',
    reason: 'Still working',
    sessionSummary: 'Made progress.',
    gaps: [],
    nextAction: 'Keep going',
    confidence: 0.8,
    ...overrides,
  }
}

const COMPLETE = makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' })
const CONTINUE = makeEval() // identical content on purpose: feeds the loop detector
const NEEDS_USER = makeEval({ decision: 'pause', reasonId: 'needsUser', reason: 'Need the user.' })
const UNSAFE = makeEval({ decision: 'pause', reasonId: 'unsafe', reason: 'Unsafe operation.' })

function activity(
  activityKind: NonNullable<TranscriptItem['activityKind']>,
  timestamp: number,
): TranscriptItem {
  return {
    id: `activity:${activityKind}:${timestamp}:${crypto.randomUUID()}`,
    role: 'assistant',
    text: '',
    timestamp,
    kind: 'activity',
    activityKind,
  }
}

type MatrixDelegate = GoalSchedulerDelegate & {
  goal: GoalState
  items: TranscriptItem[]
  evaluations: (GoalEvaluationResult | Error)[]
  evaluationIndex: number
  evalCalls: number
  capturedObjectives: string[]
  goalHistory: GoalState[]
  continueCalls: { nextMessage: string }[]
  onCompleteCalls: number
  /** D-B: the goals onComplete received, in order (report content proof). */
  completedGoals: GoalState[]
  statusChanges: unknown[]
  logs: string[]
  /** Test hook ran inside continueGoal: simulate the turn producing
   *  transcript activity, or the USER pausing/cancelling mid-turn. */
  onContinueTurn?: () => void
}

function makeDelegate(
  goal: GoalState,
  evaluations: (GoalEvaluationResult | Error)[],
  items: TranscriptItem[] = [],
): MatrixDelegate {
  const delegate: MatrixDelegate = {
    goal,
    items,
    evaluations,
    evaluationIndex: 0,
    evalCalls: 0,
    capturedObjectives: [],
    goalHistory: [],
    continueCalls: [],
    onCompleteCalls: 0,
    completedGoals: [],
    statusChanges: [],
    logs: [],
    getGoal: () => delegate.goal,
    updateGoal: (update) => {
      delegate.goal = typeof update === 'function' ? update(delegate.goal) : update
      delegate.goalHistory.push(delegate.goal)
    },
    evaluateGoal: async (snapshot) => {
      delegate.evalCalls++
      delegate.capturedObjectives.push(snapshot.objective)
      const entry =
        delegate.evaluations[delegate.evaluationIndex] ??
        delegate.evaluations[delegate.evaluations.length - 1]
      delegate.evaluationIndex++
      if (entry instanceof Error) throw entry
      return entry
    },
    getConversationItems: () => delegate.items,
    continueGoal: async (_goal, nextMessage) => {
      delegate.continueCalls.push({ nextMessage })
      // Mirrors the App.tsx wiring (T1): global and per-task counters
      // increment together when a turn runs.
      delegate.goal = {
        ...delegate.goal,
        turnsRun: delegate.goal.turnsRun + 1,
        ...(delegate.goal.turnsRunThisTask !== undefined
          ? { turnsRunThisTask: delegate.goal.turnsRunThisTask + 1 }
          : {}),
      }
      delegate.onContinueTurn?.()
      return 'session-x'
    },
    abortTurn: () => {},
    onStatusChange: (status) => {
      delegate.statusChanges.push(status)
    },
    onLog: (message) => {
      delegate.logs.push(message)
    },
    onComplete: (g) => {
      delegate.onCompleteCalls++
      delegate.completedGoals.push(g)
    },
    t,
  }
  return delegate
}

function makeBatchGoal(...taskTexts: string[]): GoalState {
  const goal = createGoalState({
    objective: 'Ship the batch',
    accessMode: 'approval',
    workingDirectory: '/tmp/project',
    skills: [],
    tasks: taskTexts.map(text => ({ text })),
  })
  goal.ownerConversationId = 'conv-owner'
  return goal
}

/** What the App's resume path does (App.tsx:~3006): reactivate the goal
 *  and reset the cycle guards. The scheduler's cycle-start normalization
 *  handles the task-level 'blocked' → 'active' restoration. */
function simulateUserResume(delegate: MatrixDelegate): void {
  delegate.goal = {
    ...delegate.goal,
    status: 'active',
    noProgressCount: 0,
    errorCount: 0,
    recentFingerprints: [],
  }
}

/** Every turn produces real action evidence (a 'command' activity). */
function produceCommandEvidence(delegate: MatrixDelegate): void {
  delegate.onContinueTurn = () => {
    delegate.items.push(activity('command', Date.now()))
  }
}

// ─── Row 1 ───────────────────────────────────────────────────────────
describe('T2 row 1 — complete WITH evidence: task done, batch active, advance with boundary', () => {
  it('stamps done, activates i+1 with startedAt, resets the counters, and the batch never pauses', async () => {
    const goal = makeBatchGoal('Task one', 'Task two')
    const delegate = makeDelegate(goal, [COMPLETE, COMPLETE], [activity('edit', goal.startedAt ?? 0)])
    produceCommandEvidence(delegate)

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    const boundary = delegate.goalHistory.find(state => state.taskIndex === 1)
    expect(boundary).toBeDefined()
    expect(boundary?.tasks?.[0].status).toBe('done')
    expect(boundary?.tasks?.[0].completedAt).toBeTypeOf('number')
    expect(boundary?.tasks?.[1].status).toBe('active')
    expect(boundary?.tasks?.[1].startedAt).toBeTypeOf('number')
    expect(boundary?.turnsRunThisTask).toBe(0)
    expect(boundary?.status).not.toBe('paused')
    expect(boundary?.consecutiveFailedTasks).toBe(0) // done resets K
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['done', 'done'])
  })
})

// ─── Row 2 ───────────────────────────────────────────────────────────
describe('T2 row 2 — complete WITHOUT evidence: no-progress, same task (T1 non-regression)', () => {
  it('the task stays active and running, the deterministic fingerprint feeds the ring, and real work later completes it', async () => {
    const goal = makeBatchGoal('Only task')
    const delegate = makeDelegate(goal, [
      COMPLETE, // rejected: 0 turns
      COMPLETE, // accepted: 1 turn + evidence
    ])
    produceCommandEvidence(delegate)

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    // The rejection kept the SAME task active and fed the ring.
    const rejected = delegate.goalHistory.find(state =>
      state.recentFingerprints.includes('d1:complete-rejected-no-evidence:task:0'),
    )
    expect(rejected).toBeDefined()
    expect(rejected?.taskIndex).toBe(0)
    expect(rejected?.tasks?.[0].status).toBe('active')
    expect(delegate.continueCalls[0].nextMessage).toContain('Only task')
    expect(delegate.continueCalls[0].nextMessage).toContain('action-evidence guard')
    expect(delegate.goal.tasks?.[0].status).toBe('done')
  })
})

// ─── Row 3 ───────────────────────────────────────────────────────────
describe('T2 row 3 — continue: task running, next turn of the SAME task', () => {
  it('continue re-anchors on the same task and never moves the pointer', async () => {
    const goal = makeBatchGoal('Build it', 'Test it')
    const delegate = makeDelegate(goal, [CONTINUE, COMPLETE, COMPLETE])
    produceCommandEvidence(delegate)

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    // Evaluations 1 and 2 both targeted task 1 (the second after a real
    // turn); task 2 was only evaluated after task 1 completed.
    expect(delegate.capturedObjectives).toEqual(['Build it', 'Build it', 'Test it'])
    expect(delegate.continueCalls[0].nextMessage).toContain('Build it')
    const duringTask1 = delegate.goalHistory.filter(state => state.taskIndex === 0)
    for (const state of duringTask1) {
      expect(state.tasks?.[0].status).toBe('active')
    }
  })
})

// ─── Row 4 ───────────────────────────────────────────────────────────
describe('T2 row 4 — pause needsUser: task blocked, batch paused, waits for the user', () => {
  it('blocks only the current task, pauses the batch, and resume restores blocked → active and finishes', async () => {
    const goal = makeBatchGoal('Needs input', 'Second task')
    const delegate = makeDelegate(goal, [
      NEEDS_USER,
      COMPLETE, // after resume: task 1 completes (evidence present)
      COMPLETE, // task 2 completes
    ], [activity('edit', goal.startedAt ?? 0)])
    produceCommandEvidence(delegate)

    const firstRun = await runGoalCycle(delegate)

    expect(firstRun).toBe('paused')
    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('needsUser')
    expect(delegate.goal.tasks?.[0].status).toBe('blocked') // a QUESTION, not a failure
    expect(delegate.goal.tasks?.[1].status).toBe('pending')
    expect(delegate.continueCalls.length).toBe(0) // frozen: no further turns

    // User resolves the question and resumes (App's resume path).
    simulateUserResume(delegate)
    const secondRun = await runGoalCycle(delegate)

    expect(secondRun).toBe('completed')
    // Cycle-start normalization restored the blocked task to active…
    const restored = delegate.goalHistory.find(
      state => state.tasks?.[0].status === 'active' && state.taskIndex === 0 &&
        delegate.goalHistory.indexOf(state) > 0,
    )
    expect(restored).toBeDefined()
    // …and the batch ran to completion.
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['done', 'done'])
  })
})

// ─── D-D: pause taskImpossible — task BLOCKED, never FAILED ─────────
describe('D-D — pause taskImpossible: task blocked (resumable), batch paused, K untouched', () => {
  const TASK_IMPOSSIBLE = makeEval({
    decision: 'pause',
    reasonId: 'taskImpossible',
    reason: 'The URL uses the reserved .invalid TLD — no fetch can ever succeed.',
  })

  it('stamps the task blocked and NEVER failed — the whole reply-to-resume flow depends on it', async () => {
    // The defect this prevents: without taskImpossible in shouldPause
    // the verdict fell through to continue SILENTLY; and stamped failed
    // (like unsafe) it would be unrecoverable — a failed task does not
    // come back.
    const goal = makeBatchGoal('Fetch the data', 'Second task')
    const delegate = makeDelegate(goal, [
      TASK_IMPOSSIBLE,
      COMPLETE, // after the user's reply resumes: task 1 completes
      COMPLETE, // task 2 completes
    ], [activity('edit', goal.startedAt ?? 0)])
    produceCommandEvidence(delegate)

    const firstRun = await runGoalCycle(delegate)

    expect(firstRun).toBe('paused')
    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('taskImpossible')
    expect(delegate.goal.tasks?.[0].status).toBe('blocked') // waiting for the user — RESUMABLE
    expect(delegate.goal.tasks?.[1].status).toBe('pending')
    expect(delegate.continueCalls.length).toBe(0) // frozen: no further turns
    // K UNTOUCHED: blocked is not failed — the environment is fine, the
    // task is impossible; nothing systemic to count.
    expect(delegate.goal.consecutiveFailedTasks ?? 0).toBe(0)
    // COUNTERFACTUAL sweep of the WHOLE history: the task was never
    // stamped failed at any point (failed would kill resumability).
    for (const state of delegate.goalHistory) {
      expect(state.tasks?.[0].status).not.toBe('failed')
    }

    // The user replies in the composer and the goal resumes (App path):
    // cycle-start normalization reactivates the SAME task…
    simulateUserResume(delegate)
    const secondRun = await runGoalCycle(delegate)

    expect(secondRun).toBe('completed')
    // …the SAME task (taskIndex was NOT advanced — no skip, no loss)…
    const advancedWhileBlocked = delegate.goalHistory.some(
      state => state.tasks?.[0].status === 'blocked' && (state.taskIndex ?? 0) > 0,
    )
    expect(advancedWhileBlocked).toBe(false)
    // …and the batch ran to completion.
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['done', 'done'])
  })

  it('a LEGACY single-task goal pauses the same way (no tasks array — nothing to stamp, no crash)', async () => {
    const goal = createGoalState({
      objective: 'Fetch from a .invalid TLD',
      accessMode: 'approval',
      workingDirectory: '/tmp/project',
      skills: [],
    })
    goal.ownerConversationId = 'conv-owner'
    const delegate = makeDelegate(goal, [TASK_IMPOSSIBLE])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('paused')
    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('taskImpossible')
    expect(delegate.goal.tasks).toBeUndefined()
    expect(delegate.continueCalls.length).toBe(0)
  })
})

// ─── Row 5 (embedded acceptance: unsafe stops the WHOLE batch) ───────
describe('T2 row 5 — pause unsafe: task failed, batch PAUSED, the whole batch stops (K bypass)', () => {
  it('stops everything on the FIRST occurrence — safety is not per-task', async () => {
    const goal = makeBatchGoal('Task one', 'Task two', 'Task three')
    const delegate = makeDelegate(goal, [UNSAFE])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('paused')
    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('unsafe')
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'pending', 'pending'])
    // The whole batch stopped: exactly ONE evaluation, no turn, no advance.
    expect(delegate.evalCalls).toBe(1)
    expect(delegate.continueCalls.length).toBe(0)
    expect(delegate.goal.taskIndex).toBe(0)
    // K BYPASS: paused on the FIRST occurrence — unsafe does not wait
    // for a second strike because it already IS a systemic diagnosis.
    expect(delegate.goal.consecutiveFailedTasks ?? 0).toBe(0)
  })
})

// ─── Row 6 ───────────────────────────────────────────────────────────
describe('T2 row 6 — infraError BELOW max: task running, batch active, retry (existing behavior)', () => {
  it('a transient evaluator failure retries without ever failing the task', async () => {
    const goal = makeBatchGoal('Only task')
    const delegate = makeDelegate(goal, [
      new Error('CLI timeout'),
      COMPLETE, // after the retry — rejected: 0 turns
      COMPLETE, // accepted
    ])
    produceCommandEvidence(delegate)

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.goal.tasks?.[0].status).toBe('done')
    // The task was NEVER marked failed/blocked during the retry.
    for (const state of delegate.goalHistory) {
      expect(state.tasks?.[0].status).not.toBe('failed')
      expect(state.tasks?.[0].status).not.toBe('blocked')
    }
    // And the error counter reset after the successful evaluation.
    expect(delegate.goal.errorCount ?? 0).toBe(0)
  })
})

// ─── Row 7 ───────────────────────────────────────────────────────────
describe('T2 row 7 — infraError AT max: task failed, batch paused (existing behavior, K bypass)', () => {
  it('pauses the batch at MAX_EVALUATION_ERRORS and marks the task failed', async () => {
    const goal = makeBatchGoal('Only task', 'Never reached')
    const delegate = makeDelegate(goal, [new Error('CLI timeout')])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('paused')
    expect(delegate.evalCalls).toBe(MAX_EVALUATION_ERRORS)
    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('infraError')
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'pending'])
    // K BYPASS: the pause is immediate at the error max — it does not
    // go through the consecutive-failure counter.
    expect(delegate.goal.consecutiveFailedTasks ?? 0).toBe(0)
  }, 20_000) // real backoff sleeps (1s + 2s)
})

// ─── Row 8 (embedded acceptance: loop kills the task, batch advances) ─
describe('T2 row 8 — LOOP detected: task failed, batch STAYS ACTIVE, advance to i+1', () => {
  it('one stuck task does not drag the batch: failed alone, the rest completes', async () => {
    const goal = makeBatchGoal('Stuck task', 'Fine task', 'Last task')
    const delegate = makeDelegate(goal, [
      CONTINUE, CONTINUE, CONTINUE, // task 1 loops (identical fingerprints ×3)
      CONTINUE, // task 2 works a turn
      COMPLETE, // task 2 done
      CONTINUE, // task 3 works a turn
      COMPLETE, // task 3 done
    ])
    produceCommandEvidence(delegate)

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'done', 'done'])
    // The batch CONTINUED evaluating after the loop kill — the 4th
    // evaluation already targeted task 2 (the cycle never exited).
    expect(delegate.capturedObjectives).toEqual([
      'Stuck task', 'Stuck task', 'Stuck task',
      'Fine task',
      'Fine task',
      'Last task',
      'Last task',
    ])
    // The batch NEVER blocked and NEVER paused on the way.
    for (const state of delegate.goalHistory) {
      expect(state.status).not.toBe('blocked')
      expect(state.status).not.toBe('paused')
    }
    // The kill cleaned up after itself: ring cleared, counter reset…
    const afterKill = delegate.goalHistory.find(
      state => state.taskIndex === 1 && state.tasks?.[0].status === 'failed',
    )
    expect(afterKill?.recentFingerprints).toEqual([])
    expect(afterKill?.noProgressCount).toBe(0)
    expect(afterKill?.turnsRunThisTask).toBe(0)
    expect(afterKill?.consecutiveFailedTasks).toBe(1) // K = 1…
    expect(delegate.goal.consecutiveFailedTasks).toBe(0) // …reset by the done
  })
})

// ─── Row 9 (embedded acceptance: the K guard) ────────────────────────
describe('T2 row 9 — K consecutive failures: batch paused with batchStagnation', () => {
  it('two consecutive loop failures pause the batch BEFORE starting task 3 — pause, not cancel', async () => {
    expect(BATCH_STAGNATION_K).toBe(2) // the documented constant
    const goal = makeBatchGoal('Stuck one', 'Stuck two', 'Never started')
    const delegate = makeDelegate(goal, [
      CONTINUE, CONTINUE, CONTINUE, // task 1 loops → failed, advance (K=1)
      CONTINUE, CONTINUE, CONTINUE, // task 2 loops → failed (K=2) → PAUSE
    ])

    const result = await runGoalCycle(delegate)

    // Paused, NOT cancelled: resumable by design (pause costs a click).
    expect(result).toBe('paused')
    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('batchStagnation')
    expect(delegate.goal.pausedAt).toBeTypeOf('number')
    expect(delegate.goal.consecutiveFailedTasks).toBe(2)
    // The pointer was advanced past the failed task so a RESUME starts
    // task 3 — but task 3 was never evaluated (the pause came first).
    expect(delegate.goal.taskIndex).toBe(2)
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'failed', 'active'])
    expect(delegate.evalCalls).toBe(6)
    for (const objective of delegate.capturedObjectives) {
      expect(objective).not.toBe('Never started')
    }
    // The batch was still ACTIVE between the two failures (K=1 did not
    // pause) — the guard fires exactly at K=2.
    const between = delegate.goalHistory.find(
      state => state.taskIndex === 1 && state.tasks?.[0].status === 'failed',
    )
    expect(between?.status).not.toBe('paused')
    expect(between?.consecutiveFailedTasks).toBe(1)
    expect(delegate.logs.some(m => m.startsWith('Batch stagnation: 2 consecutive task failures'))).toBe(true)
    // The status bar heard the machine-readable reason (i18n key is T4's).
    expect(delegate.statusChanges.some(
      s => typeof s === 'object' && s !== null && (s as { reason?: string }).reason === 'batchStagnation',
    )).toBe(true)
  })

  it('K RESETS on any done: fail → done → fail stays at 1 and never pauses', async () => {
    const goal = makeBatchGoal('Stuck', 'Works', 'Stuck again', 'Works too')
    const delegate = makeDelegate(goal, [
      CONTINUE, CONTINUE, CONTINUE, // task 1 loops → failed (K=1)
      CONTINUE, COMPLETE, // task 2 works and completes (K=0)
      CONTINUE, CONTINUE, CONTINUE, // task 3 loops → failed (K=1, NOT 2)
      CONTINUE, COMPLETE, // task 4 works and completes
    ])
    produceCommandEvidence(delegate)

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'done', 'failed', 'done'])
    expect(delegate.goal.consecutiveFailedTasks).toBe(0)
    // batchStagnation NEVER happened — if the done had not reset K,
    // task 3's failure would have been the second consecutive one.
    for (const state of delegate.goalHistory) {
      expect(state.pauseReason).not.toBe('batchStagnation')
    }
    expect(result).not.toBe('paused')
  })
})

// ─── Row 10 ──────────────────────────────────────────────────────────
describe('T2 row 10 — user pauses: frozen, resumable', () => {
  it('the batch freezes mid-cycle with the task untouched, then resumes to completion', async () => {
    const goal = makeBatchGoal('Long task')
    const delegate = makeDelegate(goal, [CONTINUE, COMPLETE])
    produceCommandEvidence(delegate)
    // The USER pauses during the first turn (mirrors the App's pause write).
    delegate.onContinueTurn = () => {
      delegate.items.push(activity('command', Date.now()))
      delegate.goal = { ...delegate.goal, status: 'paused', pausedAt: Date.now(), pauseReason: 'userPaused' }
    }

    const firstRun = await runGoalCycle(delegate)

    expect(firstRun).toBe('cancelled') // cycle-exit signal; the GOAL is paused
    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.tasks?.[0].status).toBe('active') // frozen, not failed/blocked

    delegate.onContinueTurn = () => {
      delegate.items.push(activity('command', Date.now()))
    }
    simulateUserResume(delegate)
    const secondRun = await runGoalCycle(delegate)

    expect(secondRun).toBe('completed')
    expect(delegate.goal.tasks?.[0].status).toBe('done')
  })
})

// ─── Row 11 ──────────────────────────────────────────────────────────
describe('T2 row 11 — user cancels: batch cancelled, end', () => {
  it('cancel stops the cycle for good — no completion, no task stamps', async () => {
    const goal = makeBatchGoal('Doomed task', 'Never reached')
    const delegate = makeDelegate(goal, [CONTINUE, COMPLETE])
    // The USER cancels during the first turn (mirrors the App's cancel write).
    delegate.onContinueTurn = () => {
      delegate.goal = { ...delegate.goal, status: 'cancelled' }
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('cancelled')
    expect(delegate.goal.status).toBe('cancelled')
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['active', 'pending'])
    expect(delegate.onCompleteCalls).toBe(0)
    // A cancelled cycle does not resume itself: a fresh run exits at the top.
    expect(await runGoalCycle(delegate)).toBe('cancelled')
  })
})

// ─── Row 12 (embedded acceptance: skip never feeds K) ────────────────
describe('T2 row 12 — user SKIPS a blocked task: skipped, batch active, advance, K untouched', () => {
  it('skipBlockedGoalTask: blocked → skipped, batch reactivated, next task activated', async () => {
    const goal = makeBatchGoal('Blocked task', 'Next task')
    const delegate = makeDelegate(goal, [NEEDS_USER, COMPLETE])
    produceCommandEvidence(delegate)

    expect(await runGoalCycle(delegate)).toBe('paused')
    expect(delegate.goal.tasks?.[0].status).toBe('blocked')

    const skipped = skipBlockedGoalTask(delegate.goal, Date.now())
    expect(skipped.tasks?.[0].status).toBe('skipped')
    expect(skipped.tasks?.[0].status).not.toBe('failed') // DISTINCT from failed
    expect(skipped.tasks?.[0].completedAt).toBeTypeOf('number')
    expect(skipped.status).toBe('active') // batch back to active…
    expect(skipped.pauseReason).toBeUndefined()
    expect(skipped.taskIndex).toBe(1) // …advanced to i+1…
    expect(skipped.turnsRunThisTask).toBe(0)
    expect(skipped.tasks?.[1].status).toBe('active')
    expect(skipped.tasks?.[1].startedAt).toBeTypeOf('number')

    // The App restarts the cycle on the skipped state: task 2 runs and completes.
    delegate.goal = skipped
    expect(await runGoalCycle(delegate)).toBe('completed')
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['skipped', 'done'])
  })

  it('K TRANSPARENCY: skip between two failures neither counts nor resets — the second failure still reaches K', async () => {
    const goal = makeBatchGoal('Stuck', 'Skipped by user', 'Stuck too', 'Never started')
    const delegate = makeDelegate(goal, [
      CONTINUE, CONTINUE, CONTINUE, // task 1 loops → failed (K=1)
      NEEDS_USER, // task 2 blocks on the user → batch paused
      CONTINUE, CONTINUE, CONTINUE, // (after skip) task 3 loops → failed (K=2) → PAUSE
    ])

    expect(await runGoalCycle(delegate)).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('needsUser')
    expect(delegate.goal.consecutiveFailedTasks).toBe(1) // K=1 from task 1

    // The user skips task 2. K must NOT move: not incremented (a skip is
    // not a failure) and NOT reset (the failures are still consecutive).
    const skipped = skipBlockedGoalTask(delegate.goal, Date.now())
    expect(skipped.tasks?.[1].status).toBe('skipped')
    expect(skipped.consecutiveFailedTasks).toBe(1)

    delegate.goal = skipped
    simulateUserResume(delegate)
    const result = await runGoalCycle(delegate)

    // If the skip had reset K, task 3's failure would be K=1 and the
    // batch would continue into task 4 — it did NOT.
    expect(result).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('batchStagnation')
    expect(delegate.goal.consecutiveFailedTasks).toBe(2)
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'skipped', 'failed', 'active'])
    for (const objective of delegate.capturedObjectives) {
      expect(objective).not.toBe('Never started')
    }
  })

  it('skipping the LAST task completes the batch (row 13 via skip)', () => {
    const goal = makeBatchGoal('Only task')
    const blocked: GoalState = {
      ...goal,
      status: 'paused',
      pausedAt: Date.now(),
      pauseReason: 'needsUser',
      tasks: goal.tasks?.map(task => ({ ...task, status: 'blocked' as GoalTask['status'] })),
    }
    const skipped = skipBlockedGoalTask(blocked, Date.now())
    expect(skipped.status).toBe('completed')
    expect(skipped.completedAt).toBeTypeOf('number')
    expect(skipped.tasks?.[0].status).toBe('skipped')
    expect(skipped.pauseReason).toBeUndefined()
  })

  it('D-B: the terminal skip notifies onBatchComplete — and the notified goal yields report + usage + elapsed', () => {
    // The field-test defect: the skip path completed the batch with NO
    // completion signal, so the final report never fired. The transition
    // stays pure in its return value; the callback is the seam the
    // (future) skip-button wiring uses to stamp the report.
    const goal = makeBatchGoal('Done one', 'Blocked two')
    goal.startedAt = Date.now() - 45_000
    goal.usedInputTokens = 80_000
    goal.usedOutputTokens = 4_000
    goal.lastTurnId = 'turn-9'
    const blocked: GoalState = {
      ...goal,
      status: 'paused',
      pausedAt: Date.now(),
      pauseReason: 'needsUser',
      tasks: goal.tasks!.map((task, index) =>
        index === 0
          ? { ...task, status: 'done' as GoalTask['status'], turns: 2, evidenceCount: 3 }
          : { ...task, status: 'blocked' as GoalTask['status'] },
      ),
      taskIndex: 1,
      turnsRunThisTask: 1,
    }

    const completed: GoalState[] = []
    const skipped = skipBlockedGoalTask(blocked, Date.now(), undefined, g => completed.push(g))

    // The callback fires EXACTLY once, with the SAME state returned.
    expect(completed).toHaveLength(1)
    expect(completed[0]).toBe(skipped)
    expect(completed[0].status).toBe('completed')

    // The report the user was owed: per-task evidence including the skip,
    // plus the elapsed+tokens line — built from the REAL builders, exactly
    // as the App's onComplete delegate builds them.
    const tEn = createTranslator('en-US')
    const reportLines = buildBatchReportLines(completed[0], tEn)
    expect(reportLines[0]).toBe('Batch report')
    expect(reportLines).toContain('1. Done one — done (turns: 2, actions: 3)')
    expect(reportLines).toContain('2. Blocked two — skipped by you')
    const usageLine = buildGoalUsageLine(completed[0], tEn)
    expect(usageLine).toContain('elapsed time')
    expect(usageLine).toContain('tokens')
  })

  it('D-B CONTRAFACTUAL: skipping a NON-last blocked task does NOT notify — the batch is still running', () => {
    const goal = makeBatchGoal('Blocked one', 'Next two')
    const blocked: GoalState = {
      ...goal,
      status: 'paused',
      pausedAt: Date.now(),
      pauseReason: 'needsUser',
      tasks: goal.tasks!.map((task, index) =>
        index === 0 ? { ...task, status: 'blocked' as GoalTask['status'] } : task,
      ),
      taskIndex: 0,
      turnsRunThisTask: 1,
    }
    const completed: GoalState[] = []
    const skipped = skipBlockedGoalTask(blocked, Date.now(), undefined, g => completed.push(g))

    expect(completed).toHaveLength(0) // no completion, no notification
    expect(skipped.status).toBe('active')
  })

  it('skip is a no-op (same reference) on a non-blocked task or a legacy goal', () => {
    const running = makeBatchGoal('Running task')
    expect(skipBlockedGoalTask(running, Date.now())).toBe(running)
    const legacy = createGoalState({
      objective: 'Legacy',
      accessMode: 'approval',
      workingDirectory: '/tmp',
      skills: [],
    })
    expect(skipBlockedGoalTask(legacy, Date.now())).toBe(legacy)
  })
})

// ─── Row 13 ──────────────────────────────────────────────────────────
describe('T2 row 13 — LAST task reaches terminal state: batch completed', () => {
  it('a loop on the last task completes the batch with the failure recorded — and BEATS the K guard', async () => {
    const goal = makeBatchGoal('Stuck one', 'Stuck two')
    const delegate = makeDelegate(goal, [
      CONTINUE, CONTINUE, CONTINUE, // task 1 loops → failed (K=1), advance
      CONTINUE, CONTINUE, CONTINUE, // task 2 loops → failed (K=2) but LAST → completed
    ])

    const result = await runGoalCycle(delegate)

    // Row 13 beats K: with no tasks left there is nothing to pause FOR.
    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
    expect(delegate.goal.completedAt).toBeTypeOf('number')
    expect(delegate.goal.pauseReason).toBeUndefined()
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'failed'])
    expect(delegate.goal.consecutiveFailedTasks).toBe(2)
  })

  it('D-B: the terminal loop fires onComplete — the received goal yields the per-task report AND the elapsed+tokens line', async () => {
    // The field-test defect: this path completed the batch WITHOUT
    // onComplete, so the user saw no report, no elapsed time, no tokens.
    const goal = makeBatchGoal('Stuck one', 'Stuck two')
    goal.startedAt = Date.now() - 60_000
    goal.usedInputTokens = 120_000
    goal.usedOutputTokens = 6_000
    const delegate = makeDelegate(goal, [
      CONTINUE, CONTINUE, CONTINUE, // task 1 loops → failed (K=1), advance
      CONTINUE, CONTINUE, CONTINUE, // task 2 loops → failed, LAST → completed
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    // EXACTLY once: 0 was the D-B defect; 2 would mean firing on the
    // non-terminal advance too (contrafactual guard).
    expect(delegate.onCompleteCalls).toBe(1)
    const finalGoal = delegate.completedGoals[0]
    expect(finalGoal.status).toBe('completed')
    expect(finalGoal.completedAt).toBeTypeOf('number')
    // G-C13 lesson pinned again: completedAt must be present on the
    // RECEIVED goal even with React's async updater — the usage gate
    // dies silently without it.
    expect(finalGoal.tasks?.map(task => task.status)).toEqual(['failed', 'failed'])

    const tEn = createTranslator('en-US')
    // The final report: every task with its cited evidence (the paper-
    // gate requirement) — both failed by loop, in the real en-US text.
    const reportLines = buildBatchReportLines(finalGoal, tEn)
    expect(reportLines[0]).toBe('Batch report')
    expect(reportLines).toContain('1. Stuck one — failed (Possible loop detected)')
    expect(reportLines).toContain('2. Stuck two — failed (Possible loop detected)')
    // The user's explicit complaint: elapsed time AND tokens.
    const usageLine = buildGoalUsageLine(finalGoal, tEn)
    expect(usageLine).toContain('elapsed time')
    expect(usageLine).toContain('tokens')
  })
})
