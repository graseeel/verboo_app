import { RotateCcw } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { useI18n } from '../../i18n'

type ComputerUseRecoveryDialogProps = {
  executorModelName: string
  originalModelName: string
  onResume: () => void
  onRestore: () => void
}

export function ComputerUseRecoveryDialog({
  executorModelName,
  originalModelName,
  onResume,
  onRestore,
}: ComputerUseRecoveryDialogProps) {
  const { t } = useI18n()
  const titleId = useId()
  const descriptionId = useId()
  const choiceId = useId()
  const resumeRef = useRef<HTMLButtonElement>(null)
  const restoreRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    restoreRef.current?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onRestore()
        return
      }

      if (event.key !== 'Tab') return

      if (event.shiftKey && document.activeElement === resumeRef.current) {
        event.preventDefault()
        restoreRef.current?.focus()
      } else if (!event.shiftKey && document.activeElement === restoreRef.current) {
        event.preventDefault()
        resumeRef.current?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      previouslyFocused?.focus()
    }
  }, [onRestore])

  return (
    <div className="modal-backdrop computer-use-consent-backdrop">
      <section
        className="confirm-modal computer-use-consent-dialog computer-use-recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId} ${choiceId}`}
      >
        <header className="computer-use-consent-header">
          <span className="computer-use-consent-icon" aria-hidden="true">
            <RotateCcw size={18} />
          </span>
          <div>
            <h2 id={titleId}>{t('computerUse.recovery.title')}</h2>
            <p id={descriptionId}>
              {t('computerUse.recovery.description', { executor: executorModelName })}
            </p>
          </div>
        </header>

        <div className="computer-use-consent-disclosures">
          <p id={choiceId}>
            {t('computerUse.recovery.choice', { original: originalModelName })}
          </p>
        </div>

        <div className="modal-actions">
          <button ref={resumeRef} type="button" onClick={onResume}>
            {t('computerUse.recovery.resume')}
          </button>
          <button ref={restoreRef} className="confirm-primary" type="button" onClick={onRestore}>
            {t('computerUse.recovery.restore')}
          </button>
        </div>
      </section>
    </div>
  )
}
