/**
 * Pure helpers for composing the next-turn prompt during a goal cycle.
 *
 * When the evaluator returns `decision: 'continue'`, the scheduler must
 * send a follow-up message that re-anchors the model on the objective
 * and feeds it the structured evaluation output (session summary, gaps,
 * next action, reason). The model then continues autonomously — the
 * prompt does NOT ask the user whether to proceed.
 *
 * Shape mirrors the Rust `GoalEvaluationResult` schema
 * (src-tauri/src/models/types.rs:810).
 */

import type { GoalEvaluationResult, GoalState } from '../../../shared/types'
import type { Translator } from '../../i18n'

export type ContinuePromptInput = {
  objective: string
  evaluation: GoalEvaluationResult
  workingDirectory?: string
}

/**
 * Build the next-turn prompt for a `continue` decision. Always includes
 * the objective; the structured fields are appended only when present
 * so the prompt stays terse when the evaluator returned a minimal
 * payload.
 *
 * Output is plain markdown — the model sees it as a user message.
 */
export function buildContinuePrompt(input: ContinuePromptInput): string {
  const { objective, evaluation, workingDirectory } = input
  const lines: string[] = []

  lines.push(`## Continuing toward: ${objective}`)
  lines.push('')

  if (evaluation.sessionSummary && evaluation.sessionSummary.trim()) {
    lines.push(`**Session summary:** ${evaluation.sessionSummary.trim()}`)
    lines.push('')
  }

  if (evaluation.gaps.length > 0) {
    lines.push('**Remaining gaps:**')
    for (const gap of evaluation.gaps) {
      const trimmed = gap.trim()
      if (trimmed) lines.push(`- ${trimmed}`)
    }
    lines.push('')
  }

  if (evaluation.nextAction && evaluation.nextAction.trim()) {
    lines.push(`**Next action:** ${evaluation.nextAction.trim()}`)
    lines.push('')
  }

  if (evaluation.reason && evaluation.reason.trim()) {
    lines.push(`**Reason:** ${evaluation.reason.trim()}`)
    lines.push('')
  }

  lines.push('Continue autonomously. Do not ask for confirmation. When the objective is complete, summarize what was done.')

  if (workingDirectory) {
    lines.push(`Working directory: ${workingDirectory}`)
  }

  return lines.join('\n').trim()
}

/**
 * Build the user-visible system message shown when the evaluator
 * decides the goal is complete. The completion card is driven by
 * `completionSummary` (the evaluator's structured summary of what was
 * done and how it was verified). `gaps` is NOT used here — gaps represent
 * remaining work, which is empty by definition on completion. If the
 * evaluator didn't emit a completionSummary, fall back to `reason`.
 *
 * Stays terse — long completion messages push the transcript out of the
 * context window for the next turn.
 */
export function buildCompletionMessage(evaluation: GoalEvaluationResult): string {
  const summary = evaluation.completionSummary?.trim() || evaluation.reason?.trim()
  return summary || ''
}

/**
 * Format a token count with thousand separators.
 *
 * G-C10 item 3b: the user wants "569.180 tokens" not "569180 tokens".
 * Uses Intl.NumberFormat('pt-BR') for pt-BR locale (period separator),
 * which matches the app's primary locale. For en-US the same call
 * yields comma separators — both are correct for their locale.
 *
 * Exposed (not inlined) so the test can pin the format without
 * reaching into Intl from the test file.
 */
export function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat('pt-BR').format(tokens)
}

/**
 * Format an elapsed duration in milliseconds as "Xmin Ys" or "Xs".
 *
 * G-C10 item 3b: the user wants "24min20s" not "1460s". Stays terse —
 * the completion toast is one line. Hours are not supported because
 * goals that run for hours are a bug, not a use case (see
 * GOAL_MAX_ELAPSED_MS_UNLIMITED JSDoc for the 49.7-day ceiling).
 */
export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}min${seconds}s`
}

/**
 * Build the "Goal finalizado. Uso registrado: X tokens; tempo aproximado: Y"
 * suffix for the completion log.
 *
 * G-C10 item 3: the user wants the real token count (input + output)
 * and the elapsed time at completion. Tokens come from
 * goal.usedInputTokens + goal.usedOutputTokens (accumulated by the
 * turn-event handler at App.tsx:1810, now synchronized to goalRef).
 * Time comes from goal.completedAt - goal.startedAt.
 *
 * Returns an empty string if the goal has no startedAt (legacy goal
 * persisted before startedAt was added) — the caller should not log
 * a partial usage line.
 */
export function buildUsageSummary(goal: GoalState): string {
  const totalTokens = (goal.usedInputTokens ?? 0) + (goal.usedOutputTokens ?? 0)
  const tokensPart = `Uso registrado: ${formatTokenCount(totalTokens)} tokens`

  if (!goal.startedAt || !goal.completedAt) {
    return tokensPart
  }

  const elapsedMs = goal.completedAt - goal.startedAt
  const timePart = `tempo aproximado: ${formatElapsedMs(elapsedMs)}`
  return `${tokensPart}; ${timePart}`
}

/**
 * Build the prompt injected when the user edits the goal objective
 * mid-flight. The model must pivot to the NEW objective without
 * restarting from scratch — it should build on the work already done.
 *
 * Used when a turn is in progress (interjected) or between turns
 * (injected as the next user message before the scheduler continues).
 */
export function buildObjectiveUpdatedPrompt(newObjective: string): string {
  return `Goal objective UPDATED by the user. New objective: ${newObjective}. Continue from the current work toward the NEW objective. Do not restart from scratch — build on what was already done.`
}

/**
 * G-C15-TS: build the usage line for a completed goal.
 *
 * The user REJECTED the separate green box (G-C13's approach): the
 * evaluator's completionSummary is verbose, English, and the user
 * called it "irrelevant information". The completionSummary now stays
 * in the backend (lastEvaluation) for diagnostics — it does NOT reach
 * the rendered UI. This function returns ONLY the usage line, which
 * the onComplete delegate stamps on the last turn's summary item
 * (TranscriptItem.usageLine) so the TurnView renders it inline after
 * the agent's final text — no box, no badge, same typographic family.
 *
 * Token total structure (G-C15-TS item 4, wired by G-C15-FIX and
 * accumulated by G-C17):
 *   totalTokens = turnTokens + evaluatorTokens
 *   turnTokens = usedInputTokens + usedOutputTokens (CLI turn usage)
 *   evaluatorTokens = evaluatorInputTokens + evaluatorOutputTokens —
 *     the evaluator's usage ACCUMULATED across every evaluation of the
 *     goal (G-C17; was last-write-wins `lastEvaluatorUsage`, which
 *     under-reported multi-evaluation goals).
 *
 * Honest label (G-C15-TS item 5):
 *   - While only turn tokens are counted, the label is "Uso registrado"
 *     (not "Total") — so the user is not misled into thinking this is
 *     the full goal cost. The evaluator's ~1/3 is missing.
 *   - When the accumulated evaluatorTokens are present AND non-zero,
 *     the label switches to "Total registrado" — at that point it IS
 *     the full cost.
 *
 * Gate (G-C13-FIX bifurcation, preserved):
 *   - tokens > 0 AND both timestamps → "Uso registrado: N tokens;
 *     tempo aproximado: Xs"
 *   - tokens > 0 but elapsed unavailable → "Uso registrado: N tokens"
 *   - zero tokens → "" (empty string; the caller skips stamping)
 *
 * Returns the usage line WITHOUT a heading. The caller (onComplete
 * delegate) stamps it on TranscriptItem.usageLine; the TurnView renders
 * it inline after the agent's final text.
 */
export function buildGoalUsageLine(
  goal: GoalState,
  t: Translator,
): string {
  // G-C17: the evaluator parcel is the ACCUMULATED
  // goal.evaluatorInputTokens/evaluatorOutputTokens — summed by the
  // evaluateGoal delegate (App.tsx) from the `evaluatorUsage` SIBLING
  // of evaluation in GoalEvaluationEnvelope (G-C15-FIX), across EVERY
  // evaluation of the goal. This replaces G-C15-FIX's
  // `lastEvaluatorUsage` (last-write-wins), which silently dropped all
  // but the final parcel in multi-evaluation goals while this label
  // read "Total registrado". The scheduler's completion path overlays
  // the fresh totals from the live ref onto finalGoal (goalScheduler.ts
  // G-C17 adendo), so the last evaluation's parcel is included too.
  //
  // Legacy goals persisted before G-C17 lack the accumulator keys —
  // they arrive as `undefined`. Treat absence, not null (`?? 0`),
  // same lesson as the Rust skip_serializing_if omission.
  //
  // The user wants ONE summed number, not discriminated. So we add
  // both parcels into a single totalTokens.
  const turnTokens = (goal.usedInputTokens ?? 0) + (goal.usedOutputTokens ?? 0)
  const evaluatorTokens =
    (goal.evaluatorInputTokens ?? 0) +
    (goal.evaluatorOutputTokens ?? 0)
  const totalTokens = turnTokens + evaluatorTokens
  const hasTokens = totalTokens > 0
  const hasElapsed = !!(goal.startedAt && goal.completedAt)

  if (!hasTokens) return ''

  // G-C15-FIX item 5: HONEST LABEL. While the evaluator's tokens are
  // NOT in the total (absent or zero), the label is "Uso registrado"
  // — it cannot promise "Total" because the evaluator's ~1/3 is
  // missing. When the evaluator's tokens ARE present and non-zero,
  // the label switches to "Total registrado" — at that point it IS
  // the full goal cost.
  const hasEvaluatorTokens = evaluatorTokens > 0
  const usageKey = hasEvaluatorTokens ? 'goal.totalUsage' : 'goal.completedUsage'
  const tokensOnlyKey = hasEvaluatorTokens ? 'goal.totalUsageTokens' : 'goal.completedUsageTokens'

  if (hasElapsed) {
    const elapsedMs = goal.completedAt! - goal.startedAt!
    return t(usageKey, {
      tokens: formatTokenCount(totalTokens),
      elapsed: formatElapsedMs(elapsedMs),
    })
  }
  return t(tokensOnlyKey, {
    tokens: formatTokenCount(totalTokens),
  })
}
