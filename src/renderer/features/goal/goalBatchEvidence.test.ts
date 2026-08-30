/**
 * T4: per-task EVIDENCE stamps — the data the final report cites.
 *
 * The report (goalReport.ts) can only cite what the scheduler stamps at
 * each terminal transition. These tests prove DISPARO + EFEITO on every
 * stamping path: done-advance (turns + actions), toolless waiver, the
 * loop-kill (failureReason 'loop'), unsafe, infraError at max, the skip
 * (turns) — plus the batchProgress payload that feeds the discreet
 * "Tarefa k de N" line.
 *
 * Harness mirrors goalFrontier.test.ts (same delegate shape); the
 * evidence guard's whitelist is exercised via real 'command' activities
 * appended by the continue-turn hook, never by mocking the counter.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { GoalEvaluationResult, GoalState, TranscriptItem } from '../../../shared/types'
import type { Translator } from '../../i18n'
import { runGoalCycle, type GoalSchedulerDelegate } from './goalScheduler'
import { createGoalState, skipBlockedGoalTask } from './goalState'
import type { GoalStatusBarState } from './GoalStatusBar'

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
const UNSAFE = makeEval({ decision: 'pause', reasonId: 'unsafe', reason: 'This is unsafe.' })
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

type EvidenceDelegate = GoalSchedulerDelegate & {
  goal: GoalState
  items: TranscriptItem[]
  evaluations: GoalEvaluationResult[]
  evaluationIndex: number
  statuses: GoalStatusBarState[]
  goalHistory: GoalState[]
  logs: string[]
  /** When true, evaluateGoal throws (infra failure simulation). */
  alwaysThrow: boolean
  onContinueTurn?: (callIndex: number) => void
}

function makeDelegate(
  goal: GoalState,
  evaluations: GoalEvaluationResult[],
  items: TranscriptItem[] = [],
): EvidenceDelegate {
  let continueCallIndex = 0
  const delegate: EvidenceDelegate = {
    goal,
    items,
    evaluations,
    evaluationIndex: 0,
    statuses: [],
    goalHistory: [],
    logs: [],
    alwaysThrow: false,
    getGoal: () => delegate.goal,
    updateGoal: (update) => {
      delegate.goal = typeof update === 'function' ? update(delegate.goal) : update
      delegate.goalHistory.push(delegate.goal)
    },
    evaluateGoal: async () => {
      if (delegate.alwaysThrow) throw new Error('Evaluator CLI timed out after 240s')
      const entry =
        delegate.evaluations[delegate.evaluationIndex] ??
        delegate.evaluations[delegate.evaluations.length - 1]
      delegate.evaluationIndex++
      return entry
    },
    getConversationItems: () => delegate.items,
    continueGoal: async (_goal, _nextMessage) => {
      continueCallIndex++
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
    onStatusChange: (status) => {
      delegate.statuses.push(status)
    },
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
function produceCommandEvidence(delegate: EvidenceDelegate): void {
  delegate.onContinueTurn = () => {
    delegate.items.push(activity('command', Date.now()))
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('T4 evidence stamps — done tasks cite turns + whitelisted actions', () => {
  it('done-advance stamps task 1; the terminal completion stamps the LAST task — both with turns AND evidenceCount', async () => {
    const goal = makeBatchGoal('First task', 'Last task')
    const delegate = makeDelegate(goal, [COMPLETE, COMPLETE])
    produceCommandEvidence(delegate)

    expect(await runGoalCycle(delegate)).toBe('completed')

    const [first, last] = delegate.goal.tasks ?? []
    // Task 1: completed at the ADVANCE write (eval#2, after 1 turn).
    expect(first.status).toBe('done')
    expect(first.turns).toBe(1)
    expect(first.evidenceCount).toBeGreaterThanOrEqual(1)
    // Task 2 (LAST): completed at the TERMINAL write.
    expect(last.status).toBe('done')
    expect(last.turns).toBe(1)
    expect(last.evidenceCount).toBeGreaterThanOrEqual(1)
  })

  it('toolless task: turns stamped, evidenceCount WAIVED (undefined) — the report must say "toolless"', async () => {
    const goal = createGoalState({
      objective: 'Ship the batch',
      accessMode: 'approval',
      workingDirectory: '/tmp/project',
      skills: [],
      tasks: [{ text: 'Write a haiku', toolless: true }, { text: 'Normal task' }],
    })
    goal.ownerConversationId = 'conv-owner'
    const delegate = makeDelegate(goal, [COMPLETE, COMPLETE])
    produceCommandEvidence(delegate)

    expect(await runGoalCycle(delegate)).toBe('completed')

    const [haiku] = delegate.goal.tasks ?? []
    expect(haiku.status).toBe('done')
    expect(haiku.turns).toBe(1)
    // CONTRAFACTUAL: actions existed in the window (produceCommandEvidence
    // ran) — an undefined here is the WAIVER, not an empty window.
    expect(haiku.evidenceCount).toBeUndefined()
  })
})

describe('T4 evidence stamps — failed tasks cite WHY', () => {
  it('loop-kill stamps failureReason loop + the turns the task ran', async () => {
    const goal = makeBatchGoal('Stuck task', 'Fine task')
    const delegate = makeDelegate(goal, [COMPLETE])
    produceCommandEvidence(delegate)
    delegate.goal = {
      ...delegate.goal,
      turnsRunThisTask: 2,
      recentFingerprints: ['fp', 'fp', 'fp'],
      noProgressCount: 2,
    }

    expect(await runGoalCycle(delegate)).toBe('completed')

    const [stuck, fine] = delegate.goal.tasks ?? []
    expect(stuck.status).toBe('failed')
    expect(stuck.failureReason).toBe('loop')
    expect(stuck.turns).toBe(2)
    expect(fine.status).toBe('done')
  })

  it('unsafe stamps failureReason unsafe + turns, and the WHOLE batch pauses', async () => {
    const goal = makeBatchGoal('Dangerous task', 'Never started')
    const delegate = makeDelegate(goal, [UNSAFE])

    expect(await runGoalCycle(delegate)).toBe('paused')

    expect(delegate.goal.pauseReason).toBe('unsafe')
    const [dangerous, neverStarted] = delegate.goal.tasks ?? []
    expect(dangerous.status).toBe('failed')
    expect(dangerous.failureReason).toBe('unsafe')
    expect(dangerous.turns).toBe(0)
    // Safety is not per-task: the batch stopped, task 2 never started.
    expect(neverStarted.status).toBe('pending')
  })

  it('infraError AT MAX stamps failureReason infraError and pauses (real backoff, ~3s)', async () => {
    const goal = makeBatchGoal('Evaluated task', 'Never started')
    const delegate = makeDelegate(goal, [COMPLETE])
    delegate.alwaysThrow = true // MAX_EVALUATION_ERRORS = 3 consecutive throws

    expect(await runGoalCycle(delegate)).toBe('paused')

    expect(delegate.goal.pauseReason).toBe('infraError')
    const [evaluated] = delegate.goal.tasks ?? []
    expect(evaluated.status).toBe('failed')
    expect(evaluated.failureReason).toBe('infraError')
  }, 20000)
})

describe('T4 evidence stamps — the skip carries its turns', () => {
  it('skipBlockedGoalTask stamps turns on the skipped task (pure transition)', () => {
    const goal = makeBatchGoal('Blocked task', 'Next task')
    goal.turnsRunThisTask = 2
    goal.tasks = goal.tasks!.map((task, index) =>
      index === 0 ? { ...task, status: 'blocked' as const } : task,
    )

    const skipped = skipBlockedGoalTask(goal, Date.now())

    expect(skipped.tasks?.[0].status).toBe('skipped')
    expect(skipped.tasks?.[0].turns).toBe(2)
    expect(skipped.tasks?.[0].failureReason).toBeUndefined()
  })

  it('end to end: a skipped task reaches the report with its turns (pause → skip → complete)', async () => {
    const goal = makeBatchGoal('Blocked task', 'Next task')
    const delegate = makeDelegate(goal, [NEEDS_USER, COMPLETE])
    produceCommandEvidence(delegate)

    expect(await runGoalCycle(delegate)).toBe('paused')
    delegate.goal = skipBlockedGoalTask(delegate.goal, Date.now())
    expect(await runGoalCycle(delegate)).toBe('completed')

    const [skippedTask] = delegate.goal.tasks ?? []
    expect(skippedTask.status).toBe('skipped')
    expect(skippedTask.turns).toBe(0)
  })
})

describe('T4 batchProgress payload — the "Tarefa k de N" source', () => {
  it('every evaluating status carries the fresh progress for a batch goal', async () => {
    const goal = makeBatchGoal('First task', 'Second task')
    const delegate = makeDelegate(goal, [COMPLETE, COMPLETE])
    produceCommandEvidence(delegate)

    expect(await runGoalCycle(delegate)).toBe('completed')

    const evaluating = delegate.statuses.filter(s => s.kind === 'evaluating')
    expect(evaluating.length).toBeGreaterThanOrEqual(3)
    for (const status of evaluating) {
      expect(status.kind === 'evaluating' && status.batchProgress).toBeTruthy()
    }
    // The first evaluation is on task 1; after the advance, task 2.
    const first = evaluating[0]
    const last = evaluating[evaluating.length - 1]
    expect(first.kind === 'evaluating' && first.batchProgress).toEqual({ current: 1, total: 2 })
    expect(last.kind === 'evaluating' && last.batchProgress).toEqual({ current: 2, total: 2 })
  })

  it('LEGACY goal: evaluating statuses carry NO batchProgress — single-task UI unchanged', async () => {
    const goal = createGoalState({
      objective: 'Single task goal',
      accessMode: 'approval',
      workingDirectory: '/tmp/project',
      skills: [],
    })
    goal.ownerConversationId = 'conv-owner'
    const delegate = makeDelegate(goal, [COMPLETE])

    expect(await runGoalCycle(delegate)).toBe('completed')

    const evaluating = delegate.statuses.filter(s => s.kind === 'evaluating')
    expect(evaluating.length).toBeGreaterThanOrEqual(1)
    for (const status of evaluating) {
      if (status.kind === 'evaluating') {
        expect(status.batchProgress).toBeUndefined()
      }
    }
  })
})
