import { useI18n } from '../../i18n'

export function TurnErrorDetails({ detail, correlationId }: { detail?: string; correlationId?: string }) {
  const { t } = useI18n()
  const visibleCorrelationId = correlationId?.trim()

  return (
    <details className="turn-error-details">
      <summary>{t('transcript.showTechnicalDetails')}</summary>
      {visibleCorrelationId ? (
        <div className="turn-error-correlation">
          <span>{t('transcript.correlationId')}</span>
          <code>{visibleCorrelationId}</code>
        </div>
      ) : null}
      {detail ? <pre>{detail}</pre> : null}
    </details>
  )
}
