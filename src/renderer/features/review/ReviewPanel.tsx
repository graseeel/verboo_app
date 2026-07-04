import { useCallback, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { FileCheck2, PanelRightClose } from 'lucide-react'
import type {
  WorkspaceBranchInfo,
  WorkspaceBranchSwitchResult,
  WorkspaceChangeEntry,
  WorkspaceReviewCapabilities,
} from '../../../shared/types'
import { ReviewBranchControls } from './components/ReviewBranchControls'
import { ReviewConfirmDialog } from './components/ReviewConfirmDialog'
import { ReviewFileSection } from './components/ReviewFileSection'
import { useReviewDiffs } from './hooks/useReviewDiffs'
import type { ReviewTarget } from './useReviewPanel'
import { useI18n } from '../../i18n'

const DEFAULT_CAPABILITIES: WorkspaceReviewCapabilities = {
  canDiff: true,
  canRevert: true,
  canOpenExternal: true,
}

type ReviewPanelProps = {
  open: boolean
  width: number
  target?: ReviewTarget
  onSetWidth: (width: number) => void
  onClose: () => void
  onReverted: () => void
  onSwitchBranch: (branchName: string) => Promise<WorkspaceBranchSwitchResult>
  minWidth: number
  maxWidth: number
  capabilities?: WorkspaceReviewCapabilities
  branchInfo?: WorkspaceBranchInfo
}

export function ReviewPanel(props: ReviewPanelProps) {
  const { t } = useI18n()
  const {
    open,
    width,
    target,
    onSetWidth,
    onClose,
    onReverted,
    onSwitchBranch,
    minWidth,
    maxWidth,
    branchInfo,
  } = props
  const capabilities = props.capabilities ?? DEFAULT_CAPABILITIES
  const startResize = useResizeHandle(width, minWidth, maxWidth, onSetWidth)
  const [confirmingFile, setConfirmingFile] = useState<WorkspaceChangeEntry | undefined>()
  const files = target?.files ?? []
  const { expandedPaths, toggleFile, diffStateForFile } = useReviewDiffs({
    open,
    target,
    canDiff: capabilities.canDiff,
    diffLoadFailedMessage: t('review.diffLoadFailed'),
    diffUnavailableMessage: t('review.diffUnavailable'),
  })

  const revert = useCallback(async (file: WorkspaceChangeEntry) => {
    if (!target || !capabilities.canRevert) return
    const result = await window.verboo.revertFile(target.workingDirectory, file.path)
    setConfirmingFile(undefined)
    if (result.ok) onReverted()
  }, [capabilities.canRevert, onReverted, target?.workingDirectory])

  const openExternal = useCallback((file: WorkspaceChangeEntry) => {
    if (target && capabilities.canOpenExternal) void window.verboo.openExternalFile(target.workingDirectory, file.path)
  }, [capabilities.canOpenExternal, target?.workingDirectory])

  if (!open || !target) return null

  const totalAdditions = files.reduce((total, file) => total + file.additions, 0)
  const totalDeletions = files.reduce((total, file) => total + file.deletions, 0)

  return (
    <aside className="review-panel" style={{ width }} aria-label={t('review.panelAria')}>
      <div className="review-resizer" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
      <header className="review-header">
        <div className="review-header-main">
          <span className="review-title">{t('review.title')}</span>
          <button type="button" onClick={onClose} aria-label={t('review.close')}>
            <PanelRightClose size={16} />
          </button>
        </div>
        <ReviewBranchControls
          branchInfo={branchInfo}
          totalAdditions={totalAdditions}
          totalDeletions={totalDeletions}
          onSwitchBranch={onSwitchBranch}
        />
      </header>

      <div className="review-file-list">
        {files.length === 0 ? (
          <div className="empty-state review-empty">
            <span className="empty-state-icon" aria-hidden="true"><FileCheck2 size={17} /></span>
            <span className="empty-state-title">{t('review.emptyTitle')}</span>
            <span className="empty-state-hint">{t('review.empty')}</span>
          </div>
        ) : files.map(file => {
          const expanded = expandedPaths.has(file.path)
          return (
            <ReviewFileSection
              key={file.path}
              file={file}
              expanded={expanded}
              diffState={diffStateForFile(file)}
              canOpenExternal={capabilities.canOpenExternal}
              canRevert={capabilities.canRevert}
              onToggle={() => toggleFile(file.path)}
              onOpenExternal={() => openExternal(file)}
              onRevert={() => setConfirmingFile(file)}
            />
          )
        })}
      </div>

      {confirmingFile && capabilities.canRevert ? (
        <ReviewConfirmDialog
          file={confirmingFile}
          onCancel={() => setConfirmingFile(undefined)}
          onConfirm={() => revert(confirmingFile)}
        />
      ) : null}
    </aside>
  )
}

function useResizeHandle(width: number, min: number, max: number, onSetWidth: (width: number) => void) {
  const widthRef = useRef(width)
  widthRef.current = width

  return useCallback((event: PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthRef.current
    // Track the pointer 1:1: the layout's grid transition must not ease the
    // panel behind the drag (rubber-band feel).
    document.querySelector('.app-layout')?.classList.add('is-resizing')

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      onSetWidth(Math.max(min, Math.min(max, startWidth + startX - moveEvent.clientX)))
    }

    const onUp = () => {
      document.querySelector('.app-layout')?.classList.remove('is-resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [max, min, onSetWidth])
}
