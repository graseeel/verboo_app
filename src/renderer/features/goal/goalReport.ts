/**
 * T4: batch-goal UI strings — the FINAL REPORT and the PROGRESS line.
 *
 * Both follow the G-C15-TS surface rule the user laid down when he
 * REJECTED the separate green box and the second confirmation message:
 * no badge, no box, no second item — short text lines stamped on the
 * turn's existing summary item (TranscriptItem.progressLine while the
 * batch runs, TranscriptItem.batchReportLines when it completes),
 * rendered inline in the same typographic family as the usage line.
 *
 * THE REPORT CITES EVIDENCE (QA requirement since the paper gate): each
 * task line carries what sustained its conclusion — turns + whitelisted
 * action activities for done (or the toolless waiver), the failure
 * reason for failed, "skipped by you" for skipped. A goal once completed
 * with zero files on disk and nobody noticed; with N tasks that risk
 * multiplies by N in silence, so the user must be able to LOOK at the
 * report and see what backs each line. The scheduler stamps the evidence
 * on GoalTask at each terminal transition (turns / evidenceCount /
 * failureReason — goalScheduler.ts).
 *
 * DECLARED LIMIT (same honesty class as the D1 guard): the counts prove
 * PRESENCE of action, not CORRECTNESS — an edit that wrote garbage still
 * counted. The report says what was done, not whether it was right.
 */

import type { GoalState, GoalTask } from '../../../shared/types'
import type { Translator } from '../../i18n'
import { translateGoalReason } from './goalReason'

/**
 * The discreet progress line — "Tarefa 3 de 12" / "Task 3 of 12".
 * Returns null for legacy (non-batch) goals so callers stamp NOTHING on
 * single-task goals (aceite: no single-task regression on screen).
 */
export function buildBatchProgressLine(
  goal: Pick<GoalState, 'tasks' | 'taskIndex'>,
  t: Translator,
): string | null {
  const total = goal.tasks?.length ?? 0
  if (total === 0) return null
  const current = Math.min((goal.taskIndex ?? 0) + 1, total)
  return t('goal.batchProgress', { current, total })
}

/**
 * One report line for a single task, with the evidence cited.
 * Exported for tests; the report builder below maps the whole batch.
 */
export function buildBatchTaskLine(task: GoalTask, index: number, t: Translator): string {
  const params = { index: index + 1, text: task.text }
  switch (task.status) {
    case 'done':
      if (task.toolless === true) {
        // Toolless task: the D1 evidence leg was waived AT CREATION —
        // the report says so instead of implying actions that were
        // never required.
        return t('goal.batchReport.doneToolless', { ...params, turns: task.turns ?? 0 })
      }
      return t('goal.batchReport.done', {
        ...params,
        turns: task.turns ?? 0,
        actions: task.evidenceCount ?? 0,
      })
    case 'failed':
      // failureReason is one of 'loop' | 'unsafe' | 'infraError' — all
      // already mapped by translateGoalReason. Absent only for tasks
      // stamped before T4 existed; fall back to the generic failure id.
      return t('goal.batchReport.failed', {
        ...params,
        reason: translateGoalReason(task.failureReason ?? 'taskFailure', t),
      })
    case 'skipped':
      return t('goal.batchReport.skipped', params)
    default:
      // Defensive: a batch only completes with every task terminal
      // (row 13), so pending/active/blocked should never appear. If one
      // ever does, say "not finished" — never imply a conclusion that
      // did not happen.
      return t('goal.batchReport.notFinished', params)
  }
}

/**
 * The full final report: title line, one evidence line per task, and
 * the compaction-failure footer when any task-boundary compaction
 * failed (T3 declared the counter for exactly this line — the batch
 * proceeded WITHOUT compacting and the report must not hide it).
 *
 * Returns [] for legacy goals (no tasks) — the caller stamps nothing.
 */
export function buildBatchReportLines(goal: GoalState, t: Translator): string[] {
  const tasks = goal.tasks
  if (!tasks || tasks.length === 0) return []
  const lines = [
    t('goal.batchReportTitle'),
    ...tasks.map((task, index) => buildBatchTaskLine(task, index, t)),
  ]
  const compactionFailures = goal.compactionFailures ?? 0
  if (compactionFailures > 0) {
    lines.push(t('goal.batchReport.compactionFailures', { count: compactionFailures }))
  }
  return lines
}
