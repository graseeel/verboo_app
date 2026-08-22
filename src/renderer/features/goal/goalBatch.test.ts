/**
 * T1: goal BATCH (lote) + D1 action-evidence guard.
 *
 * What this file proves (each test names DISPARO and EFEITO, not forma):
 *   1. CANONICAL REPRO — a task that tries to complete BY PROSE (zero
 *      whitelisted action activities) does NOT advance, feeds the ring
 *      with the deterministic D1 fingerprint, and dies by the loop
 *      detector at ~3 evaluations. This is the incident class that
 *      motivated the guard: a goal completing with turnsRun zero and
 *      nothing on disk — the system accepting the agent's NARRATIVE.
 *   2. turnsRunThisTask resets at the task boundary; the batch advances
 *      IN PLACE (one goal record, ownerConversationId untouched —
 *      POSSE, not freshness).
 *   3. The evaluator snapshot carries the PER-TASK objective and the
 *      PER-TASK turn counter while the real goal keeps the global ones
 *      (the snapshot trick — Rust untouched).
 *   4. Legacy single-task goal: NO REGRESSION — same object reference
 *      to the evaluator, global counter, D1 never consulted.
 *
 * DECLARED LIMIT (h), pinned by the last test: the D1 guard proves the
 * PRESENCE of an action, NOT the CORRECTNESS of the action — an edit
 * that wrote garbage passes. Do not read a green D1 check as proof the
 * work is right.
 */

import { describe, it, expect } from 'vitest'
import type { GoalEvaluationResult, GoalState, GoalTask, TranscriptItem } from '../../../shared/types'
import type { Translator } from '../../i18n'
import { runGoalCycle, type GoalSchedulerDelegate } from './goalScheduler'
import {
  ACTION_ACTIVITY_KINDS,
  advanceGoalTasks,
  buildEvaluatorSnapshot,
  countActionActivities,
  createGoalState,
  currentGoalTask,
} from './goalState'

/** Same stub translator as goalScheduler.test.ts: key + interpolated params. */
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

function messageItem(timestamp: number, text = 'All done!'): TranscriptItem {
  return {
    id: `message:${timestamp}:${crypto.randomUUID()}`,
    role: 'assistant',
    text,
    timestamp,
    kind: 'message',
  }
}

type BatchSpiedDelegate = GoalSchedulerDelegate & {
  goal: GoalState
  items: TranscriptItem[]
  evaluations: GoalEvaluationResult[]
  evaluationIndex: number
  evalCalls: number
  capturedGoals: GoalState[]
  /** Whether the goal the evaluator received was the SAME object
   *  reference as the live goal at call time (legacy) or a snapshot
   *  copy (batch). */
  capturedSameRef: boolean[]
  getItemsCalls: number
  /** Every state produced by updateGoal, in order — lets tests assert
   *  intermediate states (e.g. the boundary reset) that the final goal
   *  has already moved past. */
  goalHistory: GoalState[]
  continueCalls: { nextMessage: string }[]
  onCompleteCalls: { goal: GoalState; evaluation?: GoalEvaluationResult }[]
  statusChanges: unknown[]
  logs: string[]
  /** The object the last getGoal() returned — the scheduler's loop-top
   *  snapshot. evaluateGoal compares what it receives against THIS (not
   *  against delegate.goal, which updateGoal has already replaced by
   *  call time) to prove same-reference for legacy goals. */
  lastGetGoal?: GoalState
  /** Test hook: ran inside continueGoal to simulate the turn producing
   *  transcript activity (e.g. pushing a 'command' item). */
  onContinueTurn?: () => void
}

function makeBatchDelegate(
  goal: GoalState,
  evaluations: GoalEvaluationResult[],
  items: TranscriptItem[],
): BatchSpiedDelegate {
  const delegate: BatchSpiedDelegate = {
    goal,
    items,
    evaluations,
    evaluationIndex: 0,
    evalCalls: 0,
    capturedGoals: [],
    capturedSameRef: [],
    getItemsCalls: 0,
    goalHistory: [],
    continueCalls: [],
    onCompleteCalls: [],
    statusChanges: [],
    logs: [],
    getGoal: () => {
      delegate.lastGetGoal = delegate.goal
      return delegate.goal
    },
    updateGoal: (update) => {
      delegate.goal = typeof update === 'function' ? update(delegate.goal) : update
      delegate.goalHistory.push(delegate.goal)
    },
    evaluateGoal: async (snapshot) => {
      delegate.evalCalls++
      delegate.capturedGoals.push(snapshot)
      // Compared against the LOOP-TOP goal (last getGoal return): by
      // the time evaluateGoal runs, updateGoal(status:'evaluating') has
      // already replaced delegate.goal, so comparing against it would
      // always be false even on the zero-copy legacy path.
      delegate.capturedSameRef.push(snapshot === delegate.lastGetGoal)
      const evalResult =
        delegate.evaluations[delegate.evaluationIndex] ??
        delegate.evaluations[delegate.evaluations.length - 1]
      delegate.evaluationIndex++
      return evalResult
    },
    getConversationItems: () => {
      delegate.getItemsCalls++
      return delegate.items
    },
    continueGoal: async (_goal, nextMessage) => {
      delegate.continueCalls.push({ nextMessage })
      // Mirrors the App.tsx wiring (T1): when a turn runs, the global
      // and per-task counters increment together — and the per-task key
      // stays ABSENT on legacy goals (conditional, exactly like
      // App.tsx's continueGoal delegate).
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
    onComplete: (g, e) => {
      delegate.onCompleteCalls.push({ goal: g, evaluation: e })
    },
    t,
  }
  return delegate
}

function makeBatchGoal(
  tasks: { text: string; toolless?: boolean }[],
  objective = 'Ship feature X',
): GoalState {
  const goal = createGoalState({
    objective,
    accessMode: 'approval',
    workingDirectory: '/tmp/project',
    skills: [],
    tasks,
  })
  goal.ownerConversationId = 'conv-owner'
  return goal
}

// T2 ASSERTION CHANGE — BY DESIGN, not regression (declared per the
// Maestro's warning): under T1 this repro ended 'blocked' with the
// goal stuck on task 1 forever. Under T2's state matrix (row 8), the
// loop detector FAILS ONLY THE TASK and the batch ADVANCES — and when
// the failing task is the last one (row 13), the batch completes with
// its failures recorded per task. The D1 mechanics (reject → no-
// progress → ring → loop at ~3) are UNCHANGED and still asserted here.
describe('T1 aceite 1 + T2 rows 8/13 — CANONICAL REPRO: completion by prose never becomes done', () => {
  it('each prose-completing task dies by loop at ~3, is marked failed (never done), and the batch advances', async () => {
    const goal = makeBatchGoal([{ text: 'Fix the parser' }, { text: 'Add regression test' }])
    const startedAt = goal.startedAt ?? 0
    // The transcript the agent produced: THINKING (the trap — thinking
    // is NOT acting) and a prose message claiming completion. ZERO
    // whitelisted action activities.
    const items: TranscriptItem[] = [
      activity('thinking', startedAt),
      messageItem(startedAt, 'Everything is fixed, the task is complete.'),
    ]
    // The evaluator ALWAYS says complete (the factory repeats the last
    // evaluation) — the agent insists on completing by narrative alone.
    const delegate = makeBatchDelegate(goal, [
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'All fixed.' }),
    ], items)

    const result = await runGoalCycle(delegate)

    // EFEITO 1 — each task died by the EXISTING loop detector at ~3
    // evaluations (3 for task 1 + 3 for task 2); the batch did NOT
    // block — it advanced (T2 row 8) and completed with failures (row
    // 13, which beats the K guard: nothing left to pause FOR).
    expect(result).toBe('completed')
    expect(delegate.evalCalls).toBe(6)
    // EFEITO 2 — every rejected completion became NO-PROGRESS, never a
    // failure shortcut: a re-prompt turn ran after each rejection.
    expect(delegate.continueCalls.length).toBe(6)
    // EFEITO 3 — neither task EVER became done; both are 'failed' with
    // completion stamps, on the SAME goal record.
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['failed', 'failed'])
    expect(delegate.goal.tasks?.[0].completedAt).toBeTypeOf('number')
    expect(delegate.goal.tasks?.[1].completedAt).toBeTypeOf('number')
    expect(delegate.goal.status).toBe('completed')
    expect(delegate.goal.completedAt).toBeTypeOf('number')
    // EFEITO 4 — the D1 ring mechanics per task, unchanged from T1:
    // each task's rejections pushed its OWN deterministic fingerprint
    // three times (the exact signal detectLoop kills on); the loop kill
    // then CLEARED the ring so the next task starts clean.
    const task0Poisoned = delegate.goalHistory.find(
      state => state.taskIndex === 0 && state.recentFingerprints.length === 3,
    )
    expect(task0Poisoned?.recentFingerprints).toEqual([
      'd1:complete-rejected-no-evidence:task:0',
      'd1:complete-rejected-no-evidence:task:0',
      'd1:complete-rejected-no-evidence:task:0',
    ])
    const task1Poisoned = delegate.goalHistory.find(
      state => state.taskIndex === 1 && state.recentFingerprints.length === 3,
    )
    expect(task1Poisoned?.recentFingerprints).toEqual([
      'd1:complete-rejected-no-evidence:task:1',
      'd1:complete-rejected-no-evidence:task:1',
      'd1:complete-rejected-no-evidence:task:1',
    ])
    // EFEITO 5 — the T2 row-8 advance after task 1's loop: task 1
    // failed, batch STILL ACTIVE (not blocked, not paused), task 2
    // active, counter reset, ring cleared, K counter at 1.
    const afterFirstLoop = delegate.goalHistory.find(
      state => state.taskIndex === 1 && state.tasks?.[0].status === 'failed',
    )
    expect(afterFirstLoop).toBeDefined()
    expect(afterFirstLoop?.status).not.toBe('blocked')
    expect(afterFirstLoop?.status).not.toBe('paused')
    expect(afterFirstLoop?.tasks?.[1].status).toBe('active')
    expect(afterFirstLoop?.turnsRunThisTask).toBe(0)
    expect(afterFirstLoop?.recentFingerprints).toEqual([])
    expect(afterFirstLoop?.consecutiveFailedTasks).toBe(1)
    // EFEITO 6 — the UI never saw a "complete" from the evaluator:
    // lastEvaluation carries the DOWNGRADED continue.
    expect(delegate.goal.lastEvaluation?.decision).toBe('continue')
    expect(delegate.goal.lastEvaluation?.reasonId).toBe('taskIncomplete')
    expect(delegate.goal.lastEvaluation?.reason).toContain('action-evidence guard')
    // EFEITO 6b (D-B — BY-DESIGN change to the T2 pin that used to live
    // here): the pin asserted onComplete NEVER fired on this path because
    // "the final report surface is T4's, pinned so T4 makes a conscious
    // choice". T4 built the report but the pin was never revisited — and
    // the field test caught it: the batch ended with no report, no
    // elapsed, no tokens. The new contract: the TERMINAL loop-kill fires
    // onComplete EXACTLY once (the row-8 non-terminal advance does NOT
    // complete anything — twice would be wrong).
    expect(delegate.onCompleteCalls.length).toBe(1)
    const finalGoal = delegate.onCompleteCalls[0].goal
    expect(finalGoal.status).toBe('completed')
    expect(finalGoal.completedAt).toBeTypeOf('number')
    expect(finalGoal.tasks?.map(task => task.status)).toEqual(['failed', 'failed'])
    // EFEITO 7 — the rejections were logged with the real numbers.
    const rejectionLogs = delegate.logs.filter(m => m.startsWith('D1 guard rejected completion of task'))
    expect(rejectionLogs.length).toBe(6)
    expect(rejectionLogs[0]).toContain('task 1/2')
    expect(rejectionLogs[0]).toContain('turnsThisTask=0') // first rejection: the TURNS leg
    expect(rejectionLogs[1]).toContain('evidence=0') // later rejections: the EVIDENCE leg
    expect(rejectionLogs[3]).toContain('task 2/2') // second task guarded too
    // EFEITO 8 — the re-prompt tells the agent WHY (downgraded reason
    // feeds buildContinuePrompt), anchored on the CURRENT task's text.
    expect(delegate.continueCalls[0].nextMessage).toContain('Fix the parser')
    expect(delegate.continueCalls[0].nextMessage).toContain('action-evidence guard')
    expect(delegate.continueCalls[3].nextMessage).toContain('Add regression test')
  })
})

describe('T1 aceites 2+3 — batch advance: counter reset, evaluator snapshot, owner untouched', () => {
  it('a 2-task batch advances in place: turnsRunThisTask resets at the boundary, the evaluator gets the PER-TASK snapshot', async () => {
    const goal = makeBatchGoal([{ text: 'Write the module' }, { text: 'Add the tests' }])
    // Evidence for task 1's window (task 1 startedAt === goal.startedAt;
    // the boundary millisecond counts, `>=`).
    const items: TranscriptItem[] = [activity('edit', goal.startedAt ?? 0)]
    const delegate = makeBatchDelegate(goal, [
      makeEval(), // turn 1 works, evaluator says continue
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Module written.' }),
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Tests added.' }),
    ], items)
    // Every turn the agent runs produces a 'command' activity — task 2's
    // evidence lands inside task 2's window (startedAt stamped at the
    // advance, before this turn runs).
    delegate.onContinueTurn = () => {
      delegate.items.push(activity('command', Date.now()))
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.evalCalls).toBe(3)

    // ACEITE 3 — the evaluator received the PER-TASK snapshot:
    // objective = current task text, turnsRun = turnsRunThisTask.
    const [snap1, snap2, snap3] = delegate.capturedGoals
    expect(snap1.objective).toBe('Write the module')
    expect(snap1.turnsRun).toBe(0)
    expect(snap2.objective).toBe('Write the module')
    expect(snap2.turnsRun).toBe(1)
    expect(snap3.objective).toBe('Add the tests')
    // THE proof the counter is per-task: the real goal ran 2 turns
    // globally, but the evaluator saw 1 for the second task.
    expect(snap3.turnsRun).toBe(1)
    expect(delegate.goal.turnsRun).toBe(2)
    // Batch snapshots are COPIES, not the live goal reference.
    expect(delegate.capturedSameRef).toEqual([false, false, false])
    // The snapshot carries the rest of the goal untouched — including
    // ownerConversationId, which the App.tsx evaluateGoal delegate
    // resolves the owner conversation from (G-C8-FIX).
    expect(snap3.ownerConversationId).toBe('conv-owner')
    expect(snap3.workingDirectory).toBe('/tmp/project')

    // ACEITE 2 — turnsRunThisTask ZEROED at the boundary: the state
    // produced by the advance has taskIndex 1 AND turnsRunThisTask 0.
    const boundary = delegate.goalHistory.find(state => state.taskIndex === 1)
    expect(boundary).toBeDefined()
    expect(boundary?.turnsRunThisTask).toBe(0)
    expect(boundary?.tasks?.[0].status).toBe('done')
    expect(boundary?.tasks?.[0].completedAt).toBeTypeOf('number')
    expect(boundary?.tasks?.[1].status).toBe('active')
    expect(boundary?.tasks?.[1].startedAt).toBeTypeOf('number')

    // POSSE — ownerConversationId stamped once, NEVER re-stamped:
    // identical in every state the cycle ever produced.
    for (const state of delegate.goalHistory) {
      expect(state.ownerConversationId).toBe('conv-owner')
    }

    // The continue prompt after the advance re-anchors on the NEXT task.
    expect(delegate.continueCalls[1].nextMessage).toContain('Add the tests')

    // Completion: same goal record, ALL tasks done (the last stamped by
    // the completion path), onComplete fired once with them.
    expect(delegate.goal.status).toBe('completed')
    expect(delegate.goal.tasks?.map(task => task.status)).toEqual(['done', 'done'])
    expect(delegate.goal.tasks?.[1].completedAt).toBeTypeOf('number')
    expect(delegate.goal.turnsRunThisTask).toBe(1) // one turn ran for task 2
    expect(delegate.onCompleteCalls.length).toBe(1)
    expect(delegate.onCompleteCalls[0].goal.tasks?.map(task => task.status)).toEqual(['done', 'done'])
  })
})

describe('T1 aceite 4 — legacy single-task goal: behavior intact', () => {
  it('a goal WITHOUT tasks completes exactly as before: same object to the evaluator, global counter, D1 never consulted', async () => {
    const goal = createGoalState({
      objective: 'Ship the login endpoint',
      accessMode: 'approval',
      workingDirectory: '/tmp/project',
      skills: [],
    })
    // Batch keys stay ABSENT on creation (not undefined-valued).
    expect('tasks' in goal).toBe(false)
    expect('taskIndex' in goal).toBe(false)
    expect('turnsRunThisTask' in goal).toBe(false)

    const delegate = makeBatchDelegate(goal, [
      makeEval(),
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'All shipped.' }),
    ], [])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
    // The evaluator received the SAME OBJECT REFERENCE (no snapshot
    // copy) with the umbrella objective and the GLOBAL counter.
    expect(delegate.capturedSameRef).toEqual([true, true])
    expect(delegate.capturedGoals[0].objective).toBe('Ship the login endpoint')
    expect(delegate.capturedGoals[1].objective).toBe('Ship the login endpoint')
    expect(delegate.capturedGoals[1].turnsRun).toBe(1)
    // D1 was NEVER consulted for a legacy goal.
    expect(delegate.getItemsCalls).toBe(0)
    // And the batch keys were never materialized on the goal.
    expect('tasks' in delegate.goal).toBe(false)
    expect('taskIndex' in delegate.goal).toBe(false)
    expect('turnsRunThisTask' in delegate.goal).toBe(false)
    expect(delegate.onCompleteCalls.length).toBe(1)
  })
})

describe('T1 (f) — toolless opt-out: evidence waived, turns still required', () => {
  it('a toolless task completes with ZERO action evidence after a real turn — but NOT with zero turns', async () => {
    const goal = makeBatchGoal([{ text: 'Write a haiku in chat', toolless: true }])
    const delegate = makeBatchDelegate(goal, [
      // The evaluator says complete IMMEDIATELY (zero turns)…
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Haiku delivered.' }),
      // …and again after the re-prompt turn.
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Haiku delivered.' }),
    ], []) // zero evidence items — waived for toolless

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.evalCalls).toBe(2)
    // The FIRST completion was REJECTED on the turns leg even with the
    // evidence leg waived — the opt-out is ONLY about evidence.
    const rejection = delegate.logs.find(m => m.startsWith('D1 guard rejected completion of task 1/1'))
    expect(rejection).toBeDefined()
    expect(rejection).toContain('turnsThisTask=0')
    expect(rejection).toContain('evidence=waived')
    // After one real turn, the waived evidence lets it complete.
    expect(delegate.goal.tasks?.[0].status).toBe('done')
    expect(delegate.onCompleteCalls.length).toBe(1)
  })

  it('toolless is per-task: a batch with one toolless and one normal task still guards the normal one', async () => {
    const goal = makeBatchGoal([
      { text: 'Write a haiku in chat', toolless: true },
      { text: 'Fix the parser' },
    ])
    const delegate = makeBatchDelegate(goal, [
      makeEval({ decision: 'complete', reasonId: 'done' }), // haiku: 0 turns → rejected (turns leg)
      makeEval({ decision: 'complete', reasonId: 'done' }), // haiku: 1 turn, waived → done, advance
      makeEval({ decision: 'complete', reasonId: 'done' }), // parser: 1 turn, ZERO evidence → REJECTED
      makeEval({ decision: 'complete', reasonId: 'done' }), // parser: still zero evidence → REJECTED
      makeEval({ decision: 'complete', reasonId: 'done' }), // parser: third rejection → ring full
    ], []) // no action activities at all — the parser task can never pass D1

    const result = await runGoalCycle(delegate)

    // T2 ASSERTION CHANGE — BY DESIGN: under T1 this ended 'blocked'.
    // Under T2 the parser task's 3 prose-completions kill the TASK by
    // loop (row 8); being the LAST task, the batch completes with the
    // failure recorded (row 13). The per-task guard itself is unchanged.
    expect(result).toBe('completed')
    expect(delegate.goal.taskIndex).toBe(1) // advanced past the haiku…
    expect(delegate.goal.tasks?.[0].status).toBe('done') // …toolless completed…
    expect(delegate.goal.tasks?.[1].status).toBe('failed') // …but the guarded task NEVER became done
    // The parser task's rejections DID push its own deterministic
    // fingerprint three times before the loop kill cleared the ring.
    // (The selector matches the POISONED state exactly — the ring at
    // the haiku→parser boundary still carried mixed entries, because
    // only a loop kill clears it, not a done-advance.)
    const poisoned = delegate.goalHistory.find(
      state =>
        state.recentFingerprints.length === 3 &&
        state.recentFingerprints.every(fp => fp === 'd1:complete-rejected-no-evidence:task:1'),
    )
    expect(poisoned).toBeDefined()
    // T2 (row 9): the haiku's done RESET the K guard, so the parser's
    // single failure leaves the counter at 1 — no batchStagnation.
    expect(delegate.goal.consecutiveFailedTasks).toBe(1)
    expect(delegate.goal.pauseReason).toBeUndefined()
  })
})

describe('T1 (c) — D1 whitelist on activityKind (the REAL TranscriptItem shape)', () => {
  it('ACTION_ACTIVITY_KINDS is exactly the whitelist — and thinking is NOT in it', () => {
    expect([...ACTION_ACTIVITY_KINDS].sort()).toEqual([
      'command',
      'edit',
      'read',
      'search',
      'subagent',
      'terminal',
      'tool',
    ])
    // The trap the whitelist exists for: thinking must NEVER count as acting.
    expect(ACTION_ACTIVITY_KINDS).not.toContain('thinking')
  })

  it('counts every whitelisted kind as action', () => {
    const now = Date.now()
    const items = ACTION_ACTIVITY_KINDS.map(kind => activity(kind, now))
    expect(countActionActivities(items, now)).toBe(ACTION_ACTIVITY_KINDS.length)
  })

  it('does NOT count thinking, queued, context, compacting, permission, image or video', () => {
    const now = Date.now()
    const items: TranscriptItem[] = [
      activity('thinking', now),
      activity('queued', now),
      activity('context', now),
      activity('compacting', now),
      activity('permission', now),
      activity('image', now),
      activity('video', now),
    ]
    expect(countActionActivities(items, now)).toBe(0)
  })

  it('ignores items without activityKind (prose messages are not actions)', () => {
    const now = Date.now()
    expect(countActionActivities([messageItem(now)], now)).toBe(0)
  })

  it('respects the task window: before is excluded, the boundary millisecond counts', () => {
    const windowStart = 1_000
    const items: TranscriptItem[] = [
      activity('edit', 999), // before the window — excluded
      activity('edit', 1_000), // AT the boundary — counts
      activity('command', 1_001), // after — counts
    ]
    expect(countActionActivities(items, windowStart)).toBe(2)
  })

  it('DECLARED LIMIT (h): an edit that wrote GARBAGE still counts — the guard proves PRESENCE, not CORRECTNESS', () => {
    // This test documents its own limit on purpose: a green D1 check
    // must never be read as proof the work is right. An activity whose
    // content is nonsense passes the guard exactly like a good one.
    const now = Date.now()
    const garbageEdit: TranscriptItem = {
      ...activity('edit', now),
      text: 'wrote total garbage into the file',
      toolOutput: 'deleted the wrong function',
    }
    expect(countActionActivities([garbageEdit], now)).toBe(1)
  })
})

describe('T1 (b) — buildEvaluatorSnapshot (pure)', () => {
  it('returns the SAME object reference for legacy goals (byte-for-byte preservation)', () => {
    const goal = createGoalState({
      objective: 'Legacy goal',
      accessMode: 'approval',
      workingDirectory: '/tmp',
      skills: [],
    })
    expect(buildEvaluatorSnapshot(goal)).toBe(goal)
  })

  it('remaps objective and turnsRun per task, preserves everything else, does not mutate the goal', () => {
    const goal = makeBatchGoal([{ text: 'Task one' }, { text: 'Task two' }])
    goal.turnsRun = 7
    goal.turnsRunThisTask = 2
    const snapshot = buildEvaluatorSnapshot(goal)
    expect(snapshot).not.toBe(goal)
    expect(snapshot.objective).toBe('Task one')
    expect(snapshot.turnsRun).toBe(2)
    expect(snapshot.id).toBe(goal.id)
    expect(snapshot.ownerConversationId).toBe('conv-owner')
    expect(snapshot.workingDirectory).toBe(goal.workingDirectory)
    expect(snapshot.skills).toBe(goal.skills)
    // The original goal is untouched.
    expect(goal.objective).toBe('Ship feature X')
    expect(goal.turnsRun).toBe(7)
  })

  it('fails closed: a batch goal missing turnsRunThisTask snapshots turnsRun as 0', () => {
    const goal = makeBatchGoal([{ text: 'Task one' }])
    delete goal.turnsRunThisTask
    expect(buildEvaluatorSnapshot(goal).turnsRun).toBe(0)
  })

  it('clamps a stale taskIndex instead of crashing', () => {
    const goal = makeBatchGoal([{ text: 'Task one' }, { text: 'Task two' }])
    goal.taskIndex = 99
    expect(currentGoalTask(goal)?.text).toBe('Task two')
    expect(buildEvaluatorSnapshot(goal).objective).toBe('Task two')
  })
})

describe('T1 (a) — batch structure: creation and advance', () => {
  it('createGoalState builds one goal with N tasks: first active, rest pending, counters zeroed', () => {
    const goal = makeBatchGoal([
      { text: '  First task  ' },
      { text: 'Second task', toolless: true },
      { text: 'Third task' },
    ])
    expect(goal.tasks?.length).toBe(3)
    expect(goal.taskIndex).toBe(0)
    expect(goal.turnsRunThisTask).toBe(0)
    const [first, second, third] = goal.tasks as GoalTask[]
    expect(first.status).toBe('active')
    expect(first.startedAt).toBeTypeOf('number')
    expect(first.text).toBe('First task') // trimmed
    expect('completedAt' in first).toBe(false)
    expect(second.status).toBe('pending')
    expect('startedAt' in second).toBe(false)
    expect(second.toolless).toBe(true)
    expect(third.status).toBe('pending')
    expect('toolless' in third).toBe(false) // default REQUIRES evidence
    const ids = new Set(goal.tasks?.map(task => task.id))
    expect(ids.size).toBe(3)
  })

  it('createGoalState WITHOUT tasks keeps the batch keys ABSENT (legacy path)', () => {
    const goal = createGoalState({
      objective: 'Legacy',
      accessMode: 'approval',
      workingDirectory: '/tmp',
      skills: [],
    })
    expect('tasks' in goal).toBe(false)
    expect('taskIndex' in goal).toBe(false)
    expect('turnsRunThisTask' in goal).toBe(false)
  })

  it('advanceGoalTasks stamps done+completedAt on the finished task, active+startedAt on the next, mutates nothing else', () => {
    const goal = makeBatchGoal([{ text: 'One' }, { text: 'Two' }, { text: 'Three' }])
    const before = goal.tasks as GoalTask[]
    const now = Date.now()
    const after = advanceGoalTasks(before, 0, now)
    expect(after).not.toBe(before)
    expect(after[0].status).toBe('done')
    expect(after[0].completedAt).toBe(now)
    expect(after[1].status).toBe('active')
    expect(after[1].startedAt).toBe(now)
    expect(after[2]).toBe(before[2]) // untouched, same reference
    // Original array untouched.
    expect(before[0].status).toBe('active')
    expect('completedAt' in before[0]).toBe(false)
  })
})
