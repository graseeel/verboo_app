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
          <span className={`goal-active-panel-status ${kind}`}>{t(statusLabelKey)}</span>
          <p className="goal-active-panel-compact-objective" title={goal.objective}>
            {goal.objective}
          </p>
          {isPaused && pauseReason && (
            <span className="goal-active-panel-reason">{pauseReason}</span>
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
              aria-label={t('goal.compactEditButton')}
              title={t('goal.compactEditButton')}
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
        <span className={`goal-active-panel-status ${kind}`}>{t(statusLabelKey)}</span>
        {isPaused && pauseReason && (
          <span className="goal-active-panel-reason">{pauseReason}</span>
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
        <span className="goal-active-panel-objective-label">{t('goal.panelObjectiveLabel')}</span>
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
        {editing ? (
          <>
            <button
              type="button"
              className="goal-panel-button primary"
              onClick={handleSaveEdit}
              aria-label={t('goal.panelEditSaveButton')}
            >
              <Check size={14} aria-hidden />
              <span>{t('goal.panelEditSaveButton')}</span>
            </button>
            <button
              type="button"
              className="goal-panel-button"
              onClick={handleCancelEdit}
              aria-label={t('goal.panelEditCancelButton')}
            >
              <X size={14} aria-hidden />
              <span>{t('goal.panelEditCancelButton')}</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="goal-panel-button"
              onClick={() => setEditing(true)}
              aria-label={t('goal.panelEditButton')}
            >
              <Pencil size={14} aria-hidden />
              <span>{t('goal.panelEditButton')}</span>
            </button>
            {isPaused ? (
              <button
                type="button"
                className="goal-panel-button primary"
                onClick={onResume}
                aria-label={t('goal.panelResumeButton')}
              >
                <Play size={14} aria-hidden />
                <span>{t('goal.panelResumeButton')}</span>
              </button>
            ) : (
              <button
                type="button"
                className="goal-panel-button"
                onClick={onPause}
                aria-label={t('goal.panelPauseButton')}
                disabled={kind === 'evaluating'}
              >
                <Pause size={14} aria-hidden />
                <span>{t('goal.panelPauseButton')}</span>
              </button>
            )}
            <button
              type="button"
              className="goal-panel-button danger"
              onClick={onCancel}
              aria-label={t('goal.panelCancelButton')}
            >
              <Square size={14} aria-hidden />
              <span>{t('goal.panelCancelButton')}</span>
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
