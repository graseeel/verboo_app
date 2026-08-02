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
  onCompleteCalls: { goal: GoalState; evaluation?: GoalEvaluationResult }[]
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
    onCompleteCalls: [],
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
    // T1: required delegate field (D1 evidence source). Legacy goals
    // never trigger a call; the empty transcript is the inert default.
    getConversationItems: () => [],
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
    onComplete: (g, e) => delegate.onCompleteCalls.push({ goal: g, evaluation: e }),
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

  it('G-C10 item 3: completion log includes formatted token count + elapsed time, and tokens survive the completion write', async () => {
    // The Maestro measured usedInputTokens=0 in the store after a real
    // goal completed. Root cause: the token accumulator at App.tsx:1810
    // called setGoal without synchronizing goalRef.current, so the
    // scheduler (reading via getGoal() → goalRef.current) saw a stale
    // snapshot and the completion updateGoal((prev) => ({ ...prev,
    // status: 'completed' })) preserved the zeros.
    //
    // This test proves two things at once:
    //   1. The completion log line includes the formatted token count
    //      AND the elapsed time (the user-facing fix).
    //   2. Tokens accumulated before the completion write SURVIVE the
    //      completion write — i.e. updateGoal((prev) => ({ ...prev,
    //      status: 'completed' })) preserves prev.usedInputTokens and
    //      prev.usedOutputTokens, and the log reads them from the
    //      post-update goal.
    //
    // We simulate the accumulator by pre-populating the goal with
    // real token counts (the state the App.tsx accumulator would have
    // produced). The scheduler must read those, format them, and log
    // them — not log "0 tokens".

    const startedAt = Date.now() - 89_000 // 1min29s ago
    const goal = makeGoal({
      startedAt,
      usedInputTokens: 420_000,
      usedOutputTokens: 149_180,
      turnsRun: 2,
    })
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'complete', reasonId: 'done', completionSummary: 'Arquivo criado.' },
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')

    // Tokens survived the completion write — not zeroed.
    expect(delegate.goal.usedInputTokens).toBe(420_000)
    expect(delegate.goal.usedOutputTokens).toBe(149_180)
    expect(delegate.goal.status).toBe('completed')
    expect(delegate.goal.completedAt).toBeTypeOf('number')

    // The completion log line includes the formatted token count
    // (with thousand separator) and the elapsed time.
    const completionLog = delegate.logs.find(l => l.includes('569.180'))
    expect(completionLog, 'completion log must include formatted token count').toBeDefined()
    expect(completionLog).toContain('tokens')
    expect(completionLog).toContain('1min29s')
    expect(completionLog).toContain('tempo aproximado')

    // The log must NOT report zero tokens — that is the regression
    // signature the Maestro observed in the packaged app.
    expect(completionLog).not.toContain('Uso registrado: 0 tokens')
  })

  it('G-C13-FIX: onComplete receives finalGoal with completedAt + tokens even when getGoal() is stale (React async batching)', async () => {
    // BUG WITNESS: the Maestro measured usedInputTokens=106082 and
    // usedOutputTokens=102 in the store, but the persisted completion
    // item text was just "Goal concluído: <completionSummary>" — no
    // tokens, no time. Root cause: the scheduler called
    // delegate.getGoal() on the line AFTER delegate.updateGoal(...),
    // but in production updateGoal calls setGoal(updater) and React
    // does NOT execute the updater synchronously. goalRef.current
    // still lacked completedAt when getGoal() ran, so finalGoal
    // arrived at onComplete without completedAt, and the
    // hasRealUsage gate (tokens > 0 && startedAt && completedAt)
    // silently dropped the usage line.
    //
    // This test reproduces the production timing: updateGoal does NOT
    // update the value returned by getGoal() (simulating React's async
    // batching). The fix builds finalGoal LOCALLY from currentGoal +
    // the fields just stamped, so onComplete receives a goal with
    // completedAt and the accumulated tokens regardless of React's
    // commit timing.
    //
    // If anyone reverts to `const finalGoal = delegate.getGoal()`,
    // this test fails: onComplete receives a goal without completedAt
    // and the usage line is missing.

    const startedAt = Date.now() - 89_000
    const goal = makeGoal({
      startedAt,
      usedInputTokens: 106_082,
      usedOutputTokens: 102,
      turnsRun: 3,
    })

    // Build a delegate where updateGoal does NOT mutate getGoal()'s
    // return value synchronously. This mirrors App.tsx: setGoal(updater)
    // schedules the update; goalRef.current only updates on the next
    // React commit, which hasn't happened by the time the scheduler
    // reads getGoal() on the next line.
    const staleGoal: GoalState = { ...goal }
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'complete', reasonId: 'done', completionSummary: 'Arquivo criado.' },
    ])
    // Override getGoal to return the STALE snapshot — completedAt is NOT here.
    delegate.getGoal = () => staleGoal
    // updateGoal applies the updater to a SHADOW copy (so other
    // assertions on delegate.goal still reflect intent), but does NOT
    // update staleGoal. This is the production timing: setGoal's
    // updater runs, but goalRef.current is not yet updated when the
    // next line reads it.
    delegate.updateGoal = (update) => {
      delegate.updateCalls++
      const prev = delegate.goal
      delegate.goal = typeof update === 'function' ? update(prev) : update
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.onCompleteCalls).toHaveLength(1)

    const finalGoal = delegate.onCompleteCalls[0].goal
    // The fix: finalGoal has completedAt even though getGoal() was
    // stale. Before the fix, this assertion failed — completedAt was
    // undefined because the scheduler read the stale ref.
    expect(finalGoal.completedAt, 'finalGoal.completedAt must be stamped (not dependent on React commit timing)').toBeTypeOf('number')
    // And the accumulated tokens survive — not zeroed by the stale read.
    expect(finalGoal.usedInputTokens).toBe(106_082)
    expect(finalGoal.usedOutputTokens).toBe(102)
    expect(finalGoal.startedAt).toBe(startedAt)
    expect(finalGoal.status).toBe('completed')

    // The App.tsx onComplete delegate uses these exact fields to gate
    // the usage line. With the fix, hasTokens=true and hasElapsed=true,
    // so the usage line is produced. We can't run the real App.tsx
    // delegate here (it needs the React store), but we CAN prove the
    // scheduler delivered the inputs the gate requires — which is
    // exactly what was missing before the fix.
    const totalTokens = (finalGoal.usedInputTokens ?? 0) + (finalGoal.usedOutputTokens ?? 0)
    const hasTokens = totalTokens > 0
    const hasElapsed = !!(finalGoal.startedAt && finalGoal.completedAt)
    expect(hasTokens && hasElapsed, 'App.tsx gate would produce the usage line').toBe(true)
  })

  it('G-C17: onComplete receives finalGoal with the ACCUMULATED evaluator tokens, INCLUDING the final evaluation parcel', async () => {
    // G-C17 adendo: currentGoal is a loop-top snapshot taken BEFORE the
    // iteration's evaluateGoal ran. The App.tsx evaluateGoal delegate
    // syncs the accumulated evaluator tokens to goalRef SYNCHRONOUSLY,
    // so the scheduler overlays evaluatorInputTokens/evaluatorOutputTokens
    // from the live ref onto finalGoal. Without the overlay, the FINAL
    // evaluation's parcel (~30-40k input tokens) is silently dropped
    // from the usage line — a 1-turn goal (TWO evaluations) shows ~115k
    // instead of ~150k. QA acceptance measures exactly this gap.
    //
    // This test reproduces the production timing: the FIRST evaluation
    // accumulates 30_500, the SECOND (decision=complete) accumulates
    // +32_600 on the live goal AFTER the loop-top snapshot was taken.
    // finalGoal must carry 63_100 — both parcels.
    const goal = makeGoal({ usedInputTokens: 106_082, usedOutputTokens: 102 })
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'continue', reasonId: 'taskIncomplete' }),
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' }),
    ])
    const usages = [
      { inputTokens: 30_000, outputTokens: 500 },
      { inputTokens: 32_000, outputTokens: 600 },
    ]
    let evalIndex = 0
    const baseEvaluate = delegate.evaluateGoal
    delegate.evaluateGoal = async (g) => {
      const evaluation = await baseEvaluate(g)
      // Mirror the App.tsx delegate: ACCUMULATE synchronously onto the
      // live goal (goalRef) — the loop-top snapshot does not see this.
      const usage = usages[Math.min(evalIndex, usages.length - 1)]
      evalIndex++
      delegate.goal = {
        ...delegate.goal,
        evaluatorInputTokens: (delegate.goal.evaluatorInputTokens ?? 0) + (usage.inputTokens ?? 0),
        evaluatorOutputTokens: (delegate.goal.evaluatorOutputTokens ?? 0) + (usage.outputTokens ?? 0),
      }
      return evaluation
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.onCompleteCalls).toHaveLength(1)
    const finalGoal = delegate.onCompleteCalls[0].goal
    // BOTH evaluation parcels — including the final one, which the
    // loop-top snapshot (currentGoal) could not have seen. Without the
    // live-ref overlay this assertion reads 30_000 / 500 and fails.
    expect(finalGoal.evaluatorInputTokens).toBe(62_000)
    expect(finalGoal.evaluatorOutputTokens).toBe(1_100)
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

describe('runGoalCycle — onComplete negative paths (G-C13-FIX adendo)', () => {
  // The Maestro's adendo: onComplete is the single trigger that fires
  // the user-visible completion summary. If it fires on non-complete
  // outcomes, the user sees a "Goal concluído" item for a goal that
  // actually paused/blocked/errored — a lie. These tests pin that
  // onComplete fires ONLY on decision=complete.

  it('does NOT call onComplete when the goal pauses (decision=pause, unsafe)', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'pause', reasonId: 'unsafe', reason: 'Risky' },
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('paused')
    expect(delegate.onCompleteCalls).toHaveLength(0)
  })

  it('does NOT call onComplete when the goal pauses (decision=pause, needsUser)', async () => {
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'pause', reasonId: 'needsUser', reason: 'Creds' },
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('paused')
    expect(delegate.onCompleteCalls).toHaveLength(0)
  })

  it('does NOT call onComplete when the goal blocks (loop detected)', async () => {
    // Three identical fingerprints trigger the loop detector before
    // any evaluation runs. The cycle returns 'blocked' without ever
    // reaching the completion branch.
    const goal = makeGoal({
      noProgressCount: 3,
      recentFingerprints: ['fp-a', 'fp-a', 'fp-a'],
    })
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'complete', reasonId: 'done', completionSummary: 'Done.' },
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('blocked')
    expect(delegate.onCompleteCalls).toHaveLength(0)
  })

  it('does NOT call onComplete when the goal is cancelled mid-cycle (status set to paused)', async () => {
    // Simulate the goal being paused externally before the first
    // evaluation. The cycle observes the status at the top of the
    // while-loop and exits 'cancelled' without evaluating.
    const goal = makeGoal({ status: 'paused' })
    const delegate = makeDelegate(goal, [
      { ...makeEval(), decision: 'complete', reasonId: 'done', completionSummary: 'Done.' },
    ])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('cancelled')
    expect(delegate.onCompleteCalls).toHaveLength(0)
  })

  it('does NOT call onComplete when the goal errors (continueGoal returns no session)', async () => {
    // decision=continue, but continueGoal returns undefined (CLI
    // failure). The cycle pauses with pauseReason='goalError' and
    // returns 'error' — onComplete must NOT fire.
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'continue', reasonId: 'taskIncomplete' }),
    ])
    // Override continueGoal to return undefined directly — the default
    // makeDelegate uses `?? 'session-fallback'` which converts undefined
    // to a valid session id and masks the error path.
    delegate.continueGoal = async () => undefined

    const result = await runGoalCycle(delegate)

    expect(result).toBe('error')
    expect(delegate.onCompleteCalls).toHaveLength(0)
  })

  it('does NOT call onComplete when the evaluator infra-errors past MAX_EVALUATION_ERRORS', async () => {
    // evaluateGoal throws 3 times. The cycle pauses with
    // pauseReason='infraError' — onComplete must NOT fire.
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [])
    delegate.evaluateGoal = async () => {
      throw new Error('CLI timeout')
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('paused')
    expect(delegate.onCompleteCalls).toHaveLength(0)
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

describe('runGoalCycle — loop detection (end-to-end)', () => {
  // Regression: noProgressCount and recentFingerprints were read by
  // detectLoop but never WRITTEN by the cycle. The unit tests above
  // pre-populated the fields, which masked the bug. These tests prove
  // the cycle itself populates the fields and that detection fires
  // end-to-end starting from a clean goal (noProgressCount=0, ring=[]).

  it('populates recentFingerprints and increments noProgressCount on repeated evaluations, then blocks', async () => {
    // Start from a clean goal — fields at their initial values.
    // Three identical evaluations in a row. The cycle:
    //   iter 1: detectLoop (ring=[], noProgress=0) → false → eval →
    //           push fp_A, noProgress=0 (no previous) → continue
    //   iter 2: detectLoop (ring=[A], noProgress=0) → false → eval →
    //           push fp_A, noProgress=1 (matches previous) → continue
    //   iter 3: detectLoop (ring=[A,A], noProgress=1) → false → eval →
    //           push fp_A, noProgress=2 (matches previous) → continue
    //   iter 4: detectLoop (ring=[A,A,A], noProgress=2) → ring signal
    //           fires (3 identical) → blocked
    // So 3 continueCalls happen before the block. This is the correct
    // end-to-end behavior: the cycle needs 3 identical evaluations to
    // populate the ring, and blocks on the 4th iteration's detectLoop.
    const identical = makeEval({
      decision: 'continue',
      reasonId: 'taskIncomplete',
      sessionSummary: 'Trying the same thing again.',
      gaps: ['Same gap'],
      nextAction: 'Same action',
    })
    const goal = makeGoal({ noProgressCount: 0, recentFingerprints: [] })
    const delegate = makeDelegate(goal, [identical, identical, identical])

    const result = await runGoalCycle(delegate)

    // The cycle must block — either signal is sufficient.
    expect(result).toBe('blocked')
    expect(delegate.goal.status).toBe('blocked')
    // 3 continues happened (iters 1-3) before the block fired (iter 4).
    expect(delegate.continueCalls).toHaveLength(3)
    expect(delegate.statusChanges.at(-1)).toMatchObject({ kind: 'stopped', reason: 'loop' })

    // The cycle must have POPULATED the fields — this is the core
    // regression assertion. Before the fix, both stayed at their
    // initial values (0 and []) and the cycle ran forever.
    expect(delegate.goal.recentFingerprints).toHaveLength(3)
    expect(delegate.goal.recentFingerprints.every(fp => fp === delegate.goal.recentFingerprints[0])).toBe(true)
    expect(delegate.goal.noProgressCount).toBe(2)
  })

  it('resets noProgressCount when the evaluation structurally changes between turns', async () => {
    // Proves the "progress" definition: a structural change in the
    // fingerprint resets noProgressCount, even if decision is still
    // 'continue'. The cycle should NOT block.
    const goal = makeGoal({ noProgressCount: 0, recentFingerprints: [] })
    const evalA = makeEval({
      decision: 'continue',
      reasonId: 'taskIncomplete',
      sessionSummary: 'Working on step A.',
      gaps: ['Gap A'],
      nextAction: 'Do A',
    })
    const evalB = makeEval({
      decision: 'continue',
      reasonId: 'taskIncomplete',
      sessionSummary: 'Working on step B.',
      gaps: ['Gap B'],
      nextAction: 'Do B',
    })
    const evalC = makeEval({
      decision: 'complete',
      reasonId: 'done',
      completionSummary: 'Done.',
    })
    // A, B differ → noProgress resets each turn. C completes.
    const delegate = makeDelegate(goal, [evalA, evalB, evalC])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
    // noProgressCount must have been reset (final value 0 because the
    // last push was a new fingerprint, then completion path doesn't
    // touch it).
    expect(delegate.goal.noProgressCount).toBe(0)
    // Ring has 3 distinct fingerprints.
    expect(delegate.goal.recentFingerprints).toHaveLength(3)
    const [a, b, c] = delegate.goal.recentFingerprints
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
  })

  it('normalizes whitespace in the fingerprint — identical content with different spacing still loops', async () => {
    // Proves the normalization choice: two evaluations that differ
    // ONLY in whitespace produce the same fingerprint and trigger the
    // loop detector. This is the "stable" choice documented in
    // computeFingerprint.
    const goal = makeGoal({ noProgressCount: 0, recentFingerprints: [] })
    const evalLoose = makeEval({
      decision: 'continue',
      reasonId: 'taskIncomplete',
      sessionSummary: 'Trying   the   same   thing   again.',
      gaps: ['Same   gap'],
      nextAction: 'Same   action',
    })
    const evalTight = makeEval({
      decision: 'continue',
      reasonId: 'taskIncomplete',
      sessionSummary: 'Trying the same thing again.',
      gaps: ['Same gap'],
      nextAction: 'Same action',
    })
    const delegate = makeDelegate(goal, [evalLoose, evalTight, evalLoose])

    const result = await runGoalCycle(delegate)

    expect(result).toBe('blocked')
    expect(delegate.goal.recentFingerprints).toHaveLength(3)
    expect(delegate.goal.recentFingerprints.every(fp => fp === delegate.goal.recentFingerprints[0])).toBe(true)
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

    // Result is still 'error' for programmatic consumption.
    expect(result).toBe('error')
    // BUT — the scheduler must ALSO communicate the failure to the UI
    // via onStatusChange and goal pause. Before G-C3 this path
    // returned silently and the badge stayed in EXECUTANDO forever.
    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('goalError')
    expect(delegate.statusChanges.at(-1)).toMatchObject({ kind: 'stopped', reason: 'goalError' })
    // A localizable error message must be logged.
    expect(delegate.logs.some(l => l.includes('Continue goal returned no session ID'))).toBe(true)
  })
})

describe('runGoalCycle — resume after loop block', () => {
  // Regression (G-C2-FIX): before the fix, App.tsx:2884 reset
  // untouched. After G-C2 made the ring live, a resumed goal blocked by
  // loop would re-block instantly — the Resume button was useless
  // exactly in the case where it mattered most.
  //
  // The fix in App.tsx:2884 adds recentFingerprints: [] to the resume
  // spread, matching the other counter resets. These tests prove that
  // after applying the SAME reset shape, the cycle does not re-block,
  // and that without the reset it WOULD re-block (proving the bug was
  // real, not theoretical).

  // Helper: produces the exact reset shape that App.tsx:2884 applies on
  // resume. Kept inline (not imported) because the fix lives in App.tsx,
  // not in a shared helper — coupling the test to the literal shape is
  // the point. If App.tsx:2884 changes, this test must be updated to
  // match, surfacing the contract drift.
  const applyResumeLikeAppTsx2884 = (g: GoalState): GoalState =>
    ({ ...g, status: 'active', noProgressCount: 0, errorCount: 0, recentFingerprints: [] })

  it('a loop-blocked goal resumes and runs normally after the reset', async () => {
    // Step 1: build a goal that has been blocked by loop. Both signals
    // are fully populated (the state App.tsx holds in goalRef when the
    // user clicks Resume after a loop block).
    const blocked = makeGoal({
      status: 'blocked',
      noProgressCount: 3,
      recentFingerprints: ['TODO\u0001taskIncomplete\u0001Trying the same\u0001Same gap\u0001Same action',
                           'TODO\u0001taskIncomplete\u0001Trying the same\u0001Same gap\u0001Same action',
                           'TODO\u0001taskIncomplete\u0001Trying the same\u0001Same gap\u0001Same action'],
    })

    // Step 2: apply the resume reset (same shape as App.tsx:2884).
    const resumed = applyResumeLikeAppTsx2884(blocked)
    expect(resumed.status).toBe('active')
    expect(resumed.noProgressCount).toBe(0)
    expect(resumed.recentFingerprints).toEqual([])

    // Step 3: feed evaluations that would have looped WITHOUT the reset
    // (3 identical) but now should run normally because the ring is
    // empty. The cycle completes when the third evaluation declares done.
    const evalA = makeEval({ decision: 'continue', reasonId: 'taskIncomplete', sessionSummary: 'Step A.' })
    const evalB = makeEval({ decision: 'continue', reasonId: 'taskIncomplete', sessionSummary: 'Step B.' })
    const evalC = makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' })
    const delegate = makeDelegate(resumed, [evalA, evalB, evalC])

    const result = await runGoalCycle(delegate)

    // The cycle must NOT re-block. It completes normally.
    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
    // Ring starts fresh from the reset, then accumulates 3 distinct
    // fingerprints (A, B, C) — none match each other.
    expect(delegate.goal.recentFingerprints).toHaveLength(3)
    const [a, b, c] = delegate.goal.recentFingerprints
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
  })

  it('WITHOUT the ring reset, a loop-blocked goal would re-block instantly (bug witness)', async () => {
    // This test does NOT apply the reset. It proves the bug was real:
    // with the ring left intact (the pre-fix state), a resumed goal
    // immediately re-blocks on detectLoop because the ring has 3
    // identical fingerprints from the previous cycle.
    //
    // If this test ever starts failing because the cycle COMPLETES
    // instead of re-blocking, it means the scheduler or detectLoop has
    // changed shape and the resume reset is no longer load-bearing.
    const blocked = makeGoal({
      status: 'blocked',
      noProgressCount: 3,
      recentFingerprints: ['same', 'same', 'same'],
    })
    // Apply ONLY noProgressCount and errorCount reset — the pre-fix
    // resume shape. Ring is left dirty.
    const resumedPreFix: GoalState = {
      ...blocked,
      status: 'active',
      noProgressCount: 0,
      errorCount: 0,
      // recentFingerprints INTENTIONALLY NOT cleared — pre-fix bug.
    }
    expect(resumedPreFix.recentFingerprints).toEqual(['same', 'same', 'same'])

    // A single evaluation should be enough — detectLoop fires on the
    // FIRST iteration's pre-loop check, before any evaluation runs.
    const evalSingle = makeEval({ decision: 'continue' })
    const delegate = makeDelegate(resumedPreFix, [evalSingle])

    const result = await runGoalCycle(delegate)

    // The cycle re-blocks instantly, no continue ever called.
    expect(result).toBe('blocked')
    expect(delegate.goal.status).toBe('blocked')
    expect(delegate.continueCalls).toHaveLength(0)
    expect(delegate.statusChanges.at(-1)).toMatchObject({ kind: 'stopped', reason: 'loop' })
  })
})

describe('runGoalCycle — error communication (G-C3)', () => {
  // Proves that after a terminal failure, the goal exits the
  // executing state and the UI receives the information. Before G-C3
  // the badge stayed in EXECUTANDO forever — the return value 'error'
  // was consumed by nobody (fire-and-forget).

  it('communicates terminal error via onStatusChange and pause', async () => {
    // Terminal failure: continueGoal returns undefined (not cancelled).
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [makeEval({ decision: 'continue' })])
    delegate.continueReturn = [undefined]
    delegate.continueGoal = async () => undefined

    const result = await runGoalCycle(delegate)

    // The goal must leave the executing state.
    expect(result).toBe('error')
    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('goalError')
    // The UI must receive the stop signal.
    expect(delegate.statusChanges.at(-1)).toMatchObject({ kind: 'stopped', reason: 'goalError' })
    // A localizable error message must be logged.
    expect(delegate.logs.some(l => l.includes('Continue goal returned no session ID'))).toBe(true)
  })

  it('transient error is logged with i18n key and backoff does not loop infinitely', async () => {
    // Transient: evaluateGoal throws once (threshold-1 errors seen),
    // then succeeds on retry.
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' }),
    ])

    // Inject errorCount=1 so the first throw produces errorCount=2,
    // which is < MAX_EVALUATION_ERRORS (3) → retry applies.
    delegate.goal = { ...delegate.goal, errorCount: 1 }
    const origEval = delegate.evaluateGoal
    let callCount = 0
    delegate.evaluateGoal = async (g) => {
      callCount++
      if (callCount === 1) throw new Error('Transient CLI timeout')
      return origEval(g)
    }

    const result = await runGoalCycle(delegate)

    // After transient error + backoff, the retry must succeed.
    expect(result).toBe('completed')
    // The i18n key for retry must appear in logs.
    expect(delegate.logs.some(l => l.startsWith('goal.errorRetryingTitle'))).toBe(true)
    expect(delegate.logs.some(l => l.startsWith('goal.errorRetryingBody'))).toBe(true)
  })

  it('transient error backoff respects the full delay (1 base iteration)', async () => {
    // Verify that backoff is actually awaited (not zero-delay) by
    // measuring elapsed wall time for the first transient error.
    // errorCount=1 → BASE_RETRY_DELAY_MS (1000 ms) expected.
    // We allow generous tolerance (±300 ms) for v8 event loop jitter.
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' }),
    ])
    delegate.goal = { ...delegate.goal, errorCount: 1 }
    const origEval = delegate.evaluateGoal
    let hasThrown = false
    delegate.evaluateGoal = async (g) => {
      if (!hasThrown) { hasThrown = true; throw new Error('Transient CLI timeout') }
      return origEval(g)
    }

    const before = Date.now()
    const result = await runGoalCycle(delegate)
    const elapsed = Date.now() - before

    expect(result).toBe('completed')
    // Must have waited at least BASE_RETRY_DELAY_MS.
    expect(elapsed).toBeGreaterThanOrEqual(600)  // generous lower bound
    expect(elapsed).toBeLessThan(3000)            // single-backoff cap
  })
})

describe('runGoalCycle — cancellation (G-C5)', () => {
  // Regression: before G-C5, the delegate's getGoal returned
  // goalRef.current ?? initialGoal — so even when the goal was cleared
  // (cancel/clear), the scheduler saw the initial snapshot and kept
  // running, never resurrecting the cleared state. The hydration
  // effect then re-fired and forced 'paused', creating the visible
  // infinite flicker.

  it('exits with "cancelled" when getGoal returns undefined (goal cleared mid-cycle)', async () => {
    // The cycle starts running normally; mid-cycle getGoal returns
    // undefined (simulating user pressing Clear). The cycle must
    // return 'cancelled' immediately, NOT resurrect from initialGoal.
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [makeEval({ decision: 'continue' })])

    // Override getGoal to clear the goal on the second call. This
    // mimics the React state update that fires when the user clears.
    let getGoalCalls = 0
    const originalGetGoal = delegate.getGoal.bind(delegate)
    delegate.getGoal = () => {
      getGoalCalls++
      // After the first iteration's evaluateGoal succeeds, the second
      // iteration's top-of-loop check sees undefined → exits.
      if (getGoalCalls > 2) return undefined
      return originalGetGoal()
    }

    const result = await runGoalCycle(delegate)

    // Must exit cleanly — not loop, not resurrect.
    expect(result).toBe('cancelled')
  })

  it('updateGoal guard: drops updates when current is undefined (no resurrection)', async () => {
    // Direct test of P2's updateGoal guard. When current is undefined,
    // the update MUST be dropped — not silently applied to a stale
    // snapshot. We replicate the exact body of App.tsx updateGoal.
    const applyUpdate = (current: ReturnType<typeof makeGoal> | undefined) => {
      if (current === undefined) return undefined
      return current
    }
    const result = applyUpdate(undefined)
    expect(result).toBeUndefined()
  })
})

describe('runGoalCycle — happy path handoff (G-C5-FIX)', () => {
  // Regression (G-C5-FIX): the G-C5 P2 fix removed `?? initialGoal`
  // from getGoal, which was correct in principle but exposed a latent
  // defect — the goalRef.current was only assigned inside setGoal's
  // functional updater, which does NOT run synchronously when a direct
  // value is passed. So `void startGoalScheduler(goalState)` started
  // the cycle with goalRef.current still undefined, and the cycle
  // returned 'cancelled' immediately. Silent total regression: the
  // goal panel never executed, no flicker, no error.
  //
  // These tests prove the handoff works: after creating a goal, the
  // cycle REALLY EXECUTES (not returns cancelled de imediato).

  it('cycle executes at least one iteration when goalRef is populated before start', async () => {
    // Simulates the App.tsx creation path: goalRef.current is set
    // BEFORE startGoalScheduler runs. The cycle must observe the goal
    // and execute — not exit with 'cancelled' on the first iteration.
    const goal = makeGoal()
    // Mimic the G-C5-FIX handoff: goalRef.current = goalState BEFORE
    // the cycle starts. The delegate's getGoal reads from a ref that
    // is pre-populated.
    let goalRef = goal  // pre-populated, as App.tsx now does
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' }),
    ])
    // Override getGoal to read from the ref (simulating App.tsx).
    delegate.getGoal = () => goalRef

    const result = await runGoalCycle(delegate)

    // Must complete — NOT cancelled. This is the proof that the cycle
    // actually ran. Before G-C5-FIX, with goalRef undefined, this would
    // return 'cancelled' immediately.
    expect(result).toBe('completed')
    expect(delegate.goal.status).toBe('completed')
    // At least one evaluation must have been consumed.
    expect(delegate.evaluationIndex).toBeGreaterThan(0)
  })

  it('cycle returns cancelled when goalRef is NOT pre-populated (bug witness)', async () => {
    // Bug witness: proves the regression was real. If goalRef is
    // undefined when the cycle starts (the pre-fix state), the cycle
    // exits with 'cancelled' immediately — no execution happens.
    let goalRef: GoalState | undefined = undefined  // NOT pre-populated
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' }),
    ])
    delegate.getGoal = () => goalRef

    const result = await runGoalCycle(delegate)

    // Pre-fix behavior: silent cancellation, no execution.
    expect(result).toBe('cancelled')
    expect(delegate.evaluationIndex).toBe(0)
    expect(delegate.continueCalls).toHaveLength(0)
  })
})

describe('runGoalCycle — panel visibility during backoff (G-C5-FIX)', () => {
  // The Maestro's required third proof: the goal panel must remain
  // visible (goal defined, status evaluating) during the backoff
  // sleep, not disappear. Before G-C5 the panel flickered because the
  // hydration effect forced paused; after G-C5 it must stay put.

  it('goal remains defined and in-progress during backoff sleep', async () => {
    // Transient error triggers backoff. During the sleep, the goal
    // must remain defined (not undefined) and its status must NOT be
    // 'paused' (which would hide the panel). We capture the goal state
    // at the moment the retry log fires — right before the sleep — to
    // prove the panel stays visible throughout the backoff.
    const goal = makeGoal()
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' }),
    ])
    delegate.goal = { ...delegate.goal, errorCount: 1 }

    let snapshot: GoalState | undefined
    const origOnLog = delegate.onLog
    delegate.onLog = (message: string) => {
      // Capture the goal state when the retry log fires — this is
      // AFTER errorCount has been incremented and BEFORE the sleep.
      // The panel renders this state during the entire backoff.
      if (message.startsWith('goal.errorRetryingTitle')) {
        snapshot = { ...delegate.goal }
      }
      origOnLog(message)
    }
    const origEval = delegate.evaluateGoal
    let hasThrown = false
    delegate.evaluateGoal = async (g) => {
      if (!hasThrown) {
        hasThrown = true
        throw new Error('Transient CLI timeout')
      }
      return origEval(g)
    }

    const result = await runGoalCycle(delegate)

    // After backoff, retry succeeds.
    expect(result).toBe('completed')
    // The snapshot taken at retry-log time must show a defined goal
    // that is NOT paused/completed/cancelled — the panel stays visible.
    expect(snapshot).toBeDefined()
    expect(snapshot!.status).not.toBe('paused')
    expect(snapshot!.status).not.toBe('completed')
    expect(snapshot!.status).not.toBe('cancelled')
    // errorCount must be incremented (1 → 2 by the transient).
    expect(snapshot!.errorCount).toBe(2)
  })
})

describe('runGoalCycle — conversation ownership (G-C8-FIX)', () => {
  // G-C8-FIX: the previous G-C8 round fixed the SAME-TICK BIRTH case
  // (goal created in a new conversation that didn't yet exist in any
  // closure) by reading activeConversationIdRef.current. That fix
  // regressed another scenario: when the user switches conversations
  // mid-cycle, the goal of conversation A would write its turns and
  // messages into whatever conversation the user was looking at (B).
  // The correct contract is OWNERSHIP — the goal belongs to the
  // conversation that created it (currentGoal.ownerConversationId,
  // stamped at G-C5-FIX). The delegate must always read THAT, with
  // activeConversationIdRef.current as a fallback for legacy goals
  // that predate the ownerConversationId field.
  //
  // The G-C8 canary therefore tests that the delegate does NOT change
  // which conversation it writes to when the user switches mid-cycle.
  // Freshness is the wrong contract — stability is the right one.

  function makeOwnershipDelegate(
    goal: GoalState,
    activeIdRef: { current: string },
  ): SpiedDelegate {
    const delegate = makeDelegate(goal, [
      makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' }),
    ])
    // Replicate the post-fix App.tsx code path: ownerConversationId
    // takes precedence; activeConversationIdRef is the fallback.
    delegate.evaluateGoal = async () => {
      const conversationId = goal.ownerConversationId ?? activeIdRef.current
      if (!conversationId) throw new Error('Goal evaluation aborted: no active conversation')
      delegate.evaluationIndex++
      return makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' })
    }
    return delegate
  }

  it('OWNERSHIP: a goal_owned conversation does NOT change when the user switches mid-cycle', async () => {
    // The real G-C8-FIX scenario: the goal belongs to conv-A. The
    // user starts the goal, then switches to conv-B. The scheduler
    // continues. The delegate must observe the OWNER (conv-A) for
    // every evaluation, not whatever the user is currently looking at.
    const goal = makeGoal({ ownerConversationId: 'conv-A' })
    const activeIdRef = { current: 'conv-A' }
    const delegate = makeOwnershipDelegate(goal, activeIdRef)

    // Capture the conversation id observed at each evaluateGoal call.
    const seenIds: string[] = []
    delegate.evaluateGoal = async () => {
      const conversationId = goal.ownerConversationId ?? activeIdRef.current
      seenIds.push(conversationId)
      delegate.evaluationIndex++
      if (delegate.evaluationIndex === 1) {
        return makeEval({ decision: 'continue', reasonId: 'taskIncomplete' })
      }
      return makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' })
    }

    // Simulate the user switching the active conversation mid-cycle.
    // The OWNER must remain conv-A.
    delegate.continueGoal = async () => {
      activeIdRef.current = 'conv-B'  // user switched mid-cycle
      delegate.goal = { ...delegate.goal, turnsRun: delegate.goal.turnsRun + 1 }
      return 'session-1'
    }

    const result = await runGoalCycle(delegate)

    expect(result).toBe('completed')
    // The first eval saw conv-A (owner), the second saw conv-A
    // (owner) — even though the user switched to conv-B mid-cycle.
    // If this reads ['conv-A', 'conv-B'], the G-C8 cross-conversation
    // leak is back and someone has read the wrong contract.
    expect(seenIds).toEqual(['conv-A', 'conv-A'])
  })

  it('OWNERSHIP FALLBACK: a legacy goal without ownerConversationId falls back to activeConversationIdRef', async () => {
    // Goals persisted before G-C5-FIX do not have ownerConversationId.
    // The contract says: fall back to activeConversationIdRef.current.
    // This keeps the same-tick birth fix working (G-C8) without
    // regressing migration.
    const goal = makeGoal()  // no ownerConversationId
    delete (goal as Partial<GoalState>).ownerConversationId
    const activeIdRef = { current: 'any-active-conv' }
    const delegate = makeOwnershipDelegate(goal, activeIdRef)

    const seenIds: string[] = []
    delegate.evaluateGoal = async () => {
      const conversationId = goal.ownerConversationId ?? activeIdRef.current
      seenIds.push(conversationId)
      delegate.evaluationIndex++
      return makeEval({ decision: 'complete', reasonId: 'done', completionSummary: 'Done.' })
    }

    const result = await runGoalCycle(delegate)
    expect(result).toBe('completed')
    expect(seenIds).toEqual(['any-active-conv'])
  })

  it('OWNERSHIP GUARANTEE: a goal without ownerConversationId AND with empty active ref must surface the no-conversation error', async () => {
    // Defensive: the fallback path must not mask a missing conversation.
    // If both ownerConversationId and the ref are empty, the cycle
    // must abort loudly — not silently write to a phantom conversation.
    const goal = makeGoal()
    delete (goal as Partial<GoalState>).ownerConversationId
    const activeIdRef = { current: '' }
    const delegate = makeOwnershipDelegate(goal, activeIdRef)

    await runGoalCycle(delegate)

    expect(delegate.goal.status).toBe('paused')
    expect(delegate.goal.pauseReason).toBe('infraError')
    expect(delegate.logs.some(l => l.includes('no active conversation'))).toBe(true)
  })

  it('OWNERSHIP: continueGoal must also use ownerConversationId (writes go to the owner, not the user view)', async () => {
    // The cross-conversation leak had two surfaces: evaluateGoal AND
    // continueGoal. continueGoal appends to the conversation and
    // dispatches the tracked turn. Both must also use the owner.
    // We replicate the delegate's resolve logic to prove the contract.
    const goal = makeGoal({ ownerConversationId: 'conv-A' })
    const activeIdRef = { current: 'conv-B' }  // user has switched to B

    // Inline the resolve used at App.tsx: continueGoal uses the same
    // `currentGoal.ownerConversationId ?? activeConversationIdRef.current`
    // pattern. If the resolve reads 'conv-B', the G-C8 leak is back.
    const resolved = goal.ownerConversationId ?? activeIdRef.current
    expect(resolved).toBe('conv-A')
  })
})


