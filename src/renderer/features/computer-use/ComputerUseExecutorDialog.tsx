import { Eye } from 'lucide-react'
import { useId, useRef } from 'react'
import { useI18n } from '../../i18n'
import { useDialogFocusTrap } from './useDialogFocusTrap'

type ComputerUseExecutorDialogProps = {
  destinationModelName: string
  onContinue: () => void
  onCancel: () => void
}

export function ComputerUseExecutorDialog({
  destinationModelName,
  onContinue,
  onCancel,
}: ComputerUseExecutorDialogProps) {
  const { t } = useI18n()
  const titleId = useId()
  const descriptionId = useId()
  const reasonId = useId()
  const continueRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useDialogFocusTrap<HTMLElement>({
    initialFocusRef: continueRef,
    onEscape: onCancel,
  })

  return (
    <div className="modal-backdrop computer-use-consent-backdrop">
      <section
        ref={dialogRef}
        className="confirm-modal computer-use-consent-dialog computer-use-executor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId} ${reasonId}`}
        tabIndex={-1}
      >
        <header className="computer-use-consent-header">
          <span className="computer-use-consent-icon" aria-hidden="true">
            <Eye size={18} />
          </span>
          <div>
            <h2 id={titleId}>{t('computerUse.executor.title')}</h2>
            <p id={descriptionId}>
              {t('computerUse.executor.description', { model: destinationModelName })}
            </p>
          </div>
        </header>

        <div className="computer-use-consent-disclosures">
          <p id={reasonId}>{t('computerUse.executor.reason')}</p>
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button ref={continueRef} className="confirm-primary" type="button" onClick={onContinue}>
            {t('computerUse.executor.continue')}
          </button>
        </div>
      </section>
    </div>
  )
}
