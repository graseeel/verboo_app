import type { WorkspaceChangeEntry } from '../../../../shared/types'
import { useI18n } from '../../../i18n'

type ReviewConfirmDialogProps = {
  file: WorkspaceChangeEntry
  onCancel: () => void
  onConfirm: () => void
}

export function ReviewConfirmDialog({ file, onCancel, onConfirm }: ReviewConfirmDialogProps) {
  const { t } = useI18n()

  return (
    <div className="review-confirm-overlay" role="dialog" aria-modal="true">
      <div className="review-confirm">
        <h2>{t('review.revertQuestion')}</h2>
        <p>{file.status === 'untracked'
          ? t('review.confirmRemoveNewFile', { path: file.path })
          : t('review.confirmDiscardFile', { path: file.path })}</p>
        <div className="review-confirm-actions">
          <button type="button" className="secondary-action" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="button" className="primary-action danger" onClick={onConfirm}>{t('review.revert')}</button>
        </div>
      </div>
    </div>
  )
}
