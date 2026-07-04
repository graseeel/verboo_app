import { TriangleAlert } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'

export type ConfirmRequest = {
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}

// App-styled replacement for window.confirm (shadcn AlertDialog pattern):
// dimmed backdrop, compact card, description, cancel + (destructive) action.
export function ConfirmDialog({ request, onClose }: { request?: ConfirmRequest; onClose: () => void }) {
  const { t } = useI18n()
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!request) return
    confirmRef.current?.focus()
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [request, onClose])

  if (!request) return null

  return (
    <div className="modal-backdrop" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div
        className="confirm-modal confirm-dialog t-modal is-open"
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
      >
        <div className="confirm-dialog-head">
          {request.danger && (
            <span className="confirm-dialog-icon" aria-hidden="true">
              <TriangleAlert size={17} />
            </span>
          )}
          <div>
            <h2>{request.title}</h2>
            <p>{request.description}</p>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
            className={request.danger ? 'danger-button' : 'confirm-primary'}
            type="button"
            onClick={() => {
              request.onConfirm()
              onClose()
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
