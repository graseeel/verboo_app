import type { BarRect } from './annotationBarPosition'

/**
 * Retângulos do overlay de anotações (F2) — as duas funções que sustentam
 * as REGRAS DA FASE:
 *
 * REGRA 1 (não mutar o DOM do MarkdownMessage): o destaque é desenhado POR
 * CIMA, a partir de range.getClientRects(). domRangeForTextOffsets apenas
 * POSICIONA uma Range — objeto leve que não altera o DOM — sobre os pontos
 * corretos, cruzando elementos inline (<strong>, <code>, <a>) que o
 * markdown renderizado contém. Nada aqui insere, remove ou edita nó.
 *
 * REGRA 2 (o balão NÃO COME LETRA): resolveBalloonPosition testa os
 * candidatos EM ORDEM contra TODOS os retângulos da seleção e rejeita
 * qualquer um que intersecte — a garantia é por construção, não por
 * cuidado. No Codex o balão sobrepõe e engole os últimos caracteres
 * ('alvo.' → 'alv1'); aqui o candidato primário fica DEPOIS do fim, com
 * folga. Limite declarado: se TODO candidato intersectar (seleção cobrindo
 * a tela — patológico), devolve 'clamped' na posição preferida limitada à
 * viewport; o caso é impossível na prática (balão de 18px) e, se ocorrer,
 * cobre texto — declarado, não escondido.
 */

export const BALLOON_SIZE = 18
export const BALLOON_GAP = 6
const VIEWPORT_GAP = 8

/**
 * Mapeia offsets do espaço textContent (unidades UTF-16, o mesmo espaço do
 * resolvedor F0) para pontos DOM reais. null quando não cobre — degradação,
 * nunca exceção.
 */
export function domRangeForTextOffsets(root: Element, start: number, end: number): Range | null {
  if (start < 0 || end <= start) return null
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)

  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0
  let accumulated = 0

  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const nodeStart = accumulated
    const nodeEnd = accumulated + node.data.length
    if (startNode === null && start >= nodeStart && start < nodeEnd) {
      startNode = node
      startOffset = start - nodeStart
    }
    if (endNode === null && end > nodeStart && end <= nodeEnd) {
      endNode = node
      endOffset = end - nodeStart
    }
    accumulated = nodeEnd
    if (startNode && endNode) break
  }

  if (!startNode || !endNode) return null
  const range = doc.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

/** Retângulos de fragmento da Range como dados simples; fragmentos de área
 *  zero (artefato de quebra inline) são descartados — não pintam nada. */
export function collectHighlightRects(range: Range): BarRect[] {
  return Array.from(range.getClientRects())
    .map(r => ({ top: r.top, left: r.left, width: r.width, height: r.height }))
    .filter(r => r.width > 0 && r.height > 0)
}

function intersects(a: BarRect, b: BarRect): boolean {
  return !(
    a.left + a.width <= b.left ||
    b.left + b.width <= a.left ||
    a.top + a.height <= b.top ||
    b.top + b.height <= a.top
  )
}

export type BalloonPlacement = 'after-end' | 'above-end' | 'clamped'

export function resolveBalloonPosition(params: {
  selectionRects: readonly BarRect[]
  viewport: { width: number; height: number }
}): { top: number; left: number; placement: BalloonPlacement } {
  const { selectionRects, viewport } = params
  const last = selectionRects[selectionRects.length - 1]

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(max, min))

  if (!last) {
    return { top: VIEWPORT_GAP, left: VIEWPORT_GAP, placement: 'clamped' }
  }

  const hitsSelection = (rect: BarRect) => selectionRects.some(r => intersects(rect, r))

  // Candidato 1 — DEPOIS do fim, com folga, centrado na última linha.
  const afterEnd: BarRect = {
    top: last.top + last.height / 2 - BALLOON_SIZE / 2,
    left: last.left + last.width + BALLOON_GAP,
    width: BALLOON_SIZE,
    height: BALLOON_SIZE,
  }
  if (afterEnd.left + BALLOON_SIZE <= viewport.width - VIEWPORT_GAP && !hitsSelection(afterEnd)) {
    return { top: afterEnd.top, left: afterEnd.left, placement: 'after-end' }
  }

  // Candidato 2 — ACIMA do fim, alinhado à direita do trecho.
  const aboveEnd: BarRect = {
    top: last.top - BALLOON_SIZE - BALLOON_GAP,
    left: clamp(last.left + last.width - BALLOON_SIZE, VIEWPORT_GAP, viewport.width - BALLOON_SIZE - VIEWPORT_GAP),
    width: BALLOON_SIZE,
    height: BALLOON_SIZE,
  }
  if (aboveEnd.top >= VIEWPORT_GAP && !hitsSelection(aboveEnd)) {
    return { top: aboveEnd.top, left: aboveEnd.left, placement: 'above-end' }
  }

  // Patológico (ver cabeçalho): preferida, clampada à viewport. DECLARADO.
  return {
    top: clamp(afterEnd.top, VIEWPORT_GAP, viewport.height - BALLOON_SIZE - VIEWPORT_GAP),
    left: clamp(afterEnd.left, VIEWPORT_GAP, viewport.width - BALLOON_SIZE - VIEWPORT_GAP),
    placement: 'clamped',
  }
}
