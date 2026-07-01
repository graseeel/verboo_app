import { Pause, Play, Square, Target } from 'lucide-react'

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
  if (status.kind === 'idle') return null

  const icon =
    status.kind === 'active' || status.kind === 'continuing'
      ? 'running'
      : status.kind === 'evaluating'
        ? 'evaluating'
        : status.kind === 'completed'
          ? 'complete'
          : 'stopped'

  const label = statusLabel(status, icon)

  return (
    <div className="goal-status-bar" data-kind={status.kind}>
      <div className="goal-status-bar__body">
        <Target size={14} className="goal-status-bar__objective-icon" />
        <span className="goal-status-bar__label">{label}</span>
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
          <button className="goal-status-bar__btn" onClick={onPause} title="Pause">
            <Pause size={14} />
          </button>
        )}
        {status.kind === 'completed' && (
          <button className="goal-status-bar__btn goal-status-bar__btn--clear" onClick={onClear} title="Clear goal">
            <Square size={12} />
          </button>
        )}
        {(status.kind === 'stopped' || status.kind === 'budget_limited') && (
          <>
            <button className="goal-status-bar__btn" onClick={onResume} title="Resume">
              <Play size={14} />
            </button>
            <button className="goal-status-bar__btn goal-status-bar__btn--clear" onClick={onClear} title="Clear goal">
              <Square size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function statusLabel(status: GoalStatusBarState, icon: string): string {
  const prefix = icon === 'complete' ? 'Objetivo completo' :
    icon === 'evaluating' ? 'Avaliando objetivo' :
    icon === 'stopped' ? 'Objetivo parado' :
    icon === 'running' ? 'Executando objetivo' : ''

  let rest = ''
  if (status.kind === 'active' || status.kind === 'continuing' || status.kind === 'evaluating') {
    rest = truncate(status.objective, 60)
  } else if (status.kind === 'completed') {
    rest = truncate(status.objective, 60)
  } else if (status.kind === 'stopped') {
    rest = status.reason
  } else if (status.kind === 'budget_limited') {
    rest = status.reason
  }

  return `${prefix}: ${rest}`
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}
