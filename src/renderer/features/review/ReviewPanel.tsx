import { useCallback, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { FileCheck2, GitCommitHorizontal, GitPullRequest, PanelRightClose, Upload, X } from 'lucide-react'
import type {
  WorkspaceBranchInfo,
  WorkspaceBranchSwitchResult,
  WorkspaceChangeEntry,
  WorkspaceReviewCapabilities,
  WorkspaceReviewMetadata,
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
  canPush: false,
  canCreatePr: false,
}

const DEFAULT_PR_TITLE = 'Review changes'

/** Trailer appended when Settings → includeVerbooCoAuthor is on. */
export const VERBOO_CO_AUTHOR_TRAILER = 'Co-Authored-By: Verboo Code <noreply@code.verboo.ai>'

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
  metadata?: WorkspaceReviewMetadata
  /** From user settings; default false (opt-in co-authorship). */
  includeVerbooCoAuthor?: boolean
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
    metadata,
    includeVerbooCoAuthor = false,
  } = props
  const capabilities = props.capabilities ?? DEFAULT_CAPABILITIES
  const meta = metadata
  const hasUpstream = meta?.hasUpstream
  const hasRemote = meta?.hasRemote
  const aheadCount = meta?.aheadCount ?? 0
  const lastCommitSubject = meta?.lastCommitSubject
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

  // Commit + PR actions (QW4).
  // Local UI state only — the bridge owns the actual GitHub/Git work. We
  // also reuse `onReverted` to refresh the file list after a successful
  // commit (it triggers the same `refreshWorkspaceReview` reload), so we
  // don't ship a parallel `onCommitted` callback.
  const { toast } = useToast()
  const [commitMessage, setCommitMessage] = useState('')
  const [commitBody, setCommitBody] = useState('')
  const [prTitle, setPrTitle] = useState('')
  const [busy, setBusy] = useState<'idle' | 'commit' | 'push' | 'pr'>('idle')
  const [commitModalOpen, setCommitModalOpen] = useState(false)
  const [prModalOpen, setPrModalOpen] = useState(false)
  const modalBackdropRef = useRef<HTMLDivElement>(null)

  const canPublish = capabilities.canCommit || capabilities.canPush || capabilities.canCreatePr
  const hasFiles = files.length > 0
  const commitButtonDisabled = !capabilities.canCommit || !hasFiles || busy !== 'idle' || commitMessage.trim().length === 0
  const pushEnabled = capabilities.canPush && busy === 'idle' && !hasFiles && (!hasUpstream || aheadCount > 0)
  const prDisabled = !capabilities.canCreatePr || busy !== 'idle' || hasFiles

  function buildFullCommitMessage(title: string, body?: string, withCoAuthor = false): string {
    const trimmedTitle = title.trim()
    const trimmedBody = body?.trim()
    let message = trimmedBody ? `${trimmedTitle}\n\n${trimmedBody}` : trimmedTitle
    if (withCoAuthor) {
      const already =
        /co-authored-by:\s*verboo code\s*<noreply@code\.verboo\.ai>/i.test(message)
      if (!already) {
        message = `${message}\n\n${VERBOO_CO_AUTHOR_TRAILER}`
      }
    }
    return message
  }

  function openCommitModal() { setCommitModalOpen(true); setCommitMessage(''); setCommitBody('') }
  function closeCommitModal() { setCommitModalOpen(false) }
  function openPrModal() { setPrModalOpen(true) }
  function closePrModal() { setPrModalOpen(false) }

  async function commitAndPush() {
    if (!target || (!hasFiles && !capabilities.canPush)) return
    if (!hasFiles) { await pushDirect(); return }
    const message = buildFullCommitMessage(commitMessage, commitBody, includeVerbooCoAuthor)
    setBusy('commit')
    try {
      const r = await window.verboo.commitWorkspaceChanges(target.workingDirectory, message)
      if (!r.ok) { toast(t('review.commitFailed', { message: r.error ?? 'unknown' }), 'error'); setBusy('idle'); return }
      setCommitMessage(''); setCommitBody('')
      toast(t('review.commitSuccess', { hash: r.commitHash ?? '' }))
      onReverted()
    } catch (err) {
      toast(t('review.commitFailed', { message: err instanceof Error ? err.message : String(err) }), 'error')
      setBusy('idle'); return
    }
    // Commit succeeded — tree is clean; push regardless of stale hasFiles
    if (!capabilities.canPush) { setBusy('idle'); return }
    await pushDirect()
  }

  async function pushDirect() {
    if (!target || !capabilities.canPush) return
    setBusy('push')
    try {
      const r = await window.verboo.pushWorkspaceChanges(target.workingDirectory)
      if (!r.ok) { toast(t('review.pushFailed', { message: r.error ?? 'unknown' }), 'error'); setBusy('idle'); return }
      toast(t('review.pushSuccess'))
      onReverted()
    } catch (err) {
      toast(t('review.pushFailed', { message: err instanceof Error ? err.message : String(err) }), 'error')
    }
    setBusy('idle')
  }

  async function commit() {
    if (!target || !hasFiles) return
    const message = buildFullCommitMessage(commitMessage, commitBody, includeVerbooCoAuthor)
    setBusy('commit')
    try {
      const result = await window.verboo.commitWorkspaceChanges(target.workingDirectory, message)
      if (result.ok) {
        setCommitMessage('')
        setCommitBody('')
        toast(t('review.commitSuccess', { hash: result.commitHash ?? '' }))
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

  async function push() { await pushDirect() }

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
        >
          {canPublish && (
            <span className="review-publish-actions">
              <button
                type="button"
                className="review-publish-button ui-tooltip"
                onClick={openCommitModal}
                disabled={!capabilities.canCommit && !capabilities.canPush}
                data-tooltip={t('review.publishButtonHint')}
                aria-label={t('review.publishButtonHint')}
              >
                <GitCommitHorizontal size={14} />
              </button>
              <button
                type="button"
                className="review-publish-button ui-tooltip"
                onClick={push}
                disabled={!capabilities.canPush || hasFiles}
                data-tooltip={!capabilities.canPush || !hasFiles ? t('review.publishButtonHint') : t('review.pushCleanTreeRequired')}
                aria-label={!capabilities.canPush || !hasFiles ? t('review.pushButton') : t('review.pushCleanTreeRequired')}
              >
                <Upload size={14} />
              </button>
              {capabilities.canCreatePr && (
                <button
                  type="button"
                  className="review-publish-button ui-tooltip"
                  onClick={openPrModal}
                  data-tooltip={t('review.prButton')}
                  aria-label={t('review.prButton')}
                >
                  <GitPullRequest size={14} />
                </button>
              )}
            </span>
          )}
        </ReviewBranchControls>
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

      {/* Commit / Push modal */}
      {commitModalOpen && createPortal(
        <div className="review-modal-backdrop" ref={modalBackdropRef}
          onClick={e => { if (e.target === modalBackdropRef.current) closeCommitModal() }}
          onKeyDown={e => { if (e.key === 'Escape') closeCommitModal() }}
          role="dialog" aria-modal="true" aria-label={t('review.commitSection')}
        >
          <div className="review-modal">
            <header className="review-modal-head">
              <strong>{t('review.commitSection')}</strong>
              <button type="button" className="ghost-button" onClick={closeCommitModal} aria-label={t('common.close')}>
                <X size={15} />
              </button>
            </header>
            <input
              className="review-modal-input"
              type="text"
              value={commitMessage}
              onChange={e => setCommitMessage(e.target.value)}
              placeholder={t('review.commitPlaceholder')}
              autoFocus
            />
            <textarea
              className="review-modal-textarea"
              value={commitBody}
              onChange={e => setCommitBody(e.target.value)}
              placeholder={t('review.commitBodyPlaceholder')}
              rows={4}
            />
            {!hasFiles && lastCommitSubject && (
              <div className="review-modal-muted-line">latest: {lastCommitSubject}</div>
            )}
            {hasFiles && capabilities.canPush && (
              <small className="review-action-hint">{t('review.pushCleanTreeRequired')}</small>
            )}
            {includeVerbooCoAuthor && hasFiles && (
              <div className="review-coauthor-notice" role="status">
                <strong>{t('review.coAuthorActive')}</strong>
                <code className="review-coauthor-trailer">{t('review.coAuthorTrailerPreview')}</code>
              </div>
            )}
            <div className="review-modal-actions">
              <button
                type="button"
                className="primary-action"
                disabled={commitButtonDisabled}
                onClick={commit}
              >
                <GitCommitHorizontal size={14} />
                <span>{busy === 'commit' ? t('review.commitButtonBusy') : t('review.commitButton')}</span>
              </button>
              {capabilities.canPush && (
                <button
                  type="button"
                  className="primary-action"
                  disabled={commitButtonDisabled}
                  onClick={commitAndPush}
                >
                  <GitCommitHorizontal size={14} />
                  <Upload size={14} />
                  <span>{busy === 'commit' || busy === 'push' ? t('review.commitButtonBusy') : t('review.commitAndPush')}</span>
                </button>
              )}
              {capabilities.canPush && !hasFiles && (
                <button
                  type="button"
                  className="primary-action review-modal-tertiary"
                  disabled={!pushEnabled}
                  onClick={push}
                >
                  <Upload size={14} />
                  <span>{busy === 'push' ? t('review.pushButtonBusy') : t('review.pushButton')}</span>
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* PR modal */}
      {prModalOpen && createPortal(
        <div className="review-modal-backdrop"
          onClick={e => { if (e.target === modalBackdropRef.current) closePrModal() }}
          onKeyDown={e => { if (e.key === 'Escape') closePrModal() }}
          role="dialog" aria-modal="true" aria-label={t('review.prSection')}
        >
          <div className="review-modal">
            <header className="review-modal-head">
              <strong>{t('review.prSection')}</strong>
              <button type="button" className="ghost-button" onClick={closePrModal} aria-label={t('common.close')}>
                <X size={15} />
              </button>
            </header>
            <input
              className="review-modal-input"
              type="text"
              value={prTitle}
              onChange={e => setPrTitle(e.target.value)}
              placeholder={t('review.prTitlePlaceholder')}
              autoFocus
            />
            <small className="review-action-hint">{t('review.prTitleHint')}</small>
            <div className="review-modal-actions">
              <button
                type="button"
                className="primary-action"
                disabled={prDisabled}
                onClick={() => { openPr().then(() => closePrModal()) }}
              >
                <GitPullRequest size={14} />
                <span>{busy === 'pr' ? t('review.prButtonBusy') : t('review.prButton')}</span>
              </button>
            </div>
          </div>
        </div>,
        document.body
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
