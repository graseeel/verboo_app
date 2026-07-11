import { useCallback, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { FileCheck2, GitMerge, PanelRightClose } from 'lucide-react'
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
import { useToast } from '../../components/Toast'

const DEFAULT_CAPABILITIES: WorkspaceReviewCapabilities = {
  canDiff: true,
  canRevert: true,
  canOpenExternal: true,
  canCommit: false,
  canCreatePr: false,
}

const DEFAULT_PR_TITLE = 'Review changes'

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

  // ── Commit + PR actions (QW4) ───────────────────────────────────────────
  // Local UI state only — the bridge owns the actual GitHub/Git work. We
  // also reuse `onReverted` to refresh the file list after a successful
  // commit (it triggers the same `refreshWorkspaceReview` reload), so we
  // don't ship a parallel `onCommitted` callback.
  const { toast } = useToast()
  const [commitMessage, setCommitMessage] = useState('')
  const [prTitle, setPrTitle] = useState('')
  const [busy, setBusy] = useState<'idle' | 'commit' | 'pr'>('idle')

  const commitDisabled = !capabilities.canCommit
    || files.length === 0
    || busy !== 'idle'
    || commitMessage.trim().length === 0

  const prDisabled = !capabilities.canCreatePr
    || busy !== 'idle'

  async function commit() {
    if (!target || commitDisabled) {
      if (!target) return
      toast(t('review.commitEmptyMessage'))
      return
    }
    const message = commitMessage.trim()
    if (!message) {
      toast(t('review.commitEmptyMessage'))
      return
    }
    setBusy('commit')
    try {
      const result = await window.verboo.commitWorkspaceChanges(target.workingDirectory, message)
      if (result.ok) {
        setCommitMessage('')
        toast(t('review.commitSuccess', { hash: result.commitHash ?? '' }))
        // Refresh the file list — reusing the revert refresh pathway.
        onReverted()
      } else {
        toast(t('review.commitFailed', { message: result.error ?? 'unknown' }), 'error')
      }
    } catch (err) {
      toast(t('review.commitFailed', { message: err instanceof Error ? err.message : String(err) }), 'error')
    } finally {
      setBusy('idle')
    }
  }

  async function openPr() {
    if (!target || prDisabled) return
    const title = prTitle.trim() || DEFAULT_PR_TITLE
    setBusy('pr')
    try {
      const result = await window.verboo.createWorkspacePullRequest(target.workingDirectory, title)
      if (result.ok) {
        toast(t('review.prSuccess', { url: result.url ?? '' }))
        // Try to open in browser — Tauri v2 keeps window.open locked for
        // security, so this is best-effort and silently no-ops on failure.
        if (result.url) {
          try { window.open(result.url, '_blank', 'noopener,noreferrer') } catch { /* ignore */ }
        }
      } else {
        toast(t('review.prFailed', { message: result.error ?? 'unknown' }), 'error')
      }
    } catch (err) {
      toast(t('review.prFailed', { message: err instanceof Error ? err.message : String(err) }), 'error')
    } finally {
      setBusy('idle')
    }
  }

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

      {(capabilities.canCommit || capabilities.canCreatePr) && (
        <footer className="review-actions">
          {capabilities.canCommit && files.length > 0 && (
            <section className="review-action-section">
              <header className="review-action-section-head">{t('review.commitSection')}</header>
              <textarea
                className="review-action-input review-action-textarea"
                value={commitMessage}
                onChange={event => setCommitMessage(event.target.value)}
                placeholder={t('review.commitPlaceholder')}
                rows={3}
                disabled={busy !== 'idle'}
                spellCheck
              />
              <button
                type="button"
                className="primary-action"
                disabled={commitDisabled}
                onClick={commit}
              >
                {busy === 'commit' ? t('review.commitButtonBusy') : t('review.commitButton')}
              </button>
            </section>
          )}
          {capabilities.canCreatePr && (
            <section className="review-action-section">
              <header className="review-action-section-head">{t('review.prSection')}</header>
              <input
                className="review-action-input"
                type="text"
                value={prTitle}
                onChange={event => setPrTitle(event.target.value)}
                placeholder={t('review.prTitlePlaceholder')}
                disabled={busy !== 'idle'}
                spellCheck
              />
              <small className="review-action-hint">{t('review.prTitleHint')}</small>
              <button
                type="button"
                className="primary-action"
                disabled={prDisabled}
                onClick={openPr}
              >
                <GitMerge size={14} />
                <span>{busy === 'pr' ? t('review.prButtonBusy') : t('review.prButton')}</span>
              </button>
            </section>
          )}
        </footer>
      )}
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
