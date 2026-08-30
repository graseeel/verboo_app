/**
 * T3: the COMPACTION FRONTIER between batch tasks.
 *
 * The user's original ask, item 2: the agent COMPACTS between tasks.
 * Protocol (Maestro's order, mandatory order): fire the /compact
 * equivalent, AWAIT the compaction turn's conclusion, and ONLY THEN
 * reset ring / noProgressCount / turnsRunThisTask. The compaction turn
 * alone must NEVER satisfy the next task's D1 action-evidence guard.
 * A failed compaction never blocks the batch — it proceeds WITHOUT
 * compacting and DECLARES the failure (log + compactionFailures).
 *
 * What these tests prove (DISPARO + EFEITO, T2 counterfactual standard):
 *   1. SEQUENCE: the reset NEVER happens before the compact concludes —
 *      asserted DURING the wait (the ring is still populated while the
 *      compact promise is pending) and by strict event order after.
 *   2. D1: a whitelisted activity emitted DURING the compact does not
 *      count as the next task's evidence — the counterfactual is the
 *      evaluation count (without the window re-stamp, the guard would
 *      pass one evaluation EARLIER).
 *   3. FAILURE: compactionFailures increments, the log declares
 *      "WITHOUT compacting", the batch completes — and the ring is
 *      PRESERVED (the transcript did not change, so the loop detector's
 *      baseline stays valid; a success-reset would have emptied it).
 *   4. T3b SCOPE: EVERY task boundary compacts — the done-advance, the
 *      loop-kill advance, and the skip advance (settled at the restarted
 *      cycle). The K-pause does NOT (the batch stops for the user; no
 *      next task starts). A terminal LAST task never compacts.
 *   5. T3b COALESCENCE: a boundary whose LEAVING task ran ZERO turns
 *      does NOT compact — nothing new entered the context since the
 *      last compaction — and the skip is DECLARED in the log, never
 *      silent. Pinned as a counterfactual pair (0 vs ≥1 turns) on both
 *      the skip and the loop-kill paths.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { GoalEvaluationResult, GoalState, TranscriptItem } from '../../../shared/types'
import type { Translator } from '../../i18n'
import { runGoalCycle, type GoalSchedulerDelegate } from './goalScheduler'
import { createGoalState, skipBlockedGoalTask } from './goalState'

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

type FrontierDelegate = GoalSchedulerDelegate & {
  goal: GoalState
  items: TranscriptItem[]
  evaluations: GoalEvaluationResult[]
  evaluationIndex: number
  evalCalls: number
  /** T3: the evaluator receives the PER-TASK snapshot (objective = the
   *  current task's text, turnsRun = turnsRunThisTask) — captured whole
   *  so the frontier tests pin the counter the evaluator actually saw. */
  capturedSnapshots: GoalState[]
  goalHistory: GoalState[]
  continueCalls: { nextMessage: string }[]
  logs: string[]
  /** Test hook ran inside continueGoal: simulate the turn producing (or
   *  NOT producing) transcript evidence. Receives the 1-based call index. */
  onContinueTurn?: (callIndex: number) => void
}

function makeDelegate(
  goal: GoalState,
  evaluations: GoalEvaluationResult[],
  items: TranscriptItem[] = [],
): FrontierDelegate {
  let continueCallIndex = 0
  const delegate: FrontierDelegate = {
    goal,
    items,
    evaluations,
    evaluationIndex: 0,
    evalCalls: 0,
    capturedSnapshots: [],
    goalHistory: [],
    continueCalls: [],
    logs: [],
    getGoal: () => delegate.goal,
    updateGoal: (update) => {
      delegate.goal = typeof update === 'function' ? update(delegate.goal) : update
      delegate.goalHistory.push(delegate.goal)
    },
    evaluateGoal: async (snapshot) => {
      delegate.evalCalls++
      delegate.capturedSnapshots.push(snapshot)
      const entry =
        delegate.evaluations[delegate.evaluationIndex] ??
        delegate.evaluations[delegate.evaluations.length - 1]
      delegate.evaluationIndex++
      return entry
    },
    getConversationItems: () => delegate.items,
    continueGoal: async (_goal, nextMessage) => {
      delegate.continueCalls.push({ nextMessage })
      continueCallIndex++
      // Mirrors the App.tsx wiring (T1): global and per-task counters
      // increment together when a turn runs.
      delegate.goal = {
        ...delegate.goal,
        turnsRun: delegate.goal.turnsRun + 1,
        ...(delegate.goal.turnsRunThisTask !== undefined
          ? { turnsRunThisTask: delegate.goal.turnsRunThisTask + 1 }
          : {}),
      }
      delegate.onContinueTurn?.(continueCallIndex)
      return 'session-x'
    },
    abortTurn: () => {},
    onStatusChange: () => {},
    onLog: (message) => {
      delegate.logs.push(message)
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

function produceCommandEvidence(delegate: FrontierDelegate): void {
  delegate.onContinueTurn = () => {
    delegate.items.push(activity('command', Date.now()))
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('T3 frontier — the reset NEVER happens before the compact concludes', () => {
  it('during the compact wait the ring is still populated and turnsRun untouched; strict order after', async () => {
    const goal = makeBatchGoal('Task one', 'Task two')
    const delegate = makeDelegate(goal, [COMPLETE, COMPLETE])
    produceCommandEvidence(delegate)

    const events: string[] = []
    let resolveCompact: ((ok: boolean) => void) | undefined
    delegate.compactOnTaskBoundary = () => {
      events.push('compact:start')
      return new Promise<boolean>(resolve => {
        resolveCompact = (ok) => {
          events.push('compact:end')
          resolve(ok)
        }
      })
    }

    // Detect the frontier RESET write: the first advanced state
    // (taskIndex 1) with an EMPTY ring. The atomic advance write carries
    // the ring with task 1's evaluation fingerprint — only the
    // post-compact reset clears it, so this marker cannot fire early.
    const baseUpdateGoal = delegate.updateGoal
    delegate.updateGoal = (update) => {
      baseUpdateGoal(update)
      const state = delegate.goal
      if (
        !events.includes('reset:write')
        && state.taskIndex === 1
        && state.turnsRunThisTask === 0
        && state.recentFingerprints.length === 0
      ) {
        events.push('reset:write')
      }
    }

    const cyclePromise = runGoalCycle(delegate)

    // Wait until the frontier is OPEN (the compact was fired)…
    await vi.waitFor(() => {
      expect(events).toContain('compact:start')
    })

    // …and DURING the wait, the reset must NOT have happened:
    expect(events).not.toContain('compact:end')
    expect(events).not.toContain('reset:write')
    // The boundary advance already ran (we are INSIDE the frontier
    // window, not before it)…
    expect(delegate.goal.taskIndex).toBe(1)
    // …but the ring still holds task 1's evaluation history (the D1
    // rejection marker from iteration 1 is in it) — CONTRAFACTUAL: if
    // the reset ran before the compact concluded, the ring would
    // already be empty. It is not.
    expect(delegate.goal.recentFingerprints.length).toBeGreaterThan(0)
    expect(delegate.goal.recentFingerprints).toContain('d1:complete-rejected-no-evidence:task:0')
    // The compact turn was already fired and did NOT increment turnsRun
    // (it goes through runTurn, not continueGoal — maintenance, not
    // task work). Only task 1's real turn has run so far.
    expect(delegate.goal.turnsRun).toBe(1)

    resolveCompact!(true)
    const result = await cyclePromise

    expect(result).toBe('completed')
    // STRICT ORDER: start → end → reset. Nothing else was recorded.
    expect(events).toEqual(['compact:start', 'compact:end', 'reset:write'])
    // The evaluator saw the PER-TASK counter across the frontier:
    // task 1 evaluated with 0 then 1 turns; task 2 evaluated with 1 —
    // its first turn had already run when its first evaluation came.
    // CONTRAFACTUAL: had the frontier NOT reset turnsRunThisTask, task
    // 2's first evaluation would read 2 (task 1's turn + task 2's turn
    // on the same counter). It reads 1 — the counter went back to 0 at
    // the boundary and counted only the new task's turn.
    expect(delegate.capturedSnapshots.map(s => s.objective)).toEqual([
      'Task one', 'Task one', 'Task two',
    ])
    expect(delegate.capturedSnapshots.map(s => s.turnsRun)).toEqual([0, 1, 1])
    expect(delegate.capturedSnapshots.map(s => s.turnsRun)[2]).not.toBe(2)
    // Only the two task turns ran — the compact never counted.
    expect(delegate.goal.turnsRun).toBe(2)
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['done', 'done'])
  })
})

describe('T3 frontier — the compaction turn does NOT satisfy the next task evidence guard', () => {
  it('a whitelisted activity emitted DURING the compact is excluded by the re-opened window', async () => {
    // Controlled clock: the compact activities and the frontier re-stamp
    // must not share a millisecond (the guard's window is `>=`-inclusive).
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const goal = makeBatchGoal('Task one', 'Task two')
    const delegate = makeDelegate(goal, [COMPLETE, COMPLETE, COMPLETE])
    // Evidence policy per turn: task 1's turn produces real evidence;
    // task 2's FIRST turn produces NONE — the compact's own activity is
    // the only "evidence" candidate; the retry turn produces it for real.
    delegate.onContinueTurn = (callIndex) => {
      if (callIndex !== 2) delegate.items.push(activity('command', now))
    }
    delegate.compactOnTaskBoundary = async () => {
      now += 10
      // The compact turn emits a non-whitelisted 'compacting' activity
      // AND — adversarial — a WHITELISTED 'command' activity, both
      // timestamped inside the compaction window.
      delegate.items.push(activity('compacting', now))
      delegate.items.push(activity('command', now))
      now += 10 // the re-stamp reads a LATER clock than the compact activities
      return true
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    // CONTRAFACTUAL via the evaluation count: WITHOUT the window
    // re-stamp, the compact's 'command' activity would fall inside
    // task 2's window (the advance stamped startedAt BEFORE the compact
    // ran) and the D1 guard would accept task 2's FIRST completion —
    // 3 evaluations total. With the re-stamp the guard rejects it
    // (evidence=0), one more turn runs, and only THEN it completes:
    // 4 evaluations. We got 4.
    expect(delegate.evalCalls).toBe(4)
    expect(
      delegate.logs.some(
        m => m.includes('D1 guard rejected completion of task 2/2') && m.includes('evidence=0'),
      ),
    ).toBe(true)
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['done', 'done'])
  })
})

describe('T3 frontier — a FAILED compaction proceeds without compacting and DECLARES it', () => {
  it('compactionFailures increments, the log declares, the ring is preserved, the batch completes', async () => {
    const goal = makeBatchGoal('Task one', 'Task two')
    const delegate = makeDelegate(goal, [COMPLETE, COMPLETE])
    produceCommandEvidence(delegate)
    delegate.compactOnTaskBoundary = async () => false // the compact failed

    const result = await runGoalCycle(delegate)

    // Never blocked, never paused: the batch ran to completion.
    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['done', 'done'])
    for (const state of delegate.goalHistory) {
      expect(state.status).not.toBe('paused')
      expect(state.status).not.toBe('blocked')
    }

    // DECLARED, not hidden: the counter the T4 report reads, and a log
    // line that says exactly what happened.
    expect(delegate.goal.compactionFailures).toBe(1)
    expect(delegate.logs.some(m => m.includes('WITHOUT compacting'))).toBe(true)

    // On failure the ring is PRESERVED: the transcript did not change,
    // so the loop detector's baseline stays valid — disarming it would
    // strip protection we still need. CONTRAFACTUAL: the success write
    // would have emptied the ring; the post-frontier state still holds
    // task 1's evaluation history (the D1 rejection marker is in it).
    const frontier = delegate.goalHistory.find(
      state => state.taskIndex === 1 && state.compactionFailures === 1,
    )
    expect(frontier).toBeDefined()
    expect(frontier?.recentFingerprints.length).toBeGreaterThan(0)
    expect(frontier?.recentFingerprints).toContain('d1:complete-rejected-no-evidence:task:0')
    expect(frontier?.turnsRunThisTask).toBe(0)
    // The evidence window was still re-opened (a partial compact turn
    // may have emitted activities — they must not leak into task 2).
    expect(frontier?.tasks?.[1].startedAt).toBeTypeOf('number')
  })
})

// CHANGED ASSERTION, BY DESIGN — NOT A REGRESSION. The T3 version of
// this file pinned the OPPOSITE: "a loop-kill advance never fires the
// frontier". The Maestro ratified the extension (T3b): EVERY task
// boundary compacts — a loop-killed task produced several turns of
// repetition, the MOST polluted context in the batch, and carrying it
// into the next task is the user's original complaint ("tempo demais
// na zona burra"). The final report loses no diagnosis: it is built
// from goal state (per-task status/reason), and the CLI compaction
// keeps a summary, it does not erase.
describe('T3b frontier — the loop-kill advance compacts with the exact T3 protocol', () => {
  it('during the compact wait the POISONED ring is still there; the reset lands only after; last-task done never compacts', async () => {
    const goal = makeBatchGoal('Stuck task', 'Fine task')
    const delegate = makeDelegate(goal, [
      CONTINUE, CONTINUE, CONTINUE, // task 1 loops → failed, batch advances
      COMPLETE, // task 2's first completion (rejected: 0 turns)
      // repeats → accepted after the real turn
    ])
    produceCommandEvidence(delegate)

    const events: string[] = []
    let compactCalls = 0
    let resolveCompact: ((ok: boolean) => void) | undefined
    delegate.compactOnTaskBoundary = () => {
      compactCalls++
      events.push('compact:start')
      return new Promise<boolean>(resolve => {
        resolveCompact = (ok) => {
          events.push('compact:end')
          resolve(ok)
        }
      })
    }
    // Same marker as the T3 sequence test: first advanced state with an
    // EMPTY ring. The kill's split write keeps the poisoned ring (3
    // identical fingerprints) until the compact settles — only the
    // post-compact reset clears it.
    const baseUpdateGoal = delegate.updateGoal
    delegate.updateGoal = (update) => {
      baseUpdateGoal(update)
      const state = delegate.goal
      if (
        !events.includes('reset:write')
        && state.taskIndex === 1
        && state.turnsRunThisTask === 0
        && state.recentFingerprints.length === 0
      ) {
        events.push('reset:write')
      }
    }

    const cyclePromise = runGoalCycle(delegate)

    await vi.waitFor(() => {
      expect(events).toContain('compact:start')
    })
    // DURING the wait the reset must NOT have happened: the poisoned
    // ring (three identical fingerprints from the loop) is still there.
    // CONTRAFACTUAL: if the reset ran before the compact concluded,
    // this would already be empty.
    expect(events).not.toContain('compact:end')
    expect(events).not.toContain('reset:write')
    expect(delegate.goal.taskIndex).toBe(1)
    expect(delegate.goal.recentFingerprints.length).toBe(3)
    // The compact turn was already fired and did NOT increment turnsRun
    // — only task 1's three real turns have run.
    expect(delegate.goal.turnsRun).toBe(3)

    resolveCompact!(true)
    const result = await cyclePromise

    expect(result).toBe('completed')
    expect(events).toEqual(['compact:start', 'compact:end', 'reset:write'])
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'done'])
    // Task 2 was evaluated with its OWN counter (0 on its first
    // evaluation — it had not run yet; the loop's 3 turns did NOT leak).
    expect(delegate.capturedSnapshots.map(s => s.objective)).toEqual([
      'Stuck task', 'Stuck task', 'Stuck task', 'Fine task', 'Fine task',
    ])
    expect(delegate.capturedSnapshots.map(s => s.turnsRun)).toEqual([0, 1, 2, 0, 1])
    // EXACTLY ONE compact: the done of the LAST task does not fire the
    // frontier (there is no next task to compact for).
    expect(compactCalls).toBe(1)
  })

  it('D1 still bites on the loop path: a whitelisted activity emitted DURING the compact is excluded', async () => {
    // The Maestro's point 2: on the failure path the re-stamp matters
    // EVEN MORE — the previous task FAILED. Controlled clock so the
    // compact activities and the re-stamp never share a millisecond.
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const goal = makeBatchGoal('Stuck task', 'Fine task')
    const delegate = makeDelegate(goal, [
      CONTINUE, CONTINUE, CONTINUE, // task 1 loops
      COMPLETE, COMPLETE, COMPLETE, // task 2 keeps declaring done
    ])
    // Evidence policy: task 2's FIRST turn produces NONE — the compact's
    // own activity is the only candidate; the retry turn produces it.
    delegate.onContinueTurn = (callIndex) => {
      if (callIndex >= 5) delegate.items.push(activity('command', now))
    }
    delegate.compactOnTaskBoundary = async () => {
      now += 10
      delegate.items.push(activity('compacting', now))
      delegate.items.push(activity('command', now)) // whitelisted — adversarial
      now += 10
      return true
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    // Task 2's completions: eval#4 rejected (0 turns), eval#5 rejected
    // (1 turn, evidence=0 — the compact's 'command' was EXCLUDED by the
    // re-opened window), eval#6 accepted. CONTRAFACTUAL: without the
    // re-stamp, eval#5 would have passed — 5 evaluations, not 6.
    expect(delegate.evalCalls).toBe(6)
    expect(
      delegate.logs.some(
        m => m.includes('D1 guard rejected completion of task 2/2') && m.includes('evidence=0'),
      ),
    ).toBe(true)
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'done'])
  })

  it('compact FAILURE on the loop path still clears the poisoned ring — the next task is never killed unread', async () => {
    const goal = makeBatchGoal('Stuck task', 'Fine task')
    const delegate = makeDelegate(goal, [
      CONTINUE, CONTINUE, CONTINUE, // task 1 loops
      COMPLETE, // task 2 (rejected at 0 turns, then repeats → accepted)
    ])
    produceCommandEvidence(delegate)
    delegate.compactOnTaskBoundary = async () => false // the compact failed

    const result = await runGoalCycle(delegate)

    // Declared, not hidden — and the batch proceeded.
    expect(result).toBe('completed')
    expect(delegate.goal.compactionFailures).toBe(1)
    expect(delegate.logs.some(m => m.includes('WITHOUT compacting'))).toBe(true)
    expect(delegate.logs.some(m => m.includes('Poisoned loop ring cleared'))).toBe(true)
    // THE CONTRAFACTUAL that justifies the divergent failure policy:
    // had the poisoned ring been PRESERVED (the done-path policy), the
    // very next loop-top check would have detected 3 identical
    // fingerprints and killed task 2 WITHOUT A SINGLE EVALUATION of its
    // own — and K=2 would have paused the batch. None of that happened:
    // task 2 was evaluated, worked, and completed.
    const frontier = delegate.goalHistory.find(
      state => state.taskIndex === 1 && state.compactionFailures === 1,
    )
    expect(frontier).toBeDefined()
    expect(frontier?.recentFingerprints).toEqual([])
    expect(delegate.capturedSnapshots.map(s => s.objective)).toContain('Fine task')
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'done'])
    for (const state of delegate.goalHistory) {
      expect(state.pauseReason).not.toBe('batchStagnation')
    }
  })
})

describe('T3b frontier — the skip advance compacts on the restarted cycle, protocol intact', () => {
  it('skipBlockedGoalTask stamps the debt; the reset lands only after the compact; the flag is cleared', async () => {
    // ASSERTION CHANGED BY DESIGN (T3b coalescence, Maestro's call): this
    // test previously blocked the task with ZERO turns and still
    // expected the debt to be stamped. The coalescence rule — zero turns
    // means nothing new to compact, so NO debt — moved that setup to the
    // coalescence describe below. This test now runs ONE turn before the
    // block and pins the ≥1-turn direction: the skip OWES the frontier.
    // The two tests are the counterfactual pair — the ONLY difference
    // between them is the turn count.
    const goal = makeBatchGoal('Blocked task', 'Next task')
    const delegate = makeDelegate(goal, [
      CONTINUE, // task 1 works 1 turn
      NEEDS_USER, // task 1 blocks → batch paused
      COMPLETE, // task 2 (rejected at 0 turns, then repeats → accepted)
    ])
    produceCommandEvidence(delegate)

    expect(await runGoalCycle(delegate)).toBe('paused')
    expect(delegate.goal.tasks?.[0].status).toBe('blocked')
    expect(delegate.goal.turnsRunThisTask).toBe(1)

    // The user skips — a pure transition OUTSIDE the cycle. The debt
    // is stamped because the frontier cannot run here.
    const skipped = skipBlockedGoalTask(delegate.goal, Date.now())
    expect(skipped.pendingCompaction).toBe(true)
    expect(skipped.taskIndex).toBe(1)
    delegate.goal = skipped

    const events: string[] = []
    let compactCalls = 0
    let resolveCompact: ((ok: boolean) => void) | undefined
    delegate.compactOnTaskBoundary = () => {
      compactCalls++
      events.push('compact:start')
      return new Promise<boolean>(resolve => {
        resolveCompact = (ok) => {
          events.push('compact:end')
          resolve(ok)
        }
      })
    }
    const baseUpdateGoal = delegate.updateGoal
    delegate.updateGoal = (update) => {
      baseUpdateGoal(update)
      const state = delegate.goal
      if (
        !events.includes('reset:write')
        && state.taskIndex === 1
        && state.turnsRunThisTask === 0
        && state.recentFingerprints.length === 0
      ) {
        events.push('reset:write')
      }
    }

    const cyclePromise = runGoalCycle(delegate)

    await vi.waitFor(() => {
      expect(events).toContain('compact:start')
    })
    // DURING the wait: no reset yet — the debt is still stamped and the
    // ring (TWO fingerprints: the continue and the needsUser evaluations)
    // is intact.
    expect(events).not.toContain('reset:write')
    expect(delegate.goal.pendingCompaction).toBe(true)
    expect(delegate.goal.recentFingerprints.length).toBe(2)

    resolveCompact!(true)
    const result = await cyclePromise

    expect(result).toBe('completed')
    expect(events).toEqual(['compact:start', 'compact:end', 'reset:write'])
    expect(compactCalls).toBe(1)
    // 4 evaluations: continue + needsUser (task 1), then task 2's
    // completion rejected at 0 turns and accepted after working — and
    // the evaluator saw the PER-TASK objective at every call.
    expect(delegate.evalCalls).toBe(4)
    expect(delegate.capturedSnapshots.map(s => s.objective)).toEqual([
      'Blocked task', 'Blocked task', 'Next task', 'Next task',
    ])
    // The debt is SETTLED whatever comes next — a later resume of the
    // same task must not compact again (idempotent).
    expect(delegate.goal.pendingCompaction).toBeUndefined()
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['skipped', 'done'])
  })
})

describe('T3b frontier — cost cap: at most ONE compact per consecutive-failure streak', () => {
  it('the first loop-kill compacts; the second consecutive failure PAUSES (K=2) without compacting', async () => {
    const goal = makeBatchGoal('Stuck one', 'Stuck two', 'Never started')
    const delegate = makeDelegate(goal, [
      CONTINUE, CONTINUE, CONTINUE, // task 1 loops → failed (K=1), frontier fires
      CONTINUE, CONTINUE, CONTINUE, // task 2 loops → failed (K=2) → PAUSE, no frontier
    ])
    let compactCalls = 0
    delegate.compactOnTaskBoundary = async () => {
      compactCalls++
      return true
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('batchStagnation')
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'failed', 'active'])
    // THE CAP the Maestro asked about: two consecutive failures produce
    // ONE compaction, never two — the K-pause stops the batch for the
    // user, so no next task starts and there is nothing to compact for.
    expect(compactCalls).toBe(1)
  })
})

// The Maestro's rule: skip the boundary compaction when the task that is
// LEAVING ran ZERO turns — with no turns, nothing new entered the context
// since the last compaction, so compacting would spend 25-50s compressing
// exactly the same content (the user's original complaint IS time wasted
// in the dumb zone; a useless compact is literally that). The skip must
// be DECLARED in the log — never silent. Each test below is one half of
// a counterfactual pair: the ONLY difference between the siblings is the
// leaving task's turn count.
describe('T3b coalescence — a zero-turn boundary never compacts (and says so)', () => {
  it('SKIP path, zero turns: no debt stamped, the log declares why, the restarted cycle compacts ZERO times', async () => {
    const goal = makeBatchGoal('Blocked task', 'Next task')
    const delegate = makeDelegate(goal, [
      NEEDS_USER, // task 1 blocks IMMEDIATELY — zero turns run
      COMPLETE, // task 2 (rejected at 0 turns, then repeats → accepted)
    ])
    produceCommandEvidence(delegate)

    expect(await runGoalCycle(delegate)).toBe('paused')
    expect(delegate.goal.turnsRunThisTask).toBe(0)

    const skipLogs: string[] = []
    const skipped = skipBlockedGoalTask(delegate.goal, Date.now(), m => skipLogs.push(m))
    // NO debt — and the skip SAYS why (silence would be the defect class
    // this whole cycle worked to eliminate).
    expect(skipped.pendingCompaction).toBeUndefined()
    expect(
      skipLogs.some(m => m.includes('skipping compaction') && m.includes('0 turns')),
    ).toBe(true)
    delegate.goal = skipped

    let compactCalls = 0
    delegate.compactOnTaskBoundary = async () => {
      compactCalls++
      return true
    }
    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    // CONTRAFACTUAL pinned by the sibling test above: the SAME skip with
    // 1 turn run fires exactly ONE compact — so 0 here is the coalescence
    // rule, not a broken wire.
    expect(compactCalls).toBe(0)
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['skipped', 'done'])
  })

  it('LOOP path, zero turns: the kill advances WITHOUT compacting, declares it, and STILL clears the poisoned ring', async () => {
    const goal = makeBatchGoal('Stuck task', 'Fine task')
    const delegate = makeDelegate(goal, [COMPLETE])
    produceCommandEvidence(delegate)
    // Seed the loop signal directly: three identical fingerprints, so the
    // kill fires at the FIRST loop-top — with zero turns run this task.
    delegate.goal = {
      ...delegate.goal,
      turnsRunThisTask: 0,
      recentFingerprints: ['fp', 'fp', 'fp'],
      noProgressCount: 2,
    }
    let compactCalls = 0
    delegate.compactOnTaskBoundary = async () => {
      compactCalls++
      return true
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(compactCalls).toBe(0)
    expect(
      delegate.logs.some(m => m.includes('skipping compaction') && m.includes('0 turns')),
    ).toBe(true)
    // The ring cleanup is NOT coalesced away: poisoned is poisoned. The
    // next task starts on an empty ring even without a compact — an
    // inherited ring would kill it at the next loop-top unread.
    const kill = delegate.goalHistory.find(
      state => state.taskIndex === 1 && state.turnsRunThisTask === 0,
    )
    expect(kill?.recentFingerprints).toEqual([])
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'done'])
  })

  it('LOOP path, one turn: the SAME kill compacts exactly once — 0 vs ≥1 turns is the whole rule', async () => {
    const goal = makeBatchGoal('Stuck task', 'Fine task')
    const delegate = makeDelegate(goal, [COMPLETE])
    produceCommandEvidence(delegate)
    delegate.goal = {
      ...delegate.goal,
      turnsRunThisTask: 1, // the ONLY difference from the previous test
      recentFingerprints: ['fp', 'fp', 'fp'],
      noProgressCount: 2,
    }
    let compactCalls = 0
    delegate.compactOnTaskBoundary = async () => {
      compactCalls++
      return true
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(compactCalls).toBe(1)
    expect(delegate.logs.some(m => m.includes('skipping compaction'))).toBe(false)
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'done'])
  })
})
