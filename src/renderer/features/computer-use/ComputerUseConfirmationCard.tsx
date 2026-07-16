import { AppWindow, ShieldAlert } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import type { ComputerUsePendingConfirmation } from '../../../shared/types'
import { useI18n, type Translator } from '../../i18n'
import { friendlyConfirmationSummary } from './computerUseConfirmationSummary'
import { useDialogFocusTrap } from './useDialogFocusTrap'

type ComputerUseConfirmationCardProps = {
  variant: 'inline' | 'modal'
  confirmation: ComputerUsePendingConfirmation
  appName: string
  busy?: boolean
  onAllowOnce: () => void
  onDeny: () => void
}

export function ComputerUseConfirmationCard({
  variant,
  confirmation,
  appName,
  busy = false,
  onAllowOnce,
  onDeny,
}: ComputerUseConfirmationCardProps) {
  const { t } = useI18n()
  const titleId = useId()
  const descriptionId = useId()
  const onceId = useId()
  const denyRef = useRef<HTMLButtonElement>(null)
  const cardRef = useDialogFocusTrap<HTMLElement>({
    initialFocusRef: denyRef,
    onEscape: onDeny,
    enabled: variant === 'modal',
  })
  const displayAppName = appName.trim()
    && appName.trim().toLowerCase() !== confirmation.appBundleId.trim().toLowerCase()
    ? appName.trim()
    : t('computerUse.confirmation.authorizedApp')

  useEffect(() => {
    if (variant === 'inline') denyRef.current?.focus()
  }, [variant])

  return (
    <section
      ref={cardRef}
      className={variant === 'modal'
        ? 'confirm-modal computer-use-consent-dialog computer-use-confirmation-dialog computer-use-confirmation-card'
        : 'computer-use-confirmation-card computer-use-confirmation-inline'}
      role={variant === 'modal' ? 'dialog' : 'alertdialog'}
      aria-modal={variant === 'modal' ? 'true' : undefined}
      aria-labelledby={titleId}
      aria-describedby={`${descriptionId} ${onceId}`}
      tabIndex={-1}
    >
      <header className="computer-use-consent-header">
        <span className="computer-use-consent-icon computer-use-confirmation-icon" aria-hidden="true">
          <ShieldAlert size={18} />
        </span>
        <div>
          <h2 id={titleId}>{t('computerUse.confirmation.title')}</h2>
          <p id={descriptionId}>{t('computerUse.confirmation.description')}</p>
        </div>
      </header>

      <dl className="computer-use-consent-details">
        <div>
          <dt>{t('computerUse.confirmation.app')}</dt>
          <dd><AppWindow size={14} aria-hidden="true" /> {displayAppName}</dd>
        </div>
        <div>
          <dt>{t('computerUse.confirmation.action')}</dt>
          <dd>{friendlyActionLabel(confirmation.action, t)}</dd>
        </div>
        <div>
          <dt>{t('computerUse.confirmation.effect')}</dt>
          <dd>{friendlyConfirmationSummary(confirmation.summary, t)}</dd>
        </div>
      </dl>

      <p id={onceId} className="computer-use-confirmation-once">{t('computerUse.confirmation.once')}</p>

      <div className="modal-actions">
        <button ref={denyRef} type="button" disabled={busy} onClick={onDeny}>
          {t('computerUse.confirmation.deny')}
        </button>
        <button className="confirm-primary" type="button" disabled={busy} onClick={onAllowOnce}>
          {busy ? t('computerUse.confirmation.deciding') : t('computerUse.confirmation.allowOnce')}
        </button>
      </div>
    </section>
  )
}

const ACTION_LABEL_KEYS: Record<string, string> = {
  screenshot: 'computerUse.confirmation.actions.screenshot',
  left_click: 'computerUse.confirmation.actions.leftClick',
  right_click: 'computerUse.confirmation.actions.rightClick',
  middle_click: 'computerUse.confirmation.actions.middleClick',
  double_click: 'computerUse.confirmation.actions.doubleClick',
  triple_click: 'computerUse.confirmation.actions.tripleClick',
  type: 'computerUse.confirmation.actions.type',
  key: 'computerUse.confirmation.actions.key',
  hold_key: 'computerUse.confirmation.actions.holdKey',
  mouse_move: 'computerUse.confirmation.actions.mouseMove',
  scroll: 'computerUse.confirmation.actions.scroll',
  left_click_drag: 'computerUse.confirmation.actions.leftClickDrag',
  left_mouse_down: 'computerUse.confirmation.actions.leftMouseDown',
  left_mouse_up: 'computerUse.confirmation.actions.leftMouseUp',
  wait: 'computerUse.confirmation.actions.wait',
  zoom: 'computerUse.confirmation.actions.zoom',
}

function friendlyActionLabel(action: string, t: Translator): string {
  return t(ACTION_LABEL_KEYS[action] ?? 'computerUse.confirmation.actions.unknown')
}
