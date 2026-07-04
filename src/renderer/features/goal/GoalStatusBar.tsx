import { Pause, Play, Square, Target } from 'lucide-react'
import { useI18n, type Translator } from '../../i18n'

export type GoalStatusBarState =
  | { kind: 'idle' }
  | { kind: 'active'; objective: string; turn: number; maxTurns: number }
  | { kind: 'evaluating'; objective: string; turn: number; maxTurns: number }
  | { kind: 'continuing'; objective: string; turn: number; maxTurns: number }
  | { kind: 'completed'; objective: string }
  | { kind: 'stopped'; objective: string; reason: string }
  | { kind: 'budget_limited'; objective: string; reason: string }

type GoalStatusBarProps = {
  status: GoalStatusBarState
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onClear: () => void
}

export function GoalStatusBar({ status, onPause, onResume, onCancel, onClear }: GoalStatusBarProps) {
  const { t } = useI18n()

  if (status.kind === 'idle') return null

  const icon =
    status.kind === 'active' || status.kind === 'continuing'
      ? 'running'
      : status.kind === 'evaluating'
        ? 'evaluating'
        : status.kind === 'completed'
          ? 'complete'
          : 'stopped'

  const label = statusLabel(status, icon, t)

  return (
    <div className="goal-status-bar" data-kind={status.kind}>
      <div className="goal-status-bar__body">
        <Target size={14} className="goal-status-bar__objective-icon" />
        <span className={`goal-status-bar__label ${icon === 'running' || icon === 'evaluating' ? 'shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm' : ''}`}>
          {label}
        </span>
        {status.kind === 'active' || status.kind === 'continuing' || status.kind === 'evaluating' ? (
          <>
            <span className="goal-status-bar__turn-count">
              {status.turn}/{status.maxTurns}
            </span>
            <div className="goal-status-bar__progress">
              <div
                className="goal-status-bar__progress-bar"
                style={{ transform: `scaleX(${status.turn / Math.max(status.maxTurns, 1)})` }}
              />
            </div>
          </>
        ) : null}
      </div>
      <div className="goal-status-bar__actions">
        {(status.kind === 'active' || status.kind === 'continuing' || status.kind === 'evaluating') && (
          <button className="goal-status-bar__btn" onClick={onPause} title={t('goal.pause')}>
            <Pause size={14} />
          </button>
        )}
        {status.kind === 'completed' && (
          <button className="goal-status-bar__btn goal-status-bar__btn--clear" onClick={onClear} title={t('goal.clear')}>
            <Square size={12} />
          </button>
        )}
        {(status.kind === 'stopped' || status.kind === 'budget_limited') && (
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
  } else if (status.kind === 'budget_limited') {
    rest = translateGoalReason(status.reason, t)
  }

  return `${prefix}: ${rest}`
}

function translateGoalReason(reason: string, t: Translator): string {
  if (reason.startsWith('Max turns reached')) return t('goal.reason.maxTurns')
  if (reason === 'Max time elapsed') return t('goal.reason.maxTime')
  if (reason === 'Detected possible loop (repeated output fingerprints)') return t('goal.reason.loop')
  if (reason === 'Goal is blocked') return t('goal.reason.blocked')
  if (reason === 'Evaluator did not provide next instruction') return t('goal.reason.noInstruction')
  return reason
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}
