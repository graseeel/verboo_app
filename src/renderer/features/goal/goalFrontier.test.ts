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
 *   4. SCOPE: loop/K advances (matrix rows 8/9) do NOT compact — the
 *      frontier fires on the done-advance path only.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { GoalEvaluationResult, GoalState, TranscriptItem } from '../../../shared/types'
import type { Translator } from '../../i18n'
import { runGoalCycle, type GoalSchedulerDelegate } from './goalScheduler'
import { createGoalState } from './goalState'

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

/** Every turn produces real action evidence (a 'command' activity). */
function produceCommandEvidence(delegate: FrontierDelegate): void {
  delegate.onContinueTurn = () => {
    delegate.items.push(activity('command', Date.now()))
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Acceptance 1: the SEQUENCE — reset NEVER before the compact ends ─
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

// ─── Acceptance 2: the compact turn alone NEVER satisfies D1 ─────────
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

// ─── Acceptance 3: FAILURE — proceeds WITHOUT compacting, declared ────
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

// ─── Scope: loop/K advances do NOT compact (done-advance only) ────────
describe('T3 frontier — scope: only the done-advance path compacts', () => {
  it('a loop-kill advance never fires the frontier (and completing the LAST task does not either)', async () => {
    const goal = makeBatchGoal('Stuck task', 'Fine task')
    const delegate = makeDelegate(goal, [
      CONTINUE, CONTINUE, CONTINUE, // task 1 loops → failed, batch advances
      CONTINUE, // task 2 works a turn
      COMPLETE, // task 2 done (LAST → goal completes, no advance)
    ])
    produceCommandEvidence(delegate)
    let compactCalls = 0
    delegate.compactOnTaskBoundary = async () => {
      compactCalls++
      return true
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'done'])
    // CONTRAFACTUAL: if the frontier fired on the loop-kill advance,
    // compactCalls would be 1 here. It is 0: a task that just FAILED
    // signals a possibly broken environment (the K guard pauses next) —
    // compacting there would spend tokens on a dying batch. And a
    // completed LAST task has no next task to compact FOR.
    expect(compactCalls).toBe(0)
  })
})
