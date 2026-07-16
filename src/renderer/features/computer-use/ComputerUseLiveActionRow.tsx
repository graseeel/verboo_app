import { LoaderCircle, Pause } from 'lucide-react'
import type { ComputerUseActionVerb, ComputerUsePendingActionEvent } from '../../../shared/types'
import { useI18n, type Translator } from '../../i18n'

type ComputerUseLiveActionRowProps = {
  status: 'active' | 'paused'
  appName: string
  action?: ComputerUsePendingActionEvent
}

export function ComputerUseLiveActionRow({ status, appName, action }: ComputerUseLiveActionRowProps) {
  const { t } = useI18n()
  const paused = status === 'paused'
  const copy = paused
    ? t('computerUse.compact.pausedStatus')
    : action
      ? computerUseActionDescription(action, t)
      : t('computerUse.compact.working')

  return (
    <div
      className={`computer-use-live-action ${paused ? 'is-paused' : 'is-active'}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-app-name={appName}
    >
      <span className="computer-use-live-action-icon" aria-hidden="true">
        {paused ? <Pause size={14} /> : <LoaderCircle size={14} />}
      </span>
      <span className={paused ? undefined : 'shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm'}>
        {copy}
      </span>
    </div>
  )
}

export function computerUseActionDescription(
  action: ComputerUsePendingActionEvent,
  t: Translator,
): string {
  const sentence = t('computerUse.active.action', {
    verb: inProgressVerbLabel(action.verb, t),
    appName: action.appName,
  })
  return action.targetLabel ? `${sentence} · ${action.targetLabel}` : sentence
}

function inProgressVerbLabel(verb: ComputerUseActionVerb, t: Translator): string {
  const map: Record<ComputerUseActionVerb, string> = {
    click: 'computerUse.verb.clicking',
    move: 'computerUse.verb.moving',
    type: 'computerUse.verb.typing',
    drag: 'computerUse.verb.dragging',
    scroll: 'computerUse.verb.scrolling',
    read: 'computerUse.verb.reading',
    launch: 'computerUse.verb.launching',
    close: 'computerUse.verb.closing',
    hotkey: 'computerUse.verb.pressingKeys',
  }
  return t(map[verb])
}
