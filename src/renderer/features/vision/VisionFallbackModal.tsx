import { Eye } from 'lucide-react'
import type { VisionFallbackConsent, VisionFallbackState } from '../../../shared/types'
import { useI18n } from '../../i18n'

type VisionFallbackModalProps = {
  state: VisionFallbackState
  onRespond: (consent: { allowOnce: boolean } | { persist: VisionFallbackConsent }) => void
}

/**
 * Panel shown inside the bottom-dock when the user sends an image attachment
 * but the selected model doesn't support vision. Follows the same in-flow
 * pattern as PermissionApprovalPanel and QuestionWizard.
 */
export function VisionFallbackModal({ state, onRespond }: VisionFallbackModalProps) {
  const { t } = useI18n()
  const helperName = state.helperModel?.displayName ?? t('vision.helperFallback')

  return (
    <section className="vision-fallback-panel" role="dialog" aria-modal="true">
      <div className="vision-fallback-header">
        <Eye size={16} aria-hidden="true" />
        <span>{t('vision.title')}</span>
      </div>
      <p className="vision-fallback-description">
        {t('vision.description', { modelName: helperName })}
      </p>
      <div className="vision-fallback-actions">
        <button type="button" onClick={() => onRespond({ allowOnce: true })}>
          {t('vision.allowOnce')}
        </button>
        <button type="button" onClick={() => onRespond({ persist: 'always' as VisionFallbackConsent })}>
          {t('vision.always')}
        </button>
        <button className="vision-fallback-never" type="button" onClick={() => onRespond({ persist: 'never' as VisionFallbackConsent })}>
          {t('vision.never')}
        </button>
      </div>
    </section>
  )
}
