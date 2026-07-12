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

import type { GoalEvaluationResult } from '../../../shared/types'

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
