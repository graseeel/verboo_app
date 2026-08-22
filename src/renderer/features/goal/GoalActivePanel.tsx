import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Pencil, Pause, Play, Square, Target, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import type { GoalState } from '../../../shared/types'
import { translateGoalReason } from './goalReason'

/**
 * Statuses where the active panel is shown. Idle/completed goals don't
 * render the panel — idle means no goal, completed is a transient toast
 * handled by the status bar.
 */
type ActiveKind = 'active' | 'evaluating' | 'continuing' | 'paused'

type GoalActivePanelProps = {
  goal: GoalState
  /** True when a CLI turn is currently running (drives edit behavior). */
  turnInProgress: boolean
  /**
   * When true, the panel renders as a compact single-line strip with
   * truncated objective + icon buttons. Used when the QuestionWizard
   * is open so both can coexist without pushing the composer off-screen.
   * The user can expand back to full via the chevron.
   */
  compact?: boolean
  /**
   * True while the panel plays its EXIT animation (genie back into the
   * composer) after the goal reached a terminal state. The parent keeps
   * the panel mounted for the animation duration with a snapshot of the
   * last live goal; the class only adds the CSS animation and
   * pointer-events:none — no layout shift.
   */
  leaving?: boolean
  onEditObjective: (newObjective: string) => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}

export function GoalActivePanel({
  goal,
  turnInProgress,
  compact = false,
  leaving = false,
  onEditObjective,
  onPause,
  onResume,
  onCancel,
}: GoalActivePanelProps) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(goal.objective)
  const [expandedFromCompact, setExpandedFromCompact] = useState(false)
  const editInputRef = useRef<HTMLTextAreaElement>(null)

  // Reset draft when the goal objective changes externally (e.g. another
  // edit source) or when entering edit mode.
  useEffect(() => {
    if (editing) setDraft(goal.objective)
  }, [editing, goal.objective])

  useEffect(() => {
    if (editing) {
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }
  }, [editing])

  const kind = activeKindFor(goal)
  if (!kind) return null

  const statusLabelKey =
    kind === 'active' ? 'goal.panelStatusRunning' :
    kind === 'evaluating' ? 'goal.panelStatusEvaluating' :
    kind === 'continuing' ? 'goal.panelStatusContinuing' :
    'goal.panelStatusPaused'

  const isPaused = kind === 'paused'
  const pauseReason = isPaused && goal.pauseReason ? translateGoalReason(goal.pauseReason, t) : null

  // T5 (v1): objective editing is disabled while a BATCH runs — editing
  // the umbrella label would not retarget any task, and rewriting task
  // texts mid-flight has no safe v1 semantics. The edit buttons stay
  // VISIBLE but disabled, with the reason as tooltip: a clear warning,
  // not a mysterious disappearance. App.handleEditObjective carries the
  // same guard as backstop for non-panel entry points.
  const isBatch = (goal.tasks?.length ?? 0) > 0

  // Surface the evaluator's specific infraError message: the Rust
  // evaluator's timeout/failure reason arrives via goal.lastEvaluation.reason
  // and renders through the goal.errorPausedBody key ({message}). With no
  // reason, nothing extra shows — the generic pauseReason already covers it,
  // never an empty string.
  const evaluatorErrorMessage =
    isPaused && goal.pauseReason === 'infraError' && goal.lastEvaluation?.reason
      ? t('goal.errorPausedBody', { message: goal.lastEvaluation.reason })
      : null

  // Batch goals show the user's own multi-line message verbatim (their
  // words, line breaks included — per user request) instead of the
  // synthetic umbrella label ("Batch of N tasks"). Single-task goals
  // have no batchInput and show `objective` exactly as before, so the
  // two cases read the same: what the user typed. `objective` itself
  // stays untouched — editing, status bar and system messages use it.
  const displayObjective = goal.batchInput ?? goal.objective

  // Compact mode is forced by the parent when questions are open, but
  // the user can override to full panel. Editing also forces full panel.
  const showCompact = compact && !expandedFromCompact && !editing

  function handleSaveEdit() {
    const trimmed = draft.trim()
    if (!trimmed || trimmed === goal.objective) {
      setEditing(false)
      return
    }
    onEditObjective(trimmed)
    setEditing(false)
  }

  function handleCancelEdit() {
    setDraft(goal.objective)
    setEditing(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancelEdit()
    }
  }

  if (showCompact) {
    return (
      <div
        className={`goal-active-panel compact${leaving ? ' leaving' : ''}`}
        role="region"
        aria-label={t('goal.panelTitle')}
      >
        <div className="goal-active-panel-compact-row">
          <Target size={14} aria-hidden className="goal-active-panel-compact-icon" />
          <span className={`goal-active-panel-status ${kind}`}>
          <span className="goal-active-panel-status-dot" aria-hidden />
          {t(statusLabelKey)}
        </span>
          <p className="goal-active-panel-compact-objective" title={displayObjective}>
            {displayObjective}
          </p>
          {isPaused && pauseReason && (
            <span className="goal-active-panel-reason">{pauseReason}</span>
          )}
          {evaluatorErrorMessage && (
            <span className="goal-active-panel-reason goal-active-panel-reason-detail">
              {evaluatorErrorMessage}
            </span>
          )}
          <div className="goal-active-panel-compact-actions">
            <button
              type="button"
              className="goal-panel-icon-button"
              onClick={() => setExpandedFromCompact(true)}
              aria-label={t('goal.compactShowFull')}
              title={t('goal.compactShowFull')}
            >
              <ChevronDown size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="goal-panel-icon-button"
              onClick={() => setEditing(true)}
              aria-label={isBatch ? t('goal.batchEditDisabled') : t('goal.compactEditButton')}
              title={isBatch ? t('goal.batchEditDisabled') : t('goal.compactEditButton')}
              disabled={isBatch}
            >
              <Pencil size={14} aria-hidden />
            </button>
            {isPaused ? (
              <button
                type="button"
                className="goal-panel-icon-button primary"
                onClick={onResume}
                aria-label={t('goal.compactResumeButton')}
                title={t('goal.compactResumeButton')}
              >
                <Play size={14} aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                className="goal-panel-icon-button"
                onClick={onPause}
                aria-label={t('goal.compactPauseButton')}
                title={t('goal.compactPauseButton')}
                disabled={kind === 'evaluating'}
              >
                <Pause size={14} aria-hidden />
              </button>
            )}
            <button
              type="button"
              className="goal-panel-icon-button danger"
              onClick={onCancel}
              aria-label={t('goal.compactCancelButton')}
              title={t('goal.compactCancelButton')}
            >
              <Square size={14} aria-hidden />
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`goal-active-panel ${isPaused ? 'paused' : 'running'}${leaving ? ' leaving' : ''}`}
      role="region"
      aria-label={t('goal.panelTitle')}
    >
      <div className="goal-active-panel-header">
        <Target size={14} aria-hidden />
        <span className="goal-active-panel-title">{t('goal.panelTitle')}</span>
        <span className={`goal-active-panel-status ${kind}`}>
          <span className="goal-active-panel-status-dot" aria-hidden />
          {t(statusLabelKey)}
        </span>
        {isPaused && pauseReason && (
          <span className="goal-active-panel-reason">{pauseReason}</span>
        )}
        {evaluatorErrorMessage && (
          <span className="goal-active-panel-reason goal-active-panel-reason-detail">
            {evaluatorErrorMessage}
          </span>
        )}
        {compact && expandedFromCompact && (
          <button
            type="button"
            className="goal-panel-icon-button collapse-back"
            onClick={() => setExpandedFromCompact(false)}
            aria-label={t('goal.compactShowFull')}
            title={t('goal.compactShowFull')}
          >
            <ChevronDown size={14} aria-hidden className="rotated" />
          </button>
        )}
      </div>

      <div className="goal-active-panel-objective">
        {/* Quieter redesign: no "OBJECTIVE" label — self-evident under the
            Goal header, and the user rejects labels that read as noise. */}
        {editing ? (
          <textarea
            ref={editInputRef}
            className="goal-active-panel-edit-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('goal.panelEditPlaceholder')}
            aria-label={t('goal.panelEditPlaceholder')}
            rows={2}
          />
        ) : (
          <p className="goal-active-panel-objective-text">{displayObjective}</p>
        )}
      </div>

      {/* D-D item 4: the taskImpossible pause message the user READS.
          The legible reason + the v1 contract (reply resumes THIS SAME
          task; to change it, cancel and relaunch) — the contract lives
          IN THE MESSAGE, declared before the user types, not after the
          frustration. Plain text in the panel's own typographic family:
          no box, no badge (the noise class the user vetoed twice).
          Compact strip keeps only the header label — the full text is
          one chevron away. */}
      {isPaused && goal.pauseReason === 'taskImpossible' && !editing && (
        <p className="goal-active-panel-impossible-detail">
          {t('goal.taskImpossibleBody', {
            reason: goal.lastEvaluation?.reason?.trim() || t('goal.reasonId.taskImpossible'),
          })}
        </p>
      )}

      <div className="goal-active-panel-actions">
        {/* Icon-only actions with tooltips — same vocabulary as the compact
            strip (product.md: consistent affordances across the surface);
            the i18n keys stay consumed as aria-label/title. */}
        {editing ? (
          <>
            <button
              type="button"
              className="goal-panel-icon-button primary"
              onClick={handleSaveEdit}
              aria-label={t('goal.panelEditSaveButton')}
              title={t('goal.panelEditSaveButton')}
            >
              <Check size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="goal-panel-icon-button"
              onClick={handleCancelEdit}
              aria-label={t('goal.panelEditCancelButton')}
              title={t('goal.panelEditCancelButton')}
            >
              <X size={14} aria-hidden />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="goal-panel-icon-button"
              onClick={() => setEditing(true)}
              aria-label={isBatch ? t('goal.batchEditDisabled') : t('goal.panelEditButton')}
              title={isBatch ? t('goal.batchEditDisabled') : t('goal.panelEditButton')}
              disabled={isBatch}
            >
              <Pencil size={14} aria-hidden />
            </button>
            {isPaused ? (
              <button
                type="button"
                className="goal-panel-icon-button primary"
                onClick={onResume}
                aria-label={t('goal.panelResumeButton')}
                title={t('goal.panelResumeButton')}
              >
                <Play size={14} aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                className="goal-panel-icon-button"
                onClick={onPause}
                aria-label={t('goal.panelPauseButton')}
                title={t('goal.panelPauseButton')}
                disabled={kind === 'evaluating'}
              >
                <Pause size={14} aria-hidden />
              </button>
            )}
            <button
              type="button"
              className="goal-panel-icon-button danger"
              onClick={onCancel}
              aria-label={t('goal.panelCancelButton')}
              title={t('goal.panelCancelButton')}
            >
              <Square size={14} aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function activeKindFor(goal: GoalState): ActiveKind | null {
  switch (goal.status) {
    case 'active':
      return 'active'
    case 'evaluating':
      return 'evaluating'
    case 'continuing':
      return 'continuing'
    case 'paused':
      return 'paused'
    default:
      return null
  }
}
