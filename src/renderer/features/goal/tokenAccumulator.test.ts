/**
 * G-C14: dedupe test for token accumulation.
 *
 * Regression context: the Rust side emits the turn-result event TWICE
 * for a single turn (the second emission carries the exit_code). Both
 * events share the same turnId and the same usage payload. Before the
 * fix, the App.tsx result-event handler accumulated tokens on EVERY
 * emission, double-counting each turn. Measured: a 1-turn goal showed
 * 79.695 tokens on screen but 159.390 in the store — exactly 2×.
 *
 * The suite was GREEN with the doubled number because no test injected
 * two events with the same turnId. This file is that test.
 *
 * The test exercises the REAL dedupe gate (shouldAccumulateTokensForTurn)
 * that the App.tsx handler calls. It simulates the handler's snapshot
 * bookkeeping: the first event finds no snapshot (hadSnapshot=false →
 * accumulate), the second finds one (hadSnapshot=true → skip). The
 * assertion is on the accumulated total — it must equal ONE turn's
 * usage, not two.
 */

import { describe, it, expect } from 'vitest'
import type { GoalEvaluationEnvelope, GoalState, TokenUsage } from '../../../shared/types'
import {
  shouldAccumulateTokensForTurn,
  accumulateEvaluatorUsage,
  shouldAccumulateEvaluatorUsage,
} from './tokenAccumulator'

describe('G-C14: shouldAccumulateTokensForTurn — dedupe gate', () => {
  it('accumulates on the first emission (no prior snapshot)', () => {
    // First event for a turn: turnResultSnapshots.current[turnId] is
    // undefined → hadSnapshot=false → accumulate.
    expect(shouldAccumulateTokensForTurn(false)).toBe(true)
  })

  it('skips accumulation on the second emission (snapshot already exists)', () => {
    // Second event for the same turn: turnResultSnapshots.current[turnId]
    // was already set by the first event → hadSnapshot=true → skip.
    expect(shouldAccumulateTokensForTurn(true)).toBe(false)
  })

  it('simulates the full handler flow: two events same turnId → sum once', () => {
    // This is the test that would have caught the G-C14 bug. It mirrors
    // the App.tsx handler's bookkeeping exactly: record a snapshot per
    // turnId, check hadSnapshot BEFORE overwriting, accumulate only
    // when the gate returns true.
    //
    // Before the fix, the handler accumulated unconditionally — this
    // simulation would have summed 2× and the assertion would fail.
    const snapshots: Record<string, unknown> = {}
    let usedInputTokens = 0
    let usedOutputTokens = 0

    // The usage payload is identical in both emissions (same turn).
    const usage = { inputTokens: 79_695, outputTokens: 86 }
    const turnId = 'turn-1'

    // First emission (carries the result).
    const had1 = snapshots[turnId] !== undefined
    snapshots[turnId] = { result: 'first' }
    if (shouldAccumulateTokensForTurn(had1)) {
      usedInputTokens += usage.inputTokens
      usedOutputTokens += usage.outputTokens
    }

    // Second emission (carries the exit_code, same usage payload).
    const had2 = snapshots[turnId] !== undefined
    snapshots[turnId] = { result: 'second', exitCode: 0 }
    if (shouldAccumulateTokensForTurn(had2)) {
      usedInputTokens += usage.inputTokens
      usedOutputTokens += usage.outputTokens
    }

    // The fix: total is ONE turn's usage, not two.
    expect(usedInputTokens).toBe(79_695)
    expect(usedOutputTokens).toBe(86)
    // The bug would have produced 159_390 and 172 (exactly 2×).
    expect(usedInputTokens).not.toBe(159_390)
  })

  it('accumulates separately for different turnIds (no cross-turn dedupe)', () => {
    // Sanity: the dedupe is per-turnId, not global. Two different
    // turns must each accumulate once.
    const snapshots: Record<string, unknown> = {}
    let usedInputTokens = 0
    const usage = { inputTokens: 1_000, outputTokens: 50 }

    for (const turnId of ['turn-A', 'turn-B']) {
      const had = snapshots[turnId] !== undefined
      snapshots[turnId] = { result: 'first' }
      if (shouldAccumulateTokensForTurn(had)) {
        usedInputTokens += usage.inputTokens
      }
    }

    expect(usedInputTokens).toBe(2_000) // two distinct turns, each summed once
  })

  it('handles three emissions for the same turn (defensive — only first accumulates)', () => {
    // If the emitter ever sends a third emission (e.g. a late
    // exit_code update), the gate must still skip. Only the FIRST
    // emission (hadSnapshot=false) accumulates.
    const snapshots: Record<string, unknown> = {}
    let usedInputTokens = 0
    const usage = { inputTokens: 500, outputTokens: 10 }
    const turnId = 'turn-X'

    for (let i = 0; i < 3; i++) {
      const had = snapshots[turnId] !== undefined
      snapshots[turnId] = { emission: i }
      if (shouldAccumulateTokensForTurn(had)) {
        usedInputTokens += usage.inputTokens
      }
    }

    expect(usedInputTokens).toBe(500) // only the first emission
  })
})

/**
 * G-C17: evaluator-usage ACCUMULATION + dedupe.
 *
 * Regression context: G-C15-FIX stored `lastEvaluatorUsage` — the usage
 * of the LAST evaluation, overwritten each cycle. In a multi-evaluation
 * goal only the final parcel reached the "Total registrado" line. The
 * evaluator burns ~30-40k input tokens per cycle and a 1-turn goal
 * typically evaluates TWICE, so last-write-wins dropped a parcel the
 * size of a whole turn (screen read ~115k instead of ~150k). QA
 * blocking. The fix ACCUMULATES every evaluation's parcel.
 *
 * The dedupe half: evaluate_goal is a single invoke → single response
 * (NOT an event), so the G-C14 double-emission does not apply here —
 * but the Maestro ordered explicit prevention. The gate dedupes by
 * envelope IDENTITY: re-presenting the SAME envelope object skips the
 * sum; a NEW envelope (even with an identical payload — a distinct
 * evaluation that burned real tokens) always accumulates.
 */

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'goal-1',
    objective: 'Create /tmp/test.txt',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnsRun: 1,
    usedInputTokens: 79_695,
    usedOutputTokens: 86,
    noProgressCount: 0,
    recentFingerprints: [],
    accessMode: 'approval',
    workingDirectory: '/tmp',
    skills: [],
    ...overrides,
  }
}

function makeEnvelope(evaluatorUsage: TokenUsage | undefined): GoalEvaluationEnvelope {
  return {
    evaluation: {
      decision: 'continue',
      reasonId: 'taskIncomplete',
      reason: 'Still working',
      gaps: [],
      confidence: 0.8,
    },
    // `undefined` mirrors the Rust skip_serializing_if omission — the
    // key is ABSENT from the JSON when the evaluator ran no tokens.
    evaluatorUsage,
  }
}

describe('G-C17: accumulateEvaluatorUsage — accumulate, NOT last-write-wins', () => {
  it('sums TWO evaluations with different usage (proves accumulation, not replacement)', () => {
    // The test the Maestro ordered: two evaluations with different
    // usage must SUM both parcels — with the old lastEvaluatorUsage the
    // result would be the second parcel alone (32_000 / 600).
    let goal = makeGoal()
    goal = accumulateEvaluatorUsage(goal, { inputTokens: 30_000, outputTokens: 500 })
    goal = accumulateEvaluatorUsage(goal, { inputTokens: 32_000, outputTokens: 600 })

    expect(goal.evaluatorInputTokens).toBe(62_000)
    expect(goal.evaluatorOutputTokens).toBe(1_100)
    // The bug would have produced exactly the last parcel:
    expect(goal.evaluatorInputTokens).not.toBe(32_000)
    expect(goal.evaluatorOutputTokens).not.toBe(600)
  })

  it('grows across EVERY additional cycle (multi-turn acceptance: value must not stay constant)', () => {
    // QA acceptance criterion: in a multi-turn goal the displayed total
    // must GROW with each additional evaluation cycle — a constant
    // value between cycles means the accumulator regressed to
    // last-write-wins.
    let goal = makeGoal()
    const usage = { inputTokens: 35_000, outputTokens: 500 }
    const totals: number[] = []
    for (let cycle = 0; cycle < 3; cycle++) {
      goal = accumulateEvaluatorUsage(goal, usage)
      totals.push(goal.evaluatorInputTokens ?? 0)
    }
    expect(totals).toEqual([35_000, 70_000, 105_000])
    expect(totals[2]).toBeGreaterThan(totals[1])
    expect(totals[1]).toBeGreaterThan(totals[0])
  })

  it('treats absent usage as +0 (undefined, not null — Rust skip_serializing_if)', () => {
    let goal = makeGoal()
    goal = accumulateEvaluatorUsage(goal, undefined)
    expect(goal.evaluatorInputTokens).toBe(0)
    expect(goal.evaluatorOutputTokens).toBe(0)
    // And it must not poison a later real parcel with NaN:
    goal = accumulateEvaluatorUsage(goal, { inputTokens: 30_000, outputTokens: 500 })
    expect(goal.evaluatorInputTokens).toBe(30_000)
    expect(goal.evaluatorOutputTokens).toBe(500)
  })

  it('handles partial usage (only inputTokens present) — output stays at +0', () => {
    const goal = accumulateEvaluatorUsage(makeGoal(), { inputTokens: 10_000, outputTokens: undefined })
    expect(goal.evaluatorInputTokens).toBe(10_000)
    expect(goal.evaluatorOutputTokens).toBe(0)
  })

  it('starts a legacy goal (no accumulator keys, pre-G-C17) from zero — no NaN', () => {
    // Legacy stored goals lack evaluatorInputTokens/evaluatorOutputTokens
    // entirely. `undefined + number` would be NaN — the ?? 0 coalescing
    // is the guard.
    const legacy = makeGoal()
    delete legacy.evaluatorInputTokens
    delete legacy.evaluatorOutputTokens
    const goal = accumulateEvaluatorUsage(legacy, { inputTokens: 30_000, outputTokens: 500 })
    expect(goal.evaluatorInputTokens).toBe(30_000)
    expect(goal.evaluatorOutputTokens).toBe(500)
  })

  it('does NOT touch the turn parcels or mutate the input goal (pure)', () => {
    const original = makeGoal()
    const updated = accumulateEvaluatorUsage(original, { inputTokens: 30_000, outputTokens: 500 })
    expect(updated.usedInputTokens).toBe(79_695)
    expect(updated.usedOutputTokens).toBe(86)
    expect(original.evaluatorInputTokens).toBeUndefined()
    expect(updated).not.toBe(original)
  })
})

describe('G-C17: shouldAccumulateEvaluatorUsage — same evaluation counted twice does NOT inflate', () => {
  it('simulates the delegate flow: same envelope re-presented → summed once', () => {
    // The second test the Maestro ordered. Mirrors the App.tsx
    // delegate bookkeeping exactly: keep the last accumulated envelope
    // in a ref, gate on identity BEFORE accumulating.
    let lastEnvelope: GoalEvaluationEnvelope | undefined
    let goal = makeGoal()
    const envelope = makeEnvelope({ inputTokens: 30_000, outputTokens: 500 })

    // First presentation — a real evaluation.
    if (shouldAccumulateEvaluatorUsage(lastEnvelope, envelope)) {
      lastEnvelope = envelope
      goal = accumulateEvaluatorUsage(goal, envelope.evaluatorUsage)
    }
    // Same envelope object re-presented (defensive: refactor re-entry).
    if (shouldAccumulateEvaluatorUsage(lastEnvelope, envelope)) {
      lastEnvelope = envelope
      goal = accumulateEvaluatorUsage(goal, envelope.evaluatorUsage)
    }

    expect(goal.evaluatorInputTokens).toBe(30_000) // NOT 60_000
    expect(goal.evaluatorOutputTokens).toBe(500)
  })

  it('two DISTINCT envelopes with IDENTICAL payloads both accumulate (value-dedupe would be a lie)', () => {
    // Two evaluations that return equal usage are still TWO evaluations
    // that each burned real tokens. Dedupe by VALUE would wrongly
    // collapse them; identity dedupe keeps both.
    let lastEnvelope: GoalEvaluationEnvelope | undefined
    let goal = makeGoal()
    const payload = { inputTokens: 35_000, outputTokens: 500 }

    for (const envelope of [makeEnvelope(payload), makeEnvelope(payload)]) {
      if (shouldAccumulateEvaluatorUsage(lastEnvelope, envelope)) {
        lastEnvelope = envelope
        goal = accumulateEvaluatorUsage(goal, envelope.evaluatorUsage)
      }
    }

    expect(goal.evaluatorInputTokens).toBe(70_000)
    expect(goal.evaluatorOutputTokens).toBe(1_000)
  })

  it('gate basics: undefined previous accumulates; same reference skips; new reference accumulates', () => {
    const a = makeEnvelope({ inputTokens: 1, outputTokens: 1 })
    const b = makeEnvelope({ inputTokens: 1, outputTokens: 1 })
    expect(shouldAccumulateEvaluatorUsage(undefined, a)).toBe(true)
    expect(shouldAccumulateEvaluatorUsage(a, a)).toBe(false)
    expect(shouldAccumulateEvaluatorUsage(a, b)).toBe(true)
  })
})
