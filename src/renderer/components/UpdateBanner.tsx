import { Download, X } from 'lucide-react'
import type { UpdateSnapshot } from '../../shared/types'
import { useI18n } from '../i18n'

type UpdateBannerProps = {
  snapshot: UpdateSnapshot
  onDownload: () => void
  onDismiss: () => void
}

// Persistent bottom-right popup that surfaces an available update. Stays
// visible until the user clicks Download or dismisses it. Sits above toasts
// (z-index 1200) so it never gets covered.
export function UpdateBanner({ snapshot, onDownload, onDismiss }: UpdateBannerProps) {
  const { t } = useI18n()
  const version = snapshot.availableVersion ?? snapshot.releaseName ?? ''
  const body = t('updates.popupBody').replace('{version}', version)

  return (
    <div className="update-banner" role="dialog" aria-live="polite" aria-label={t('updates.popupTitle')}>
      <button
        type="button"
        className="update-banner-close"
        aria-label={t('updates.later')}
        onClick={onDismiss}
      >
        <X size={14} />
      </button>
      <div className="update-banner-icon" aria-hidden="true">
        <Download size={18} />
      </div>
      <div className="update-banner-content">
        <div className="update-banner-title">{t('updates.popupTitle')}</div>
        <div className="update-banner-body">{body}</div>
        <div className="update-banner-actions">
          <button type="button" className="update-banner-primary" onClick={onDownload}>
            {t('updates.downloadNow')}
          </button>
          <button type="button" className="update-banner-secondary" onClick={onDismiss}>
            {t('updates.later')}
          </button>
        </div>
      </div>
    </div>
  )
}
