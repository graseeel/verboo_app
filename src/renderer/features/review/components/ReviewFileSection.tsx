import { ChevronDown, ChevronRight, ExternalLink, RotateCcw } from 'lucide-react'
import type { WorkspaceChangeEntry } from '../../../../shared/types'
import { useI18n } from '../../../i18n'
import { statusLabel, type DiffState } from '../reviewDiffModel'
import { ReviewDiffBody } from './ReviewDiffBody'

type ReviewFileSectionProps = {
  file: WorkspaceChangeEntry
  expanded: boolean
  diffState?: DiffState
  canOpenExternal: boolean
  canRevert: boolean
  onToggle: () => void
  onOpenExternal: () => void
  onRevert: () => void
}

export function ReviewFileSection({
  file,
  expanded,
  diffState,
  canOpenExternal,
  canRevert,
  onToggle,
  onOpenExternal,
  onRevert,
}: ReviewFileSectionProps) {
  const { t } = useI18n()

  return (
    <section className={`review-file-section ${expanded ? 'is-open' : ''}`}>
      <div className="review-file-header">
        <button type="button" className="review-file-toggle" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="review-file-name" title={file.path}>{file.path}</span>
          <span className="review-file-status">{statusLabel(file.status, t)}</span>
          <span className="review-file-stat add">+{file.additions}</span>
          <span className="review-file-stat del">-{file.deletions}</span>
        </button>
        <div className="review-file-actions">
          <button type="button" className="ui-tooltip" data-tooltip={t('review.openDefault')} onClick={onOpenExternal} disabled={!canOpenExternal} aria-label={t('review.openDefault')}>
            <ExternalLink size={14} />
          </button>
          <button type="button" className="ui-tooltip" data-tooltip={t('review.revert')} onClick={onRevert} disabled={!canRevert} aria-label={t('review.revert')}>
            <RotateCcw size={14} />
          </button>
        </div>
      </div>
      {expanded ? <ReviewDiffBody loading={Boolean(diffState?.loading)} diff={diffState?.diff} /> : null}
    </section>
  )
}
