import { Pause, Play, Square, Target } from 'lucide-react'
import { useI18n, type Translator } from '../../i18n'
import { translateGoalReason } from './goalReason'

export type GoalStatusBarState =
  | { kind: 'idle' }
  | { kind: 'active'; objective: string; turn: number }
  | { kind: 'evaluating'; objective: string; turn: number }
  | { kind: 'continuing'; objective: string; turn: number }
  | { kind: 'completed'; objective: string }
  | { kind: 'stopped'; objective: string; reason: string }

type GoalStatusBarProps = {
  status: GoalStatusBarState
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onClear: () => void
}

export function GoalStatusBar({ status, onPause, onResume, onCancel, onClear }: GoalStatusBarProps) {
  const { t } = useI18n()

  // Active states (active/evaluating/continuing/paused) are handled by
  // GoalActivePanel inside the composer-aux-stack. The status bar only
  // renders terminal/transient toasts: completed, stopped (paused with
  // reason). This avoids duplicate UI when both could show the same info.
  if (status.kind === 'idle') return null
  if (status.kind === 'active' || status.kind === 'evaluating' || status.kind === 'continuing') return null

  const icon =
    status.kind === 'completed'
      ? 'complete'
      : 'stopped'

  const label = statusLabel(status, icon, t)

  return (
    <div className="goal-status-bar" data-kind={status.kind}>
      <div className="goal-status-bar__body">
        <Target size={14} className="goal-status-bar__objective-icon" />
        <span className="goal-status-bar__label">
          {label}
        </span>
      </div>
      <div className="goal-status-bar__actions">
        {status.kind === 'completed' && (
          <button className="goal-status-bar__btn goal-status-bar__btn--clear" onClick={onClear} title={t('goal.clear')}>
            <Square size={12} />
          </button>
        )}
        {status.kind === 'stopped' && (
          <>
            <button className="goal-status-bar__btn" onClick={onResume} title={t('goal.resume')}>
              <Play size={14} />
            </button>
            <button className="goal-status-bar__btn goal-status-bar__btn--clear" onClick={onClear} title={t('goal.clear')}>
              <Square size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function statusLabel(status: GoalStatusBarState, icon: string, t: Translator): string {
  const prefix = icon === 'complete' ? t('goal.completed') :
    icon === 'evaluating' ? t('goal.evaluating') :
    icon === 'stopped' ? t('goal.stopped') :
    icon === 'running' ? t('goal.running') : ''

  let rest = ''
  if (status.kind === 'active' || status.kind === 'continuing' || status.kind === 'evaluating') {
    rest = truncate(status.objective, 60)
  } else if (status.kind === 'completed') {
    rest = truncate(status.objective, 60)
  } else if (status.kind === 'stopped') {
    rest = translateGoalReason(status.reason, t)
  }

  return `${prefix}: ${rest}`
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}
