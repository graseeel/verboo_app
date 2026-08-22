/**
 * Pure helpers for translating goal evaluation outcomes.
 *
 * The backend (Rust `GoalEvaluationResult`) sends a stable `reasonId`
 * enum (`taskIncomplete | taskFailure | unsafe | needsUser |
 * taskImpossible | done | infraError`) plus a free-form `reason` string
 * from the model. The FE translates the id for headings and badges; the
 * raw `reason` is shown as a secondary detail when present.
 *
 * Internal scheduler reasons (max turns, max time, loop, blocked,
 * no-instruction) are NOT reasonIds — they are FE-side budget/loop
 * guards and use the legacy `goal.reason.*` keys. `translateGoalReason`
 * handles both namespaces so call sites don't need to branch.
 */

import type { GoalReasonId } from '../../../shared/types'
import type { Translator } from '../../i18n'

const REASON_ID_KEYS: Record<GoalReasonId, string> = {
  taskIncomplete: 'goal.reasonId.taskIncomplete',
  taskFailure: 'goal.reasonId.taskFailure',
  unsafe: 'goal.reasonId.unsafe',
  needsUser: 'goal.reasonId.needsUser',
  taskImpossible: 'goal.reasonId.taskImpossible',
  done: 'goal.reasonId.done',
  infraError: 'goal.reasonId.infraError',
  userPaused: 'goal.reasonId.userPaused',
  userCancelled: 'goal.reasonId.userCancelled',
  safetyLimit: 'goal.reasonId.safetyLimit',
  goalError: 'goal.reasonId.goalError',
}

/** Translate a stable reasonId. Unknown ids fall back to `goal.reasonId.unknown`. */
export function translateGoalReasonById(
  reasonId: GoalReasonId | string | undefined,
  t: Translator,
): string {
  if (!reasonId) return t('goal.reasonId.unknown')
  const key = REASON_ID_KEYS[reasonId as GoalReasonId]
  return key ? t(key) : t('goal.reasonId.unknown')
}

/** True when the evaluator flagged an infrastructure failure (CLI
 *  timeout, parse error, crash). The scheduler uses this to drive the
 *  consecutive-error circuit breaker. */
export function isInfraError(reasonId: GoalReasonId | string | undefined): boolean {
  return reasonId === 'infraError'
}

/**
 * Translate any reason string the scheduler might surface — either a
 * stable reasonId from the evaluator, or an internal budget/loop
 * reason (`maxTurns | maxTime | loop | blocked | noInstruction |
 * batchStagnation | infraError`). The internal reasons use the legacy
 * `goal.reason.*` keys for backwards compatibility with existing copy.
 */
const INTERNAL_REASON_KEYS: Record<string, string> = {
  maxTurns: 'goal.reason.maxTurns',
  maxTime: 'goal.reason.maxTime',
  loop: 'goal.reason.loop',
  blocked: 'goal.reason.blocked',
  noInstruction: 'goal.reason.noInstruction',
  // Not a GoalReasonId (the backend enum has no batch concept) — an
  // FE-side scheduler reason like the budget guards above. Without this
  // entry the free-form passthrough renders the raw camelCase literal
  // "batchStagnation" on screen.
  batchStagnation: 'goal.reason.batchStagnation',
  // Legacy snake_case aliases the scheduler used before reasonIds were
  // introduced. Kept for backwards compatibility with stored goals.
  infra_error: 'goal.reasonId.infraError',
  user_paused: 'goal.reasonId.userPaused',
  user_cancelled: 'goal.reasonId.userCancelled',
  safety_limit: 'goal.reasonId.safetyLimit',
}

export function translateGoalReason(
  reason: string | undefined,
  t: Translator,
): string {
  if (!reason) return t('goal.reasonId.unknown')
  if (REASON_ID_KEYS[reason as GoalReasonId]) {
    return t(REASON_ID_KEYS[reason as GoalReasonId])
  }
  const internalKey = INTERNAL_REASON_KEYS[reason]
  if (internalKey) return t(internalKey)
  return reason
}
