import { ChevronDown, ChevronRight, ExternalLink, RotateCcw } from 'lucide-react'
import type { WorkspaceChangeEntry } from '../../../../shared/types'
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
  return (
    <section className={`review-file-section ${expanded ? 'is-open' : ''}`}>
      <div className="review-file-header">
        <button type="button" className="review-file-toggle" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="review-file-name" title={file.path}>{file.path}</span>
          <span className="review-file-status">{statusLabel(file.status)}</span>
          <span className="review-file-stat add">+{file.additions}</span>
          <span className="review-file-stat del">-{file.deletions}</span>
        </button>
        <div className="review-file-actions">
          <button type="button" className="ui-tooltip" data-tooltip="Abrir no app padrão" onClick={onOpenExternal} disabled={!canOpenExternal} aria-label="Abrir no app padrão">
            <ExternalLink size={14} />
          </button>
          <button type="button" className="ui-tooltip" data-tooltip="Descartar mudanças" onClick={onRevert} disabled={!canRevert} aria-label="Descartar mudanças">
            <RotateCcw size={14} />
          </button>
        </div>
      </div>
      {expanded ? <ReviewDiffBody loading={Boolean(diffState?.loading)} diff={diffState?.diff} /> : null}
    </section>
  )
}
