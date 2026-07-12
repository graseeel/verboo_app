import { describe, it, expect, vi } from 'vitest'
import type { GoalEvaluationResult, GoalState } from '../../../shared/types'
import type { Translator } from '../../i18n'
import { runGoalCycle, MAX_EVALUATION_ERRORS, type GoalSchedulerDelegate } from './goalScheduler'

/**
 * Stub translator: returns the key verbatim (with params interpolated)
 * so tests can assert which i18n key was selected without depending on
 * the real translation table.
 */
const t: Translator = ((key: string, params?: Record<string, unknown>) => {
  if (!params) return key
  return key + ':' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')
}) as Translator

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  const now = Date.now()
  return {
    id: 'goal:test',
    objective: 'Ship the login endpoint',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    turnsRun: 0,
    maxTurns: 5,
    maxElapsedMs: 30 * 60 * 1000,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    accessMode: 'approval',
    workingDirectory: '/tmp/project',
    skills: [],
    noProgressCount: 0,
    recentFingerprints: [],
    ...overrides,
  }
}

function makeEval(overrides: Partial<GoalEvaluationResult> = {}): GoalEvaluationResult {
  return {
    decision: 'continue',
    reasonId: 'taskIncomplete',
    reason: 'Still working',
    sessionSummary: 'Wrote the route handler.',
    gaps: ['Add error handling'],
    nextAction: 'Implement 404 branch',
    completionSummary: undefined,
    confidence: 0.8,
    ...overrides,
  }
}

type SpiedDelegate = GoalSchedulerDelegate & {
  goal: GoalState
  evaluations: GoalEvaluationResult[]
  evaluationIndex: number
  continueCalls: { goal: GoalState; nextMessage: string }[]
  continueReturn: (string | undefined)[]
  continueIndex: number
  abortCalls: number
  statusChanges: unknown[]
  logs: string[]
  updateCalls: number
}

function makeDelegate(initialGoal: GoalState, evaluations: GoalEvaluationResult[]): SpiedDelegate {
  const delegate: SpiedDelegate = {
    goal: initialGoal,
    evaluations,
    evaluationIndex: 0,
    continueCalls: [],
    continueReturn: ['session-1', 'session-2', 'session-3'],
    continueIndex: 0,
    abortCalls: 0,
    statusChanges: [],
    logs: [],
    updateCalls: 0,
    getGoal: () => delegate.goal,
    updateGoal: (update) => {
      delegate.updateCalls++
      const prev = delegate.goal
      delegate.goal = typeof update === 'function' ? update(prev) : update
    },
    evaluateGoal: async () => {
      const evalResult = delegate.evaluations[delegate.evaluationIndex] ?? delegate.evaluations[delegate.evaluations.length - 1]
      delegate.evaluationIndex++
      return evalResult
    },
    continueGoal: async (goal, nextMessage) => {
      delegate.continueCalls.push({ goal, nextMessage })
      const sessionId = delegate.continueReturn[delegate.continueIndex] ?? 'session-fallback'
      delegate.continueIndex++
      // Simulate turn increment after continuation
      delegate.goal = { ...delegate.goal, turnsRun: delegate.goal.turnsRun + 1 }
      return sessionId
    },
    abortTurn: () => { delegate.abortCalls++ },
    onStatusChange: (status) => { delegate.statusChanges.push(status) },
    onLog: (message) => { delegate.logs.push(message) },
    t,
  }
  return delegate
}

describe('runGoalCycle — happy paths', () => {
  it('completes when evaluator returns decision=complete', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'complete', reasonId: 'done', completionSummary: 'All shipped.' },
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
    expect(delegate.goal.completedAt).toBeTypeOf('number')
    expect(delegate.goal.lastEvaluation?.decision).toBe('complete')
    expect(delegate.continueCalls).toHaveLength(0)
    expect(delegate.statusChanges.at(-1)).toMatchObject({ kind: 'completed' })
  })

  it('continues with structured prompt when evaluator returns decision=continue', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'continue', reasonId: 'taskIncomplete' }),
      { ...makeEval(), decision: 'complete', reasonId: 'done', completionSummary: 'Done.' },
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.continueCalls).toHaveLength(1)
    // buildContinuePrompt always includes the objective as a heading
    expect(delegate.continueCalls[0].nextMessage).toContain('## Continuing toward: Ship the login endpoint')
    // And the autonomy directive
    expect(delegate.continueCalls[0].nextMessage).toContain('Continue autonomously')
  })
})

describe('runGoalCycle — pause paths', () => {
  it('pauses on decision=pause with reasonId=unsafe', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'pause', reasonId: 'unsafe', reason: 'Risky operation detected' },
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('paused')
    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('unsafe')
    expect(delegate.goal.pausedAt).toBeTypeOf('number')
    expect(delegate.continueCalls).toHaveLength(0)
    expect(delegate.statusChanges.at(-1)).toMatchObject({ kind: 'stopped', reason: 'unsafe' })
  })

  it('pauses on decision=pause with reasonId=needsUser', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'pause', reasonId: 'needsUser', reason: 'Needs credentials' },
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('needsUser')
  })

  it('does NOT pause on decision=pause with reasonId=taskFailure (continue-eligible)', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'pause', reasonId: 'taskFailure', reason: 'Tests failing' },
      { ...makeEval(), decision: 'complete', reasonId: 'done', completionSummary: 'Fixed.' },
    ])

    const result = await runGoalCycle(delegate)

    // taskFailure should fall through to continue path, not pause
    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
    expect(delegate.continueCalls).toHaveLength(1)
    expect(delegate.goal.pauseReason).toBeUndefined()
  })

  it('does NOT pause on decision=pause with reasonId=taskIncomplete (continue-eligible)', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'pause', reasonId: 'taskIncomplete', reason: 'Still working' },
      { ...makeEval(), decision: 'complete', reasonId: 'done', completionSummary: 'Done.' },
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.continueCalls).toHaveLength(1)
    expect(delegate.goal.pauseReason).toBeUndefined()
  })
})

describe('runGoalCycle — safety budget is DEAD CODE (no pause path)', () => {
  // Per goal-mode-out-of-beta spec: maxTurns/maxElapsed are no longer
  // enforced. The scheduler comment at goalScheduler.ts:53-57 states:
  // "No budget enforcement — tokens and time are unlimited in Verboo.
  //  maxTurns/maxElapsed fields remain on GoalState for backwards
  //  compatibility but are set to Number.MAX_SAFE_INTEGER and never
  //  trigger a pause."
  // These tests verify the dead-code guarantee: even with budget
  // exhausted values, the scheduler proceeds to evaluation (not pause).

  it('does NOT pause when maxTurns reached — proceeds to evaluation', async () => {
    const goal = makeGoal({ turnsRun: 5, maxTurns: 5 })
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'complete', reasonId: 'done', completionSummary: 'Done.' },
    ])

    const result = await runGoalCycle(delegate)

    // Scheduler ignores maxTurns and proceeds to evaluator
    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
    expect(delegate.goal.pauseReason).toBeUndefined()
    expect(delegate.evaluationIndex).toBe(1) // evaluator WAS called
  })

  it('does NOT pause when maxElapsedMs exceeded — proceeds to evaluation', async () => {
    const goal = makeGoal({
      startedAt: Date.now() - 31 * 60 * 1000, // 31 min ago
      maxElapsedMs: 30 * 60 * 1000, // 30 min limit
    })
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'complete', reasonId: 'done', completionSummary: 'Done.' },
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
    expect(delegate.goal.pauseReason).toBeUndefined()
  })
})

describe('runGoalCycle — infra error circuit breaker', () => {
  it('pauses after MAX_EVALUATION_ERRORS consecutive evaluator failures', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [])
    // Override evaluateGoal to always throw
    delegate.evaluateGoal = async () => {
      throw new Error('CLI timeout')
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('paused')
    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('infraError')
    expect(delegate.goal.errorCount).toBe(MAX_EVALUATION_ERRORS)
    expect(delegate.continueCalls).toHaveLength(0)
    // Should have logged each error attempt
    expect(delegate.logs.some(l => l.includes('Evaluator error #1'))).toBe(true)
    expect(delegate.logs.some(l => l.includes(`Evaluator error #${MAX_EVALUATION_ERRORS}`))).toBe(true)
    expect(delegate.statusChanges.at(-1)).toMatchObject({ kind: 'stopped', reason: 'infraError' })
  })

  it('does NOT pause if errors are interspersed with successes (counter resets)', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'continue' }), // success
    ])
    let callCount = 0
    delegate.evaluateGoal = async () => {
      callCount++
      if (callCount === 1) throw new Error('transient')
      if (callCount === 2) throw new Error('transient')
      // Third call succeeds — counter should reset
      return makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' })
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
    expect(delegate.goal.errorCount).toBe(0) // reset on success
    expect(delegate.goal.pauseReason).toBeUndefined()
  })

  it('resets errorCount to 0 on successful evaluation after failures', async () => {
    const goal = makeGoal({ errorCount: 2 })
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' }),
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.goal.errorCount).toBe(0)
  })
})

describe('runGoalCycle — loop detection', () => {
  it('blocks when noProgressCount >= 3', async () => {
    const goal = makeGoal({ noProgressCount: 3 })
    const delegate = makeDelegate(goal, [])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('blocked')
    expect(delegate.goal.status).toBe('blocked')
    expect(delegate.continueCalls).toHaveLength(0)
    expect(delegate.statusChanges.at(-1)).toMatchObject({ kind: 'stopped', reason: 'loop' })
  })

  it('blocks when 3 identical recentFingerprints', async () => {
    const goal = makeGoal({
      recentFingerprints: ['abc', 'abc', 'abc'],
    })
    const delegate = makeDelegate(goal, [])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('blocked')
    expect(delegate.goal.status).toBe('blocked')
  })

  it('does NOT block when fingerprints differ', async () => {
    const goal = makeGoal({
      recentFingerprints: ['abc', 'def', 'ghi'],
    })
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' }),
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
  })
})

describe('runGoalCycle — cancellation', () => {
  it('returns cancelled when goal is undefined', async () => {
    const delegate = makeDelegate(makeGoal(), [])
    delegate.goal = undefined as unknown as GoalState

    const result = await runGoalCycle(delegate)

    expect(result).toBe('cancelled')
  })

  it('returns cancelled when goal is cleared before evaluation', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [makeEval()])
    // Simulate external clear after first iteration: evaluator returns
    // continue, but goal is cleared before next loop iteration.
    let evalCalled = false
    delegate.evaluateGoal = async () => {
      if (evalCalled) throw new Error('should not be called twice')
      evalCalled = true
      return makeEval({ decision: 'continue' })
    }
    delegate.continueGoal = async () => {
      // Simulate goal cleared during continue
      delegate.goal = undefined as unknown as GoalState
      return 'session-1'
    }

    const result = await runGoalCycle(delegate)

    // Next loop iteration sees goal=undefined → returns cancelled
    expect(result).toBe('cancelled')
  })

  it('returns error when continueGoal returns no session ID', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [makeEval({ decision: 'continue' })])
    delegate.continueReturn = [undefined]
    // Override continueGoal to NOT increment turnsRun (simulates interrupted)
    delegate.continueGoal = async () => undefined

    const result = await runGoalCycle(delegate)

    expect(result).toBe('error')
  })
})
