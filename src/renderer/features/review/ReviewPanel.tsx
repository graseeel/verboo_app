import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { AlertCircle, Check, ChevronDown, ChevronRight, ExternalLink, GitBranch, PanelRightClose, RotateCcw, Search } from 'lucide-react'
import type {
  FileDiff,
  FileDiffStatus,
  WorkspaceBranchInfo,
  WorkspaceBranchSwitchResult,
  WorkspaceChangeEntry,
  WorkspaceReviewCapabilities,
} from '../../../shared/types'
import type { ReviewTarget } from './useReviewPanel'

const DEFAULT_CAPABILITIES: WorkspaceReviewCapabilities = {
  canDiff: true,
  canRevert: true,
  canOpenExternal: true,
}

type DiffState = {
  loading: boolean
  diff?: FileDiff
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
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [confirmingFile, setConfirmingFile] = useState<WorkspaceChangeEntry | undefined>()
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [branchQuery, setBranchQuery] = useState('')
  const [branchMessage, setBranchMessage] = useState<string | undefined>()
  const [switchingBranch, setSwitchingBranch] = useState<string | undefined>()
  const files = target?.files ?? []
  const fileSignature = useMemo(() => files.map(diffCacheKey).join('\n'), [files])
  const requestedDiffKeys = useRef<Set<string>>(new Set())
  const branchMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !target) {
      setExpandedPaths(new Set())
      setDiffs({})
      requestedDiffKeys.current.clear()
      setConfirmingFile(undefined)
      return
    }

    const initialFile = files[Math.max(0, Math.min(target.index, files.length - 1))]
    setExpandedPaths(initialFile ? new Set([initialFile.path]) : new Set())
    setDiffs({})
    requestedDiffKeys.current.clear()
    setConfirmingFile(undefined)
    setBranchMessage(undefined)
  }, [fileSignature, open, target?.workingDirectory, target?.index])

  useEffect(() => {
    if (!open || !target || !capabilities.canDiff) return
    const filesToLoad = files.filter(file => expandedPaths.has(file.path))
    if (filesToLoad.length === 0) return

    let cancelled = false
    for (const file of filesToLoad) {
      const key = diffCacheKey(file)
      if (requestedDiffKeys.current.has(key)) continue
      requestedDiffKeys.current.add(key)

      setDiffs(current => ({ ...current, [key]: { loading: true } }))
      window.verboo.getFileDiff(target.workingDirectory, file.path, file.status)
        .then(diff => {
          if (!cancelled) setDiffs(current => ({ ...current, [key]: { loading: false, diff } }))
        })
        .catch(() => {
          if (!cancelled) {
            setDiffs(current => ({
              ...current,
              [key]: {
                loading: false,
                diff: emptyDiff(file, 'Não foi possível carregar o diff.'),
              },
            }))
          }
        })
    }

    return () => {
      cancelled = true
    }
  }, [capabilities.canDiff, expandedPaths, fileSignature, files, open, target?.workingDirectory])

  const toggleFile = useCallback((path: string) => {
    setExpandedPaths(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const revert = useCallback(async (file: WorkspaceChangeEntry) => {
    if (!target || !capabilities.canRevert) return
    const result = await window.verboo.revertFile(target.workingDirectory, file.path)
    setConfirmingFile(undefined)
    if (result.ok) onReverted()
  }, [capabilities.canRevert, onReverted, target?.workingDirectory])

  const openExternal = useCallback((file: WorkspaceChangeEntry) => {
    if (target && capabilities.canOpenExternal) void window.verboo.openExternalFile(target.workingDirectory, file.path)
  }, [capabilities.canOpenExternal, target?.workingDirectory])

  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase()
    return (branchInfo?.branches ?? []).filter(branch => !query || branch.name.toLowerCase().includes(query))
  }, [branchInfo?.branches, branchQuery])

  const handleSwitchBranch = useCallback(async (branchName: string) => {
    setSwitchingBranch(branchName)
    setBranchMessage(undefined)
    try {
      const result = await onSwitchBranch(branchName)
      setBranchMessage(result.ok ? undefined : result.message || 'Não foi possível trocar de branch.')
      if (result.ok) setBranchMenuOpen(false)
    } finally {
      setSwitchingBranch(undefined)
    }
  }, [onSwitchBranch])

  useEffect(() => {
    if (!branchMenuOpen) return

    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      if (!branchMenuRef.current?.contains(event.target as Node)) setBranchMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBranchMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [branchMenuOpen])

  if (!open || !target) return null

  const totalAdditions = files.reduce((total, file) => total + file.additions, 0)
  const totalDeletions = files.reduce((total, file) => total + file.deletions, 0)

  return (
    <aside className="review-panel" style={{ width }} aria-label="Revisão de arquivo">
      <div className="review-resizer" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
      <header className="review-header">
        <div className="review-header-main">
          <span className="review-title">Revisão</span>
          <button type="button" onClick={onClose} aria-label="Fechar revisão">
            <PanelRightClose size={16} />
          </button>
        </div>
        <div className="review-branch-row">
          <div className="review-branch-menu-wrap" ref={branchMenuRef}>
            <button
              type="button"
              className="review-branch-trigger"
              onClick={() => setBranchMenuOpen(open => !open)}
              aria-expanded={branchMenuOpen}
              disabled={!branchInfo?.branches.length}
            >
              <GitBranch size={14} />
              <span>Branch</span>
              <ChevronDown size={14} />
            </button>
            {branchMenuOpen ? (
              <div className="review-branch-menu" role="menu">
                <label className="review-branch-search">
                  <Search size={13} />
                  <input
                    value={branchQuery}
                    onChange={event => setBranchQuery(event.target.value)}
                    placeholder="Buscar branches"
                    autoFocus
                  />
                </label>
                <div className="review-branch-menu-title">Branches locais</div>
                {branchInfo?.dirty ? (
                  <div className="review-branch-warning">
                    <AlertCircle size={13} />
                    <span>Há mudanças locais. Commit, stash ou descarte antes de trocar.</span>
                  </div>
                ) : null}
                <div className="review-branch-list">
                  {filteredBranches.map(branch => (
                    <button
                      key={branch.name}
                      type="button"
                      className="review-branch-option"
                      disabled={branch.current || switchingBranch === branch.name || branchInfo?.dirty}
                      onClick={() => handleSwitchBranch(branch.name)}
                      role="menuitem"
                    >
                      <GitBranch size={13} />
                      <span>{branch.name}</span>
                      {branch.current ? <Check size={14} /> : null}
                    </button>
                  ))}
                  {filteredBranches.length === 0 ? <div className="review-empty compact">Nenhuma branch encontrada.</div> : null}
                </div>
              </div>
            ) : null}
          </div>
          <div className="review-branch-copy">
            <span>{branchInfo?.currentBranch ?? 'sem branch'}</span>
            {branchInfo?.upstreamBranch ? <small>{branchInfo.upstreamBranch}</small> : null}
          </div>
          <span className="review-total add">+{totalAdditions}</span>
          <span className="review-total del">-{totalDeletions}</span>
        </div>
        {branchMessage ? <div className="review-branch-message">{branchMessage}</div> : null}
      </header>

      <div className="review-file-list">
        {files.length === 0 ? (
          <div className="review-empty">Nenhuma mudança neste branch.</div>
        ) : files.map(file => {
          const expanded = expandedPaths.has(file.path)
          const diffState = capabilities.canDiff ? diffs[diffCacheKey(file)] : { loading: false, diff: emptyDiff(file, 'Diff indisponível para esta pasta.') }
          return (
            <ReviewFileSection
              key={file.path}
              file={file}
              expanded={expanded}
              diffState={diffState}
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
        <div className="review-confirm-overlay" role="dialog" aria-modal="true">
          <div className="review-confirm">
            <h2>Descartar mudanças?</h2>
            <p>{confirmingFile.status === 'untracked'
              ? `O arquivo novo "${confirmingFile.path}" será removido do disco.`
              : `As mudanças staged e unstaged de "${confirmingFile.path}" serão descartadas.`}</p>
            <div className="review-confirm-actions">
              <button type="button" className="secondary-action" onClick={() => setConfirmingFile(undefined)}>Cancelar</button>
              <button type="button" className="primary-action danger" onClick={() => revert(confirmingFile)}>Descartar</button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  )
}

function ReviewFileSection({
  file,
  expanded,
  diffState,
  canOpenExternal,
  canRevert,
  onToggle,
  onOpenExternal,
  onRevert,
}: {
  file: WorkspaceChangeEntry
  expanded: boolean
  diffState?: DiffState
  canOpenExternal: boolean
  canRevert: boolean
  onToggle: () => void
  onOpenExternal: () => void
  onRevert: () => void
}) {
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

function ReviewDiffBody({ loading, diff }: { loading: boolean; diff?: FileDiff }) {
  if (loading) return <div className="review-empty compact">Carregando diff...</div>
  if (!diff) return <div className="review-empty compact">Selecione um arquivo.</div>
  if (diff.message) return <div className="review-empty compact">{diff.message}</div>
  if (diff.truncated) return <div className="review-empty compact">Diff muito grande para exibir.</div>
  if (diff.binary) return <div className="review-empty compact">Arquivo binário.</div>
  if (diff.hunks.length === 0) return <div className="review-empty compact">Nenhuma mudança.</div>

  return (
    <div className="review-body">
      {diff.hunks.map((hunk, hunkIndex) => (
        <section key={`${hunk.header}:${hunkIndex}`} className="review-hunk">
          <div className="review-hunk-header">{hunk.header}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div key={`${line.oldLine}:${line.newLine}:${lineIndex}`} className={`review-line ${line.kind}`}>
              <span className="review-line-number">{line.oldLine ?? ''}</span>
              <span className="review-line-number">{line.newLine ?? ''}</span>
              <span className="review-line-sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span>
              <span className="review-line-text">{line.text || ' '}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

function useResizeHandle(width: number, min: number, max: number, onSetWidth: (width: number) => void) {
  const widthRef = useRef(width)
  widthRef.current = width

  return useCallback((event: PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthRef.current

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      onSetWidth(Math.max(min, Math.min(max, startWidth + startX - moveEvent.clientX)))
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [max, min, onSetWidth])
}

function diffCacheKey(file: WorkspaceChangeEntry): string {
  return `${file.path}:${file.status ?? 'modified'}:${file.additions}:${file.deletions}`
}

function emptyDiff(file: WorkspaceChangeEntry, message: string): FileDiff {
  return {
    path: file.path,
    status: (file.status ?? 'modified') as FileDiffStatus,
    additions: 0,
    deletions: 0,
    binary: false,
    truncated: false,
    hunks: [],
    message,
  }
}

function statusLabel(status: WorkspaceChangeEntry['status']): string {
  if (status === 'added' || status === 'untracked') return 'novo'
  if (status === 'deleted') return 'apagado'
  return 'editado'
}
