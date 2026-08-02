import type { GoalEvaluationEnvelope, GoalState, TokenUsage } from '../../../shared/types'

/**
 * G-C14: dedupe gate for token accumulation.
 *
 * The Rust side emits the turn-result event TWICE for a single turn —
 * the second emission carries the exit_code. Both events share the
 * same turnId and the same usage payload, so accumulating on every
 * event double-counts tokens (measured: 1-turn goal showed 79.695 on
 * screen but 159.390 in the store — exactly 2×).
 *
 * The App.tsx result-event handler records a snapshot per turnId in
 * `turnResultSnapshots.current` on every emission. The dedupe gate is:
 * if a snapshot ALREADY existed for this turnId when the event arrived,
 * this is the second emission — skip the token sum (but still update
 * the snapshot, because the second event carries the exit_code and
 * may carry a richer result).
 *
 * Extracted as a pure function so the gate is testable without React,
 * the store, or the full event handler. The handler calls this and
 * branches on the boolean.
 *
 * @param hadSnapshot - true if `turnResultSnapshots.current[turnId]`
 *   was already set when the event arrived.
 * @returns true if tokens should be accumulated (first emission),
 *   false if they should be skipped (second emission / duplicate).
 */
export function shouldAccumulateTokensForTurn(hadSnapshot: boolean): boolean {
  return !hadSnapshot
}

/**
 * T3: accumulate a TURN's token usage into the goal's running totals.
 *
 * Extracted as a pure function from the App.tsx result-event handler
 * (where it lived inline) so the G-C14 dedupe can be tested as the
 * EXACT sequence the handler runs — first emission (no snapshot →
 * accumulate) then the duplicate carrying exit_code (snapshot exists →
 * skip) — proving the compact turn's tokens are summed exactly ONCE.
 * A test against the inline handler code would only prove FORM; this
 * proves the EFFECT (the total grows once, not twice).
 *
 * The accumulation itself is byte-identical to the pre-T3 inline code,
 * including the G-C12 casing lesson: `event.result.usage` comes from
 * Rust via Tauri, which serializes TokenUsage with serde rename_all
 * camelCase — read camelCase keys. The old snake_case reads returned
 * undefined and the `?? 0` coalescing silently zeroed every
 * accumulation (worked in tests, always zero in production).
 *
 * Pure: returns a NEW GoalState; never mutates the input. The caller
 * (App.tsx) applies it to BOTH the React state (setGoal updater) and
 * goalRef.current — each store accumulates exactly once per emission.
 */
export function accumulateTurnUsage(
  goal: GoalState,
  usage: TokenUsage | undefined,
): GoalState {
  return {
    ...goal,
    usedInputTokens: goal.usedInputTokens + (usage?.inputTokens ?? 0),
    usedOutputTokens: goal.usedOutputTokens + (usage?.outputTokens ?? 0),
  }
}

/**
 * G-C17: accumulate the evaluator's own token usage across EVERY
 * evaluation of a goal.
 *
 * Regression context: G-C15-FIX stored `lastEvaluatorUsage` — the usage
 * of the LAST evaluation only, overwritten each cycle. In a goal with
 * several evaluation cycles only the final parcel reached the usage
 * line, while the label read "Total registrado". The evaluator burns
 * ~30-40k input tokens per cycle (29KB prompt), and a 1-turn goal
 * typically evaluates TWICE, so last-write-wins silently dropped a
 * parcel the size of a whole turn. QA blocking; the overwrite finding
 * is absorbed by this same fix (there is no "last" anymore — only the
 * running total).
 *
 * The evaluator usage arrives as `evaluatorUsage`, a SIBLING of
 * `evaluation` in GoalEvaluationEnvelope (G-C15-FIX), serialized by
 * Rust with `rename_all = "camelCase"` — read camelCase keys
 * (rustSerdeContract.test.ts pins both the casing and the placement).
 * Rust uses `skip_serializing_if Option::is_none`, so when the
 * evaluator ran no tokens the key is OMITTED from the JSON and arrives
 * as `undefined` — treat absence, not null. Both parcels coalesce with
 * `?? 0` so legacy goals persisted before G-C17 (no accumulator keys)
 * start from zero instead of NaN.
 *
 * Pure: returns a NEW GoalState; never mutates the input. The caller
 * (App.tsx evaluateGoal delegate) applies it to BOTH the React state
 * (via setGoal's updater) and goalRef.current — the two stores each
 * accumulate exactly once per envelope.
 */
export function accumulateEvaluatorUsage(
  goal: GoalState,
  usage: TokenUsage | undefined,
): GoalState {
  return {
    ...goal,
    evaluatorInputTokens: (goal.evaluatorInputTokens ?? 0) + (usage?.inputTokens ?? 0),
    evaluatorOutputTokens: (goal.evaluatorOutputTokens ?? 0) + (usage?.outputTokens ?? 0),
  }
}

/**
 * G-C17: dedupe gate for evaluator-usage accumulation.
 *
 * `evaluate_goal` is a single invoke → single response (NOT an event),
 * so the G-C14 double-emission defect (turn result events arriving
 * twice) does not apply to this path: each evaluation's envelope is a
 * freshly deserialized object, presented to the delegate exactly once,
 * and each one MUST be summed (two envelopes with identical payloads
 * are still two evaluations that each burned real tokens).
 *
 * The gate guards the one remaining re-entry vector: a future refactor
 * presenting the SAME envelope object to the accumulation site twice
 * (e.g. re-processing the stored result). Dedupe is by envelope
 * IDENTITY — the only honest key available, since evaluations carry no
 * id/timestamp and value-based dedupe would wrongly collapse distinct
 * evaluations that happen to return equal payloads.
 *
 * @param previousEnvelope - the envelope most recently accumulated
 *   (App.tsx keeps it in `lastEvaluatorEnvelopeRef`), undefined before
 *   the first evaluation of the goal.
 * @param nextEnvelope - the envelope that just arrived.
 * @returns true if nextEnvelope is a NEW evaluation (accumulate),
 *   false if it is the SAME object re-presented (skip the sum).
 */
export function shouldAccumulateEvaluatorUsage(
  previousEnvelope: GoalEvaluationEnvelope | undefined,
  nextEnvelope: GoalEvaluationEnvelope,
): boolean {
  return nextEnvelope !== previousEnvelope
}
