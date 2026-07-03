import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, PanelRightClose, RotateCcw } from 'lucide-react'
import type { FileDiff } from '../../../shared/types'
import type { ReviewTarget } from './useReviewPanel'

type ReviewPanelProps = {
  open: boolean
  width: number
  target?: ReviewTarget
  onSetWidth: (width: number) => void
  onClose: () => void
  onNext: () => void
  onPrev: () => void
  onReverted: () => void
  minWidth: number
  maxWidth: number
}

export function ReviewPanel(props: ReviewPanelProps) {
  const { open, width, target, onSetWidth, onClose, onNext, onPrev, onReverted, minWidth, maxWidth } = props
  const [diff, setDiff] = useState<FileDiff | undefined>()
  const [loading, setLoading] = useState(false)
  const [confirmingRevert, setConfirmingRevert] = useState(false)
  const file = target ? target.files[target.index] : undefined
  const startResize = useResizeHandle(width, minWidth, maxWidth, onSetWidth)

  useEffect(() => {
    if (!open || !target || !file) {
      setDiff(undefined)
      return
    }

    let cancelled = false
    setLoading(true)
    setConfirmingRevert(false)
    window.verboo.getFileDiff(target.workingDirectory, file.path, file.status)
      .then(result => {
        if (!cancelled) setDiff(result)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, target?.workingDirectory, file?.path, file?.status])

  const revert = useCallback(async () => {
    if (!target || !file) return
    const result = await window.verboo.revertFile(target.workingDirectory, file.path)
    setConfirmingRevert(false)
    if (result.ok) onReverted()
  }, [target?.workingDirectory, file?.path, onReverted])

  const openExternal = useCallback(() => {
    if (target && file) void window.verboo.openExternalFile(target.workingDirectory, file.path)
  }, [target?.workingDirectory, file?.path])

  if (!open || !target || !file) return null

  return (
    <aside className="review-panel" style={{ width }} aria-label="Revisão de arquivo">
      <div className="review-resizer" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
      <header className="review-header">
        <div className="review-nav">
          <button type="button" onClick={onPrev} disabled={target.index === 0} aria-label="Arquivo anterior">
            <ChevronLeft size={15} />
          </button>
          <button type="button" onClick={onNext} disabled={target.index >= target.files.length - 1} aria-label="Próximo arquivo">
            <ChevronRight size={15} />
          </button>
          <span className="review-count">{target.index + 1}/{target.files.length}</span>
        </div>
        <strong className="review-filename" title={file.path}>{file.path}</strong>
        <button type="button" className="ui-tooltip" data-tooltip="Abrir no app padrão" onClick={openExternal} aria-label="Abrir no app padrão">
          <ExternalLink size={15} />
        </button>
        <button type="button" className="ui-tooltip" data-tooltip="Descartar mudanças" onClick={() => setConfirmingRevert(true)} aria-label="Descartar mudanças">
          <RotateCcw size={15} />
        </button>
        <button type="button" onClick={onClose} aria-label="Fechar revisão">
          <PanelRightClose size={16} />
        </button>
      </header>
      <ReviewDiffBody loading={loading} diff={diff} />
      {confirmingRevert ? (
        <div className="review-confirm-overlay" role="dialog" aria-modal="true">
          <div className="review-confirm">
            <h2>Descartar mudanças?</h2>
            <p>{file.status === 'untracked'
              ? `O arquivo novo "${file.path}" será removido do disco.`
              : `As mudanças staged e unstaged de "${file.path}" serão descartadas.`}</p>
            <div className="review-confirm-actions">
              <button type="button" className="secondary-action" onClick={() => setConfirmingRevert(false)}>Cancelar</button>
              <button type="button" className="primary-action danger" onClick={revert}>Descartar</button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  )
}

function ReviewDiffBody({ loading, diff }: { loading: boolean; diff?: FileDiff }) {
  if (loading) return <div className="review-empty">Carregando diff...</div>
  if (!diff) return <div className="review-empty">Selecione um arquivo.</div>
  if (diff.message) return <div className="review-empty">{diff.message}</div>
  if (diff.truncated) return <div className="review-empty">Diff muito grande para exibir.</div>
  if (diff.binary) return <div className="review-empty">Arquivo binário.</div>
  if (diff.hunks.length === 0) return <div className="review-empty">Nenhuma mudança.</div>

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

  return useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthRef.current

    const onMove = (moveEvent: PointerEvent) => {
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
