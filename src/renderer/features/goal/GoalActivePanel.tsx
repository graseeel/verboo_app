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
  onEditObjective: (newObjective: string) => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}

export function GoalActivePanel({
  goal,
  turnInProgress,
  compact = false,
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

  // G-C6-FIX-UI: surface the evaluator's specific error message when
  // paused by infraError. The Rust evaluator emits a useful timeout/
  // failure reason (e.g. "Goal evaluator CLI timed out after 240s...")
  // that the scheduler stores in goal.lastEvaluation.reason. Before
  // this fix, the panel showed only the generic "Erro de
  // infraestrutura do avaliador" — the specific message was written
  // to state but never rendered. We use the existing (previously
  // orphan) goal.errorPausedBody key, interpolating {message} with
  // the reason text. Falls back to nothing if reason is absent or
  // empty — the generic pauseReason already shows, never an empty
  // string or "undefined".
  const evaluatorErrorMessage =
    isPaused && goal.pauseReason === 'infraError' && goal.lastEvaluation?.reason
      ? t('goal.errorPausedBody', { message: goal.lastEvaluation.reason })
      : null

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
        className="goal-active-panel compact"
        role="region"
        aria-label={t('goal.panelTitle')}
      >
        <div className="goal-active-panel-compact-row">
          <Target size={14} aria-hidden className="goal-active-panel-compact-icon" />
          <span className={`goal-active-panel-status ${kind}`}>
          <span className="goal-active-panel-status-dot" aria-hidden />
          {t(statusLabelKey)}
        </span>
          <p className="goal-active-panel-compact-objective" title={goal.objective}>
            {goal.objective}
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
      className={`goal-active-panel ${isPaused ? 'paused' : 'running'}`}
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
        {/* quieter redesign: the "OBJECTIVE" uppercase label was removed —
            the text under the Goal header is self-evident, and the user
            rejects labels that read as noise. The i18n key and CSS rule
            were removed together (no orphan on either side). */}
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
          <p className="goal-active-panel-objective-text">{goal.objective}</p>
        )}
      </div>

      <div className="goal-active-panel-actions">
        {/* quieter redesign: every action is icon-only with tooltip, the
            SAME vocabulary as the compact strip (product.md: consistent
            affordances across the surface). The i18n keys stay consumed
            as aria-label/title — nothing orphaned. */}
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
