/**
 * D-C: the batch progress stamp — "Tarefa k de N" on the LATEST turn's
 * summary item (the discreet surface the user approved; no badge, no
 * box, no second item).
 *
 * Extracted from App.tsx's onStatusChange so the failure modes are
 * TESTABLE. The field-test defect was not just the race (see
 * turnCompletion.ts) — it was the SILENCE: when the stamp did not find
 * its target it returned without a trace and never retried. Silent
 * failure is the defect class this cycle worked to eliminate, so a
 * missing target is now a console.error with the turnId and the
 * conversation id — visible in devtools and in any log capture.
 *
 * Legitimate no-ops stay silent BY DESIGN (they are not failures):
 *   - the goal has no lastTurnId yet (first cycle — nothing to stamp);
 *   - the stamped line is already current (idempotent no-churn).
 */
import type { GoalState, StoredConversation, TranscriptItem } from '../../../shared/types'
import type { Translator } from '../../i18n'

export function stampBatchProgressLine(options: {
  goal: GoalState | undefined
  fallbackConversationId: string | undefined
  batchProgress: { current: number; total: number }
  conversations: StoredConversation[]
  updateConversation: (
    conversationId: string,
    updater: (conversation: StoredConversation) => StoredConversation,
  ) => void
  t: Translator
  /** Test seam — defaults to console.error. */
  onStampFailure?: (message: string) => void
}): void {
  const { goal, batchProgress, conversations, updateConversation, t } = options
  const fail = options.onStampFailure ?? ((message: string) => console.error(message))

  const ownerConversationId = goal?.ownerConversationId ?? options.fallbackConversationId
  const lastTurnId = goal?.lastTurnId
  // First cycle has no turn yet — legitimate, nothing to stamp on.
  if (!ownerConversationId || !lastTurnId) return

  const progressLine = t('goal.batchProgress', {
    current: batchProgress.current,
    total: batchProgress.total,
  })
  const summaryItemId = `${lastTurnId}:summary`
  const conv = conversations.find(c => c.id === ownerConversationId)
  if (!conv) {
    fail(
      `[goal] D-C stamp FAILED: owner conversation ${ownerConversationId} not found ` +
      `(turn ${lastTurnId}, progress "${progressLine}"). The progress line is LOST for this turn.`,
    )
    return
  }
  const existingItem = conv.items.find(i => i.id === summaryItemId)
  if (!existingItem) {
    fail(
      `[goal] D-C stamp FAILED: summary item ${summaryItemId} not found in conversation ` +
      `${ownerConversationId} (progress "${progressLine}"). The progress line is LOST for this turn — ` +
      `if this fires, the turn-completion deferred resolved before appendTurnSummary settled.`,
    )
    return
  }
  // No churn: skip the write when the stamped line is already current.
  if (existingItem.progressLine === progressLine) return

  updateConversation(ownerConversationId, c => ({
    ...c,
    items: c.items.map(i =>
      i.id === summaryItemId ? { ...i, progressLine } : i,
    ),
    updatedAt: Date.now(),
  }))
}
