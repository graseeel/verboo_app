import { useI18n } from '../../i18n'

export function TurnErrorDetails({ detail }: { detail: string }) {
  const { t } = useI18n()

  return (
    <details className="turn-error-details">
      <summary>{t('transcript.showTechnicalDetails')}</summary>
      <pre>{detail}</pre>
    </details>
  )
}
