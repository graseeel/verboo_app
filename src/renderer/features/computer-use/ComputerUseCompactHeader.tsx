import { AppWindow, Pause, Play, Square } from 'lucide-react'
import type { ComputerUseSession } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { computerUseActionDescription } from './ComputerUseLiveActionRow'

type ComputerUseCompactHeaderProps = {
  session: ComputerUseSession
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onManageApps?: () => void
}

export function ComputerUseCompactHeader({
  session,
  onPause,
  onResume,
  onStop,
  onManageApps,
}: ComputerUseCompactHeaderProps) {
  const { t } = useI18n()
  const paused = session.status === 'paused'
  const title = t(
    paused ? 'computerUse.compact.pausedTitle' : 'computerUse.compact.activeTitle',
    { appName: session.appName },
  )
  const action = paused
    ? t('computerUse.compact.pausedStatus')
    : session.currentAction
      ? computerUseActionDescription(session.currentAction, t)
      : t('computerUse.compact.working')

  return (
    <header
      className={`computer-use-compact-header ${paused ? 'is-paused' : 'is-active'}`}
      aria-label={title}
    >
      <div className="computer-use-compact-copy">
        <div className="computer-use-compact-title">
          <span className="computer-use-compact-signal" aria-hidden="true" />
          <strong>{title}</strong>
        </div>
        <span className="computer-use-compact-action" title={action}>{action}</span>
      </div>
      <div className="computer-use-compact-controls">
        {onManageApps && (
          <button type="button" onClick={onManageApps} aria-label={t('computerUse.apps.manage')}>
            <AppWindow size={14} aria-hidden="true" />
          </button>
        )}
        {paused ? (
          <button type="button" onClick={onResume} aria-label={t('computerUse.active.resume')}>
            <Play size={14} aria-hidden="true" />
          </button>
        ) : (
          <button type="button" onClick={onPause} aria-label={t('computerUse.active.pause')}>
            <Pause size={14} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="computer-use-compact-stop"
          onClick={onStop}
          aria-label={t('computerUse.active.stopAria')}
        >
          <Square size={12} fill="currentColor" aria-hidden="true" />
          <kbd>Esc</kbd>
        </button>
      </div>
    </header>
  )
}
