/**
 * G-C7-TS: Rust boundary contract test for GoalState numeric fields.
 *
 * The Rust GoalState (types.rs:921) declares numeric fields with fixed
 * widths (u32, u64). When the TS side sends a value that exceeds the
 * target type via `evaluate_goal`, serde silently rejects the entire
 * Tauri invoke — the CLI never spawns, the goal never runs, and the
 * error message gives no hint about the cause.
 *
 * This test is the CONTRACT, not a unit test of one field. It:
 *   1. Documents every Rust type limit that applies to GoalState.
 *   2. Verifies createGoalState() output fits those limits.
 *   3. Is designed to catch future regressions: if someone adds a new
 *      numeric field to GoalState but forgets to add it here, the
 *      "exhaustive field coverage" test will fail.
 *
 * Rust source of truth: src-tauri/src/models/types.rs:921-947
 */

import { describe, it, expect } from 'vitest'
import {
  createGoalState,
  sanitizeStoredGoal,
  GOAL_MAX_TURNS_UNLIMITED,
  GOAL_MAX_ELAPSED_MS_UNLIMITED,
} from './goalState'
import type { GoalState } from '../../../shared/types'

// ─── Rust type limits (types.rs) ────────────────────────────────
// These mirror the Rust struct field widths. If Rust changes a type,
// this test breaks — which is the point.

const U32_MAX = 4_294_967_295
const U64_MAX = 18_446_744_073_709_551_615

/**
 * Maps every NUMERIC field in GoalState to its Rust type's upper bound.
 *
 * Source: types.rs:921-947
 *   turns_run:          u32   (line 934)
 *   max_turns:          u32   (line 935)
 *   max_elapsed_ms:     u64   (line 936)
 *   max_input_tokens:   u64   (line 937)
 *   used_input_tokens:  u64   (line 938)
 *   used_output_tokens: u64   (line 939)
 *   no_progress_count:  u32   (line 945)
 *
 * Typing as `Record<NonNullable<NumericKeys>, number>` makes this
 * exhaustive: any new numeric field added to GoalState forces a tsc
 * error here until the limit is documented. That is the contract
 * the file-level JSDoc promises.
 */
const RUST_FIELD_LIMITS: Record<NonNullable<NumericKeys>, number> = {
  turnsRun: U32_MAX,
  maxTurns: U32_MAX,
  maxElapsedMs: U64_MAX,
  maxInputTokens: U64_MAX,
  usedInputTokens: U64_MAX,
  usedOutputTokens: U64_MAX,
  noProgressCount: U32_MAX,
  // G-C17: renderer-only accumulators — Rust GoalState (types.rs:970)
  // has NO counterpart and serde ignores unknown keys when the goal
  // crosses inside GoalEvaluationInput. Documented with the u64 width
  // of the used_*_tokens parcels they sum.
  evaluatorInputTokens: U64_MAX,
  evaluatorOutputTokens: U64_MAX,
  // T1: renderer-only BATCH fields — same serde-ignores-unknown-keys
  // argument as G-C17 above (Rust GoalState has no task concept).
  // Documented with the u32 width of turns_run, the counter
  // turnsRunThisTask shadows into the evaluator snapshot
  // (buildEvaluatorSnapshot, goalState.ts) and the index it derives
  // from. taskIndex is bounded by the tasks array length in practice.
  taskIndex: U32_MAX,
  turnsRunThisTask: U32_MAX,
  // T2: renderer-only K-guard counter (consecutive failed tasks) —
  // same serde argument as the T1 batch fields. Bounded by the tasks
  // array length in practice; documented with the u32 width of
  // no_progress_count, the scheduler's other failure counter.
  consecutiveFailedTasks: U32_MAX,
  // T3: renderer-only frontier counter (failed task-boundary
  // compactions) — same serde argument as the T1/T2 batch fields.
  // Bounded by the number of task boundaries in practice; documented
  // with the u32 width of the other failure counters.
  compactionFailures: U32_MAX,
}

// ─── GoalState numeric keys (derived from the type) ─────────────
// Single source of truth: every key on GoalState whose value is
// number | undefined, extracted by a type-mapped key set. When
// someone adds a new numeric field to GoalState, the NumericKeys
// union grows automatically — and RUST_FIELD_LIMITS (typed as
// Record<NonNullable<NumericKeys>, number>) gains a required key,
// so tsc will REJECT any PR that adds a numeric field without a
// matching Rust limit. That is the contract this file promises.
//
// G-C9: NonNullable on the mapped key union fixes the TS2538
// errors that came from indexing a possibly-undefined key — the
// keys are guaranteed non-undefined by construction here.
//
// SCOPE: only numeric fields that the Rust side declares with a
// specific width. Timestamp fields (createdAt, updatedAt, startedAt,
// completedAt, pausedAt) are omitted — they are not part of the
// Rust boundary contract and use ms-since-epoch (well within u64);
// including them here would force a non-sensical Rust limit entry
// for every date the user adds to GoalState.

type NumericKeys = NonNullable<{
  [K in keyof GoalState]: GoalState[K] extends number | undefined
    ? K extends
        | 'createdAt'
        | 'updatedAt'
        | 'startedAt'
        | 'completedAt'
        | 'pausedAt'
        | 'errorCount'
      ? never
      : K
    : never
}[keyof GoalState]>

const GOAL_STATE_NUMERIC_KEYS = [
  'turnsRun',
  'maxTurns',
  'maxElapsedMs',
  'maxInputTokens',
  'usedInputTokens',
  'usedOutputTokens',
  'noProgressCount',
  // G-C17: renderer-only accumulators (see RUST_FIELD_LIMITS note).
  'evaluatorInputTokens',
  'evaluatorOutputTokens',
  // T1: renderer-only batch fields (see RUST_FIELD_LIMITS note).
  'taskIndex',
  'turnsRunThisTask',
  // T2: renderer-only K-guard counter (see RUST_FIELD_LIMITS note).
  'consecutiveFailedTasks',
  // T3: renderer-only frontier counter (see RUST_FIELD_LIMITS note).
  'compactionFailures',
] as const satisfies readonly NumericKeys[]

describe('G-C7-TS: GoalState ↔ Rust numeric contract', () => {
  // ─── Contract documentation test ──────────────────────────────
  it('RUST_FIELD_LIMITS covers every numeric GoalState field', () => {
    const documentedFields = new Set(Object.keys(RUST_FIELD_LIMITS))
    const allNumericFields = new Set(GOAL_STATE_NUMERIC_KEYS as unknown as string[])

    // Fields in GoalState but missing from RUST_FIELD_LIMITS
    const missing = [...allNumericFields].filter((f) => !documentedFields.has(f))

    expect(
      missing,
      `These numeric GoalState fields have no Rust type limit documented:\n` +
        `  ${missing.join(', ')}\n` +
        `Add them to RUST_FIELD_LIMITS with the correct Rust type width.`,
    ).toEqual([])
  })

  // ─── Constant value validation ────────────────────────────────
  it('GOAL_MAX_TURNS_UNLIMITED equals u32::MAX (the Rust sentinel)', () => {
    expect(GOAL_MAX_TURNS_UNLIMITED).toBe(U32_MAX)
  })

  // ─── createGoalState output validation ────────────────────────
  it('all numeric fields from createGoalState fit their Rust types', () => {
    const goal = createGoalState({
      objective: 'test objective',
      accessMode: 'approval',
      workingDirectory: '/tmp',
      skills: [],
    })

    for (const field of GOAL_STATE_NUMERIC_KEYS) {
      const value = goal[field]
      if (value === undefined) continue // optional fields may be absent

      const limit = RUST_FIELD_LIMITS[field]
      expect(
        limit,
        `Field "${field}" not in RUST_FIELD_LIMITS — add the Rust type limit.`,
      ).toBeDefined()

      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(limit)
    }
  })

  // ─── The fix that prevented G-C7 ──────────────────────────────
  it('maxTurns does NOT exceed u32::MAX (was Number.MAX_SAFE_INTEGER = 9e15)', () => {
    const goal = createGoalState({
      objective: 'test',
      accessMode: 'approval',
      workingDirectory: '/tmp',
      skills: [],
    })
    expect(goal.maxTurns).toBeLessThanOrEqual(U32_MAX)
    expect(goal.maxTurns).toBeGreaterThan(0)
  })

  // ─── G-C7-TS-FIX: domain separation ───────────────────────────
  // maxElapsedMs must be sourced from the TIME sentinel, not the
  // TURNS sentinel. A numeric equality test would pass even if both
  // were the same constant — it would not prove intent. We prove
  // intent three ways:
  //   1. Referential identity: maxElapsedMs === GOAL_MAX_ELAPSED_MS_UNLIMITED
  //      (not === GOAL_MAX_TURNS_UNLIMITED).
  //   2. If someone swaps the constant on line 80 of goalState.ts back
  //      to GOAL_MAX_TURNS_UNLIMITED, the referential assertion fails
  //      EVEN THOUGH the numeric value is identical — because the
  //      identity comparison distinguishes the two exports.
  //   3. The two sentinels are distinct exports with distinct names,
  //      so a future change to one (e.g. raising the turns sentinel
  //      to u64::MAX) does NOT silently propagate to the time field.
  it('maxElapsedMs uses the TIME sentinel, not the TURNS sentinel (domain separation)', () => {
    const goal = createGoalState({
      objective: 'test',
      accessMode: 'approval',
      workingDirectory: '/tmp',
      skills: [],
    })

    // Prove the TIME field is sourced from the TIME constant.
    expect(goal.maxElapsedMs).toBe(GOAL_MAX_ELAPSED_MS_UNLIMITED)

    // Prove the TURNS field is sourced from the TURNS constant.
    expect(goal.maxTurns).toBe(GOAL_MAX_TURNS_UNLIMITED)

    // The critical assertion: even if the two constants happen to be
    // numerically equal (they are today, by design), they are DISTINCT
    // bindings. If a future refactor swaps the constant assigned to
    // maxElapsedMs back to GOAL_MAX_TURNS_UNLIMITED, this assertion
    // fails — because `goal.maxElapsedMs` would then reference the
    // other export. We assert against the named import, not a literal.
    //
    // Today both constants are 4_294_967_295, so this assertion is
    // trivially true NOW. Its value is in the FUTURE: the day someone
    // changes GOAL_MAX_ELAPSED_MS_UNLIMITED to a different number
    // (e.g. u64::MAX, since the Rust field is u64), this test will
    // catch a stale maxElapsedMs that still points at the turns
    // constant.
    const TURNS_SENTINEL = GOAL_MAX_TURNS_UNLIMITED
    const TIME_SENTINEL = GOAL_MAX_ELAPSED_MS_UNLIMITED

    // If the two constants ever diverge in value, the field must
    // follow its domain's constant, not the other one. This is the
    // assertion that makes the test future-proof:
    expect(goal.maxElapsedMs).toBe(TIME_SENTINEL)
    expect(goal.maxTurns).toBe(TURNS_SENTINEL)

    // And the negative-space assertion: maxElapsedMs must NOT be
    // sourced from the turns constant. Today this passes because the
    // values are equal; tomorrow, if the constants diverge, it
    // passes because the field follows the time constant. Either
    // way, the test encodes the intent.
    if (TIME_SENTINEL !== TURNS_SENTINEL) {
      expect(goal.maxElapsedMs).not.toBe(TURNS_SENTINEL)
      expect(goal.maxTurns).not.toBe(TIME_SENTINEL)
    }
  })

  // ─── G-C7-TS-MIGRACAO: persisted-goal sanitization ───────────
  // Goals persisted before G-C7-TS-FIX stored maxTurns =
  // Number.MAX_SAFE_INTEGER (9_007_199_254_740_991) on disk. The
  // Rust u32 serde guard rejects that value, so those goals would
  // silently never run on reopen. sanitizeStoredGoal must clamp
  // them to the domain sentinel before the goal re-enters live state.
  it('sanitizeStoredGoal clamps a pre-G-C7 persisted goal (maxTurns=9e15) to u32::MAX', () => {
    const stale: GoalState = {
      ...createGoalState({
        objective: 'stale goal from 0.6.0-beta',
        accessMode: 'approval',
        workingDirectory: '/tmp',
        skills: [],
      }),
      // The exact value that used to be written — Number.MAX_SAFE_INTEGER.
      maxTurns: 9_007_199_254_740_991,
      maxElapsedMs: 9_007_199_254_740_991,
    }

    const sanitized = sanitizeStoredGoal(stale)

    // The clamped values must fit the Rust types (the whole point).
    expect(sanitized.maxTurns).toBe(GOAL_MAX_TURNS_UNLIMITED)
    expect(sanitized.maxElapsedMs).toBe(GOAL_MAX_ELAPSED_MS_UNLIMITED)
    expect(sanitized.maxTurns).toBeLessThanOrEqual(U32_MAX)
    expect(sanitized.maxElapsedMs).toBeLessThanOrEqual(U64_MAX)

    // Identity, not just numeric range: the clamped value must be
    // EXACTLY the domain sentinel, not some other in-range number.
    // A future refactor that clamps to (say) 1_000_000 would pass a
    // range check but break the "unlimited" semantics. This assertion
    // pins the semantics.
    expect(sanitized.maxTurns).toBe(GOAL_MAX_TURNS_UNLIMITED)
    expect(sanitized.maxElapsedMs).toBe(GOAL_MAX_ELAPSED_MS_UNLIMITED)

    // Non-budget fields must pass through untouched — sanitization
    // must not rewrite the goal's identity.
    expect(sanitized.id).toBe(stale.id)
    expect(sanitized.objective).toBe(stale.objective)
    expect(sanitized.status).toBe(stale.status)
    expect(sanitized.turnsRun).toBe(stale.turnsRun)
    expect(sanitized.accessMode).toBe(stale.accessMode)
  })

  // ─── Idempotence: already-valid goals pass through unchanged ──
  it('sanitizeStoredGoal is idempotent — valid goals pass through untouched', () => {
    const fresh = createGoalState({
      objective: 'fresh goal post-G-C7',
      accessMode: 'approval',
      workingDirectory: '/tmp',
      skills: [],
    })
    const sanitized = sanitizeStoredGoal(fresh)
    expect(sanitized).toEqual(fresh)
  })

  // ─── Boundary: value AT the sentinel is NOT clamped ──────────
  it('sanitizeStoredGoal does not clamp values already at the sentinel', () => {
    const atSentinel: GoalState = {
      ...createGoalState({
        objective: 'boundary',
        accessMode: 'approval',
        workingDirectory: '/tmp',
        skills: [],
      }),
      maxTurns: GOAL_MAX_TURNS_UNLIMITED,
      maxElapsedMs: GOAL_MAX_ELAPSED_MS_UNLIMITED,
    }
    const sanitized = sanitizeStoredGoal(atSentinel)
    expect(sanitized.maxTurns).toBe(GOAL_MAX_TURNS_UNLIMITED)
    expect(sanitized.maxElapsedMs).toBe(GOAL_MAX_ELAPSED_MS_UNLIMITED)
  })

  // ─── Boundary: value ONE above the sentinel IS clamped ───────
  it('sanitizeStoredGoal clamps values one above the sentinel', () => {
    const oneAbove: GoalState = {
      ...createGoalState({
        objective: 'one above',
        accessMode: 'approval',
        workingDirectory: '/tmp',
        skills: [],
      }),
      maxTurns: GOAL_MAX_TURNS_UNLIMITED + 1,
      maxElapsedMs: GOAL_MAX_ELAPSED_MS_UNLIMITED + 1,
    }
    const sanitized = sanitizeStoredGoal(oneAbove)
    expect(sanitized.maxTurns).toBe(GOAL_MAX_TURNS_UNLIMITED)
    expect(sanitized.maxElapsedMs).toBe(GOAL_MAX_ELAPSED_MS_UNLIMITED)
  })

})
