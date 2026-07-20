import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n'
import type { LinkDestination } from './markdownLink'

type MarkdownLinkDialogProps = {
  destination: LinkDestination
  onCancel: () => void
  onConfirm: () => void
}

export function MarkdownLinkDialog({
  destination,
  onCancel,
  onConfirm,
}: MarkdownLinkDialogProps) {
  const { t } = useI18n()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const local = destination.kind === 'local'
  const titleKey = local ? 'transcript.linkDialog.localTitle' : 'transcript.linkDialog.externalTitle'
  const badgeKey = local ? 'transcript.linkDialog.localBadge' : 'transcript.linkDialog.externalBadge'
  const bodyKey = local ? 'transcript.linkDialog.localBody' : 'transcript.linkDialog.externalBody'

  useEffect(() => {
    cancelRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [onCancel])

  const portalTarget = document.querySelector<HTMLElement>('.app-shell') ?? document.body

  return createPortal(
    <div
      className="modal-backdrop markdown-link-backdrop"
      onPointerDown={event => event.target === event.currentTarget && onCancel()}
    >
      <section
        className="confirm-modal markdown-link-dialog t-modal is-open"
        role="dialog"
        aria-modal="true"
        aria-labelledby="markdown-link-dialog-title"
        aria-describedby="markdown-link-dialog-description"
      >
        <header className="markdown-link-dialog-head">
          <span className={`markdown-link-kind is-${destination.kind}`}>{t(badgeKey)}</span>
          <h2 id="markdown-link-dialog-title">{t(titleKey)}</h2>
        </header>
        <div className="markdown-link-destination">
          <span>{t('transcript.linkDialog.destination')}</span>
          <code>{destination.href}</code>
        </div>
        <p id="markdown-link-dialog-description">{t(bodyKey)}</p>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="confirm-primary" type="button" onClick={onConfirm}>
            {t('transcript.linkDialog.openBrowser')}
          </button>
        </div>
      </section>
    </div>,
    portalTarget,
  )
}
