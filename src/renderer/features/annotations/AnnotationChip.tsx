import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquareQuote, Pencil, X } from 'lucide-react'
import type { Annotation } from '../../../shared/types'
import { ANNOTATION_QUOTE_MAX } from '../../../shared/types'
import { useI18n } from '../../i18n'

const HOVER_CLOSE_GRACE_MS = 120
const HOVER_BRIDGE_GAP = 6
const PANEL_WIDTH = 320
const PANEL_VIEWPORT_GAP = 8

/**
 * Chip das anotações no composer + painel (F1).
 *
 * O painel abre no hover e também por clique (toque/teclado não têm hover —
 * o app roda em três sistemas e um deles pode ser touch). Escape ou
 * pointerdown fora fecha. Edição de comentário mantém o painel aberto.
 *
 * TRUNCAMENTO VISÍVEL (convenção F0): um quote no teto com suffix vazio é
 * exibido com reticências. Limite declarado da derivação: uma seleção de
 * EXATAMENTE 2000 chars terminando no fim do segmento dá falso positivo —
 * raro, e só afeta a reticência, nunca o dado.
 *
 * Rótulos: o painel mostra 'Comentário do usuário' SÓ quando há comentário —
 * sem rótulo órfão pendurado em item sem comentário.
 */
export function isTruncatedAnnotation(annotation: Annotation): boolean {
  return annotation.quote.length >= ANNOTATION_QUOTE_MAX && annotation.suffix === ''
}

export function AnnotationChip({ annotations, onRemove, onEditComment }: {
  annotations: Annotation[]
  onRemove: (annotationId: string) => void
  onEditComment: (annotationId: string, comment: string | null) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const bridgeRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const focusFirstActionOnOpenRef = useRef(false)

  const cancelScheduledClose = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }
  const closePanel = () => {
    cancelScheduledClose()
    focusFirstActionOnOpenRef.current = false
    setOpen(false)
    setEditingId(null)
  }
  const keepPanelOpen = () => {
    cancelScheduledClose()
    // Hover previews without stealing keyboard focus. Only activation of the
    // chip requests focus inside the portaled panel.
    focusFirstActionOnOpenRef.current = false
    setOpen(true)
  }
  const scheduleClose = () => {
    if (editingId) return
    cancelScheduledClose()
    closeTimerRef.current = setTimeout(closePanel, HOVER_CLOSE_GRACE_MS)
  }

  useEffect(() => {
    if (!open) {
      cancelScheduledClose()
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      const insideWrap = Boolean(wrapRef.current && target instanceof Node && wrapRef.current.contains(target))
      const insidePanel = Boolean(panelRef.current && target instanceof Node && panelRef.current.contains(target))
      if (!insideWrap && !insidePanel) {
        closePanel()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelScheduledClose()
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open || !focusFirstActionOnOpenRef.current) return
    focusFirstActionOnOpenRef.current = false
    panelRef.current?.querySelector<HTMLButtonElement>('.annotation-panel-action')?.focus()
  }, [open])

  if (annotations.length === 0) return null

  const startEdit = (annotation: Annotation) => {
    setEditingId(annotation.id)
    setEditText(annotation.comment ?? '')
    setOpen(true)
  }
  const saveEdit = () => {
    if (editingId) onEditComment(editingId, editText.trim().length > 0 ? editText.trim() : null)
    setEditingId(null)
  }
  const anchorRect = open ? wrapRef.current?.getBoundingClientRect() : undefined
  const panelWidth = Math.min(PANEL_WIDTH, window.innerWidth - PANEL_VIEWPORT_GAP * 2)
  const panelLeft = anchorRect
    ? Math.max(PANEL_VIEWPORT_GAP, Math.min(anchorRect.left, window.innerWidth - panelWidth - PANEL_VIEWPORT_GAP))
    : undefined
  const panelStyle = anchorRect ? {
    bottom: window.innerHeight - anchorRect.top + HOVER_BRIDGE_GAP,
    left: panelLeft,
  } : undefined
  const bridgeStyle = anchorRect && panelLeft !== undefined ? {
    top: anchorRect.top - HOVER_BRIDGE_GAP,
    left: Math.min(anchorRect.left, panelLeft),
    width: Math.max(anchorRect.right, panelLeft + panelWidth) - Math.min(anchorRect.left, panelLeft),
    height: HOVER_BRIDGE_GAP,
  } : undefined

  return (
    <div
      ref={wrapRef}
      className="annotation-chip-wrap"
      onMouseEnter={keepPanelOpen}
      onMouseLeave={event => {
        if (editingId) return
        if (panelRef.current && event.relatedTarget instanceof Node && panelRef.current.contains(event.relatedTarget)) return
        if (bridgeRef.current && event.relatedTarget instanceof Node && bridgeRef.current.contains(event.relatedTarget)) return
        scheduleClose()
      }}
      onFocusCapture={cancelScheduledClose}
    >
      <button
        type="button"
        className="skill-chip attachment-chip annotation-chip"
        onClick={() => {
          cancelScheduledClose()
          setOpen(current => {
            const next = !current
            focusFirstActionOnOpenRef.current = next
            return next
          })
        }}
        aria-expanded={open}
        title={t('annotations.chipTitle')}
      >
        <MessageSquareQuote size={12} aria-hidden="true" />
        <span>
          {annotations.length === 1
            ? t('annotations.chipOne', { count: annotations.length })
            : t('annotations.chipMany', { count: annotations.length })}
        </span>
      </button>

      {open && createPortal(
        <>
          <div
            ref={bridgeRef}
            className="annotation-chip-hover-bridge"
            style={bridgeStyle}
            aria-hidden="true"
            onMouseEnter={keepPanelOpen}
            onMouseLeave={event => {
              if (editingId) return
              if (wrapRef.current && event.relatedTarget instanceof Node && wrapRef.current.contains(event.relatedTarget)) return
              if (panelRef.current && event.relatedTarget instanceof Node && panelRef.current.contains(event.relatedTarget)) return
              scheduleClose()
            }}
          />
          <div
            ref={panelRef}
            className="annotation-chip-panel"
            role="dialog"
            aria-label={t('annotations.chipTitle')}
            style={panelStyle}
            onMouseEnter={keepPanelOpen}
            onMouseLeave={event => {
              if (editingId) return
              if (wrapRef.current && event.relatedTarget instanceof Node && wrapRef.current.contains(event.relatedTarget)) return
              if (bridgeRef.current && event.relatedTarget instanceof Node && bridgeRef.current.contains(event.relatedTarget)) return
              scheduleClose()
            }}
            onFocusCapture={cancelScheduledClose}
          >
          {annotations.map((annotation, index) => (
            <div key={annotation.id} className="annotation-panel-item">
              <div className="annotation-panel-head">
                <span className="annotation-panel-index">{index + 1}</span>
                <span className="annotation-panel-actions">
                  <button
                    type="button"
                    className="annotation-panel-action"
                    title={t('annotations.editComment')}
                    onClick={() => startEdit(annotation)}
                  >
                    <Pencil size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="annotation-panel-action"
                    title={t('annotations.remove')}
                    onClick={() => onRemove(annotation.id)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              </div>
              <div className="annotation-panel-quote">
                <span className="annotation-panel-label">{t('annotations.quoteLabel')}</span>
                <span className="annotation-panel-text">
                  “{annotation.quote}{isTruncatedAnnotation(annotation) ? '…' : ''}”
                </span>
              </div>
              {editingId === annotation.id ? (
                <input
                  className="annotation-panel-edit"
                  value={editText}
                  placeholder={t('annotations.commentPlaceholder')}
                  autoFocus
                  onChange={event => setEditText(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') saveEdit()
                    if (event.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={saveEdit}
                />
              ) : annotation.comment ? (
                <div className="annotation-panel-comment">
                  <span className="annotation-panel-label">{t('annotations.commentLabel')}</span>
                  <span className="annotation-panel-text">“{annotation.comment}”</span>
                </div>
              ) : null}
            </div>
          ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}
