import { useCallback, useEffect, useRef, useState } from 'react'
import { ANNOTATION_QUOTE_MAX } from '../../../shared/types'
import type { Annotation } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { renderedTextFromTextContent } from './resolveAnnotationAnchor'
import { createAnnotation } from './createAnnotation'
import { useAnnotationSelection } from './useAnnotationSelection'

const COMPOSER_GAP = 8

/**
 * A barra flutuante de anotação (F1) e seu layer.
 *
 * AnnotationLayer é o componente que o App monta UMA vez: encapsula o
 * ouvinte de seleção e a barra, mantendo o estado efêmero da seleção FORA
 * do App (re-renders de selectionchange não atravessam o app inteiro). Ao
 * criar, a POSSE é fixada: a anotação entra na conversa recebida por prop
 * NESTE momento — trocar de conversa depois não a move nem a vaza.
 *
 * VALIDAÇÃO NO PONTO DE ENTRADA (exigência do QA): o texto que vira
 * RenderedText aqui vem do DOM — element.textContent, que é sempre string
 * (ou null, coberto pelo ?? ''). NADA de JSON/IPC alimenta este carimbo na
 * F1; se um dia vier, valide o tipo ANTES de chamar renderedTextFromTextContent,
 * porque `any` fura a marca nominal.
 */
export function AnnotationLayer({ conversationId, onCreate }: {
  conversationId: string | undefined
  onCreate: (annotation: Annotation) => void
}) {
  const { selection, dismiss, barRef } = useAnnotationSelection(Boolean(conversationId))

  // Trocou de conversa: a barra aberta morre com a conversa anterior (a
  // seleção some junto; e uma barra pendurada apontaria para um segmento
  // que saiu da tela).
  useEffect(() => dismiss(), [conversationId, dismiss])

  if (!selection || !conversationId) return null

  const handleAdd = (comment: string | null) => {
    const raw = selection.target.segmentEl.textContent
    const made = createAnnotation({
      segmentId: selection.target.segmentId,
      segmentText: renderedTextFromTextContent(typeof raw === 'string' ? raw : ''),
      start: selection.target.start,
      end: selection.target.end,
      comment,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    })
    if (made) onCreate(made.annotation)
    document.getSelection()?.removeAllRanges()
    dismiss()
    // Devolve o foco ao composer: a anotação vira contexto do próximo envio.
    window.dispatchEvent(new CustomEvent('verboo:focus-composer'))
  }

  return <AnnotationBar selection={selection} onAdd={handleAdd} onDismiss={dismiss} barRef={barRef} />
}

function AnnotationBar({ selection, onAdd, onDismiss, barRef }: {
  selection: NonNullable<ReturnType<typeof useAnnotationSelection>['selection']>
  onAdd: (comment: string | null) => void
  onDismiss: () => void
  barRef: React.RefObject<HTMLDivElement | null>
}) {
  const { t } = useI18n()
  const [comment, setComment] = useState('')
  const commentRef = useRef<HTMLTextAreaElement | null>(null)
  const willTruncate = selection.target.end - selection.target.start > ANNOTATION_QUOTE_MAX

  const resizeComment = useCallback((textarea = commentRef.current) => {
    if (!textarea) return
    textarea.style.height = '0px'
    const contentHeight = textarea.scrollHeight
    const barRect = barRef.current?.getBoundingClientRect()
    const textareaRect = textarea.getBoundingClientRect()
    // Regra da casa: seletor de outro componente exige pin contra o componente
    // de origem. annotationSendWiring.test.ts lê o Composer.tsx REAL; fixture
    // com a própria classe não conta como contrato.
    const composerRect = document.querySelector<HTMLElement>('.composer')?.getBoundingClientRect()
    const boundaryTop = composerRect?.top ?? window.innerHeight
    const barChromeHeight = barRect ? Math.max(0, barRect.height - textareaRect.height) : 0
    // O teto é relativo ao espaço que ainda existe acima do composer,
    // medido de novo a cada crescimento. Assim o texto vira scroll antes
    // de a barra alcançar o rodapé, independentemente da seleção.
    const maxHeight = barRect
      ? Math.max(0, boundaryTop - barRect.top - COMPOSER_GAP - barChromeHeight)
      : contentHeight
    textarea.style.maxHeight = `${maxHeight}px`
    textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`
    textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
  }, [barRef])

  useEffect(() => {
    const composer = document.querySelector<HTMLElement>('.composer')
    const onWindowResize = () => resizeComment()
    window.addEventListener('resize', onWindowResize)
    const composerObserver = composer && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => resizeComment())
      : null
    if (composer && composerObserver) composerObserver.observe(composer)
    return () => {
      window.removeEventListener('resize', onWindowResize)
      composerObserver?.disconnect()
    }
  }, [resizeComment])

  const submit = () => {
    const trimmed = comment.trim()
    onAdd(trimmed.length > 0 ? trimmed : null)
  }

  return (
    <div
      ref={barRef}
      className="annotation-bar"
      data-placement={selection.placement}
      style={{ top: selection.top, left: selection.left }}
      role="dialog"
      aria-label={t('annotations.addToChat')}
    >
      {(selection.target.clamped || willTruncate) && (
        <div className="annotation-bar-notices">
          {selection.target.clamped && <span className="annotation-bar-notice">{t('annotations.clampedNotice')}</span>}
          {willTruncate && <span className="annotation-bar-notice">{t('annotations.truncatedNotice')}</span>}
        </div>
      )}
      <div className="annotation-bar-row">
        <textarea
          ref={commentRef}
          className="annotation-bar-comment"
          rows={1}
          value={comment}
          placeholder={t('annotations.commentPlaceholder')}
          onChange={event => {
            setComment(event.target.value)
            resizeComment(event.currentTarget)
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') onDismiss()
          }}
        />
        <button type="button" className="annotation-bar-add" onClick={submit}>
          {t('annotations.addToChat')}
        </button>
      </div>
    </div>
  )
}
