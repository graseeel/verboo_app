import type { AccessMode, GoalState, SkillSummary, TranscriptItem } from '../../../shared/types'

/**
 * "Unlimited" sentinel for numeric fields that Rust declares as u32.
 *
 * The Rust GoalState (types.rs:935) declares `max_turns: u32` whose
 * maximum is 4_294_967_295. Sending a value above that — e.g.
 * Number.MAX_SAFE_INTEGER (9_007_199_254_740_991) — causes serde to
 * reject the entire `evaluate_goal` Tauri invoke before the CLI is
 * ever spawned. The Goal would silently never run.
 *
 * 4.29 billion turns is semantically infinite for a goal loop.
 * This constant is the contract boundary: TS must never exceed it.
 *
 * DOMAIN: turns (count of iterations). Do NOT use for time fields —
 * use GOAL_MAX_ELAPSED_MS_UNLIMITED instead. Same numeric value,
 * different meaning; mixing them is the class of defect that caused
 * G-C7 in the first place.
 */
export const GOAL_MAX_TURNS_UNLIMITED = 4_294_967_295

/**
 * "Unlimited" sentinel for the elapsed-time budget, in milliseconds.
 *
 * DOMAIN: time (milliseconds). Distinct from GOAL_MAX_TURNS_UNLIMITED
 * (turns) on purpose — same numeric value, different meaning.
 *
 * The Rust GoalState (types.rs:986) declares `max_elapsed_ms: u64`,
 * so we are NOT constrained to u32::MAX here. We choose u32::MAX
 * (4_294_967_295 ms ≈ 49.7 days) for three reasons:
 *   1. It is far beyond any realistic single-goal run — a goal that
 *      ran 49 days continuously would be a bug, not a use case.
 *   2. It matches the turns sentinel, so a reader who understands
 *      one immediately understands the other.
 *   3. If Rust ever narrows max_elapsed_ms to u32 (e.g. for struct
 *      alignment), this value still fits — no second migration.
 *
 * The risk of using Number.MAX_SAFE_INTEGER here would be different
 * from G-C7: u64 holds it, so serde would NOT reject the invoke.
 * But it would still be a domain leak — a JS implementation detail
 * leaking into a Rust contract — and we are explicitly rejecting
 * that pattern.
 */
export const GOAL_MAX_ELAPSED_MS_UNLIMITED = 4_294_967_295

type CreateGoalInput = {
  objective: string
  accessMode: AccessMode
  modelId?: string
  modelDisplayName?: string
  workingDirectory: string
  skills: SkillSummary[]
  /**
   * Kept for backwards compatibility with callers that still pass
   * settings values, but no longer enforced — tokens and time are
   * unlimited. Defaults to GOAL_MAX_TURNS_UNLIMITED (= u32::MAX)
   * so the scheduler never pauses on budget, and serde accepts the
   * value.
   */
  maxTurns?: number
  maxElapsedMinutes?: number
}

export function createGoalState(input: CreateGoalInput): GoalState {
  const now = Date.now()
  return {
    id: `goal:${crypto.randomUUID()}`,
    objective: input.objective.trim(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    turnsRun: 0,
    // Unlimited — fields remain on GoalState for backwards compat but
    // are set to domain-appropriate sentinels and never trigger a
    // pause. Each constant matches its Rust field's type width:
    //   - maxTurns (u32) ← GOAL_MAX_TURNS_UNLIMITED
    //   - maxElapsedMs (u64) ← GOAL_MAX_ELAPSED_MS_UNLIMITED
    // Mixing them is the G-C7 defect class — keep them separate.
    maxTurns: GOAL_MAX_TURNS_UNLIMITED,
    maxElapsedMs: GOAL_MAX_ELAPSED_MS_UNLIMITED,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    accessMode: input.accessMode,
    modelId: input.modelId,
    modelDisplayName: input.modelDisplayName,
    workingDirectory: input.workingDirectory,
    skills: input.skills,
    noProgressCount: 0,
    recentFingerprints: [],
  }
}

/**
 * Sanitize a GoalState loaded from persisted storage (chatStore /
 * conversation.goal) before it re-enters the live React state.
 *
 * WHY THIS EXISTS:
 * Goals created before G-C7-TS-FIX (v0.6.0-beta.x) stored
 * `maxTurns: Number.MAX_SAFE_INTEGER` (9_007_199_254_740_991) and
 * `maxElapsedMs: Number.MAX_SAFE_INTEGER` on disk. The Rust
 * GoalState declares `max_turns: u32` (types.rs:935), so serde rejects
 * the entire `evaluate_goal` invoke when the stale value is sent —
 * the goal silently never runs, exactly the original G-C7 bug, but
 * for pre-existing goals rather than newly-created ones.
 *
 * This function clamps every numeric field that has a Rust-side
 * width to its domain's sentinel, so any goal persisted with a
 * too-large value is migrated on read. The migration is idempotent:
 * goals already within bounds pass through unchanged.
 *
 * CALL SITES: every path that reconstructs a GoalState from
 * persisted data must run through this function. Today there are
 * two — App.tsx hydration effect (~line 1132) and
 * selectConversation (~line 3532). If a third appears, route it
 * through here too; the contract-test file enumerates the call
 * sites via grep to catch omissions.
 *
 * DOMAIN: this is the dual of createGoalState — createGoalState
 * builds a fresh goal with correct sentinels; sanitizeStoredGoal
 * repairs a stale one. Both must agree on the constant mapping.
 */
export function sanitizeStoredGoal(goal: GoalState): GoalState {
  return {
    ...goal,
    // turns domain — Rust u32 (types.rs:935)
    maxTurns:
      goal.maxTurns !== undefined && goal.maxTurns > GOAL_MAX_TURNS_UNLIMITED
        ? GOAL_MAX_TURNS_UNLIMITED
        : goal.maxTurns,
    // time domain — Rust u64 (types.rs:986), but we still cap at the
    // time sentinel for domain consistency (see GOAL_MAX_ELAPSED_MS_UNLIMITED
    // JSDoc for why u32::MAX is the chosen ceiling despite u64 width).
    maxElapsedMs:
      goal.maxElapsedMs !== undefined && goal.maxElapsedMs > GOAL_MAX_ELAPSED_MS_UNLIMITED
        ? GOAL_MAX_ELAPSED_MS_UNLIMITED
        : goal.maxElapsedMs,
  }
}

export function goalSystemMessage(text: string): TranscriptItem {
  return {
    id: `goal-system:${crypto.randomUUID()}`,
    role: 'system',
    text,
    timestamp: Date.now(),
  }
}
