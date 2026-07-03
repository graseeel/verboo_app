import type { WorkspaceChangeEntry } from '../../../../shared/types'

type ReviewConfirmDialogProps = {
  file: WorkspaceChangeEntry
  onCancel: () => void
  onConfirm: () => void
}

export function ReviewConfirmDialog({ file, onCancel, onConfirm }: ReviewConfirmDialogProps) {
  return (
    <div className="review-confirm-overlay" role="dialog" aria-modal="true">
      <div className="review-confirm">
        <h2>Descartar mudanças?</h2>
        <p>{file.status === 'untracked'
          ? `O arquivo novo "${file.path}" será removido do disco.`
          : `As mudanças staged e unstaged de "${file.path}" serão descartadas.`}</p>
        <div className="review-confirm-actions">
          <button type="button" className="secondary-action" onClick={onCancel}>Cancelar</button>
          <button type="button" className="primary-action danger" onClick={onConfirm}>Descartar</button>
        </div>
      </div>
    </div>
  )
}
