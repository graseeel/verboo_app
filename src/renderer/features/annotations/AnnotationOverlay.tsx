import { useEffect, useState } from 'react'
import type { Annotation } from '../../../shared/types'
import { renderedTextFromTextContent, resolveAnnotationAnchor } from './resolveAnnotationAnchor'
import { collectHighlightRects, domRangeForTextOffsets, resolveBalloonPosition, type BalloonPlacement } from './annotationRects'
import type { BarRect } from './annotationBarPosition'

/**
 * O overlay da F2: destaque do trecho anotado + balão numerado, desenhados
 * POR CIMA do texto, NUNCA dentro dele.
 *
 * REGRA 1 — NÃO MUTAR O DOM DO MarkdownMessage. Este componente é IRMÃO do
 * transcript na árvore do App: o React que re-renderiza o streaming NUNCA
 * reconcilia este layer (N1 estrutural), e o textContent do segmento fica
 * byte-idêntico (testado). Toda posição vem de Range.getClientRects() —
 * leitura, não escrita.
 *
 * ACOMPANHAMENTO: scroll (capture — scroll não borbulha), resize e
 * MutationObserver no PAI de cada segmento envolvido (o pai sobrevive à
 * substituição do nó do segmento num re-render de streaming; observar o
 * segmento direto morreria junto com ele). Qualquer um dos três dispara
 * re-cálculo completo: resolver âncora → offsets → Range → retângulos.
 *
 * DEGRADAÇÃO (contrato F0): âncora que não resolve, segmento ausente ou
 * range impossível → a anotação simplesmente não entra em `visuals`. Perde
 * o visual, mantém o dado — a lista (chip) não consulta este componente.
 *
 * pointer-events: none INLINE (não só CSS): o layer não pode comer clique,
 * seleção ou copiar/colar — R1 vale para o overlay também.
 *
 * REDUCED MOTION: a classe de entrada é omitida quando a media query casa
 * (leitura por render, o mesmo padrão do ChecklistPanel), e o CSS zera a
 * animação em cinto-e-suspensórios.
 */

type ResolvedVisual = {
  id: string
  index: number
  rects: BarRect[]
  balloon: { top: number; left: number; placement: BalloonPlacement }
}

// Mesmo padrão guardado do ChecklistPanel (livePrefersReducedMotion):
// window.matchMedia pode ser undefined em jsdom e em WebViews antigos.
function livePrefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

export function AnnotationOverlay({ annotations, conversationId }: {
  annotations: readonly Annotation[]
  conversationId: string | undefined
}) {
  const [visuals, setVisuals] = useState<ResolvedVisual[]>([])
  const reducedMotion = livePrefersReducedMotion()

  useEffect(() => {
    if (!conversationId || annotations.length === 0) {
      setVisuals([])
      return
    }
    let cancelled = false

    const findSegment = (segmentId: string): Element | null =>
      document.querySelector(`[data-annotation-segment="${CSS.escape(segmentId)}"]`)

    const compute = () => {
      const next: ResolvedVisual[] = []
      annotations.forEach((annotation, index) => {
        const el = findSegment(annotation.segmentId)
        if (!el) return // degradação: sem visual, dado intacto
        const resolved = resolveAnnotationAnchor(renderedTextFromTextContent(el.textContent ?? ''), annotation)
        if (!resolved) return
        const range = domRangeForTextOffsets(el, resolved.start, resolved.end)
        if (!range) return
        const rects = collectHighlightRects(range)
        if (rects.length === 0) return
        const balloon = resolveBalloonPosition({
          selectionRects: rects,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        })
        next.push({ id: annotation.id, index, rects, balloon })
      })
      if (!cancelled) setVisuals(next)
    }

    compute()

    const onScrollOrResize = () => compute()
    document.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)

    // Streaming: observa o PAI de cada segmento (ver cabeçalho).
    const observer = new MutationObserver(compute)
    const watched = new Set<Element>()
    for (const annotation of annotations) {
      const el = findSegment(annotation.segmentId)
      const watchTarget = el?.parentElement ?? el
      if (watchTarget && !watched.has(watchTarget)) {
        watched.add(watchTarget)
        observer.observe(watchTarget, { childList: true, characterData: true, subtree: true })
      }
    }

    return () => {
      cancelled = true
      document.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
      observer.disconnect()
    }
  }, [annotations, conversationId])

  if (!conversationId || visuals.length === 0) return null

  const enterClass = reducedMotion ? '' : ' annotation-hl-enter'

  return (
    <div className="annotation-overlay" style={{ pointerEvents: 'none' }} aria-hidden="true">
      {visuals.map(visual => (
        <span key={visual.id}>
          {visual.rects.map((rect, rectIndex) => (
            <span
              key={rectIndex}
              className={`annotation-hl${enterClass}`}
              style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
            />
          ))}
          <span
            className={`annotation-balloon${enterClass}`}
            data-placement={visual.balloon.placement}
            style={{ top: visual.balloon.top, left: visual.balloon.left }}
          >
            {visual.index + 1}
          </span>
        </span>
      ))}
    </div>
  )
}
