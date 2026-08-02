/**
 * Alvo de uma seleção para anotação — função pura sobre DOM, testável em jsdom.
 *
 * A REGRA MORA AQUI, não na barra nem no botão: a seleção só vira candidata
 * quando está CONTIDA num segmento de mensagem do MODELO — um elemento com
 * [data-annotation-segment] (marcado na renderização do transcript).
 * Seleção em mensagem do USUÁRIO, em activity, em summary ou fora do
 * transcript retorna null e não produz barra nenhuma. Se a regra morasse só
 * no botão, alguém a contornaria.
 *
 * SUPRESSÃO DURANTE STREAMING (recusa deliberada, limite declarado): um
 * segmento sob [data-turn-streaming="true"] retorna null — a barra NÃO
 * aparece enquanto o turno corre. Re-ancorar contra um segmento que ainda
 * está mudando é complexidade sem valor agora; quando o turno termina, o
 * atributo sai e a seleção volta a ser candidata.
 *
 * SELEÇÃO CRUZANDO SEGMENTOS (decisão do Maestro): CLAMPA ao primeiro
 * segmento (o do anchor) e sinaliza `clamped: true` para o chamador avisar
 * o usuário. Não tentamos costurar dois segmentos numa âncora só — a âncora
 * é por segmento por contrato (segmentId único).
 */

/** Sobe do node até o segmento anotável mais próximo. null se não houver. */
export function findAnnotatableSegment(node: Node | null): Element | null {
  let current: Node | null = node
  while (current) {
    if (current instanceof Element && current.hasAttribute('data-annotation-segment')) {
      return current
    }
    current = current.parentNode ?? (current instanceof ShadowRoot ? current.host : null)
  }
  return null
}

/** Offset absoluto (unidades UTF-16) de (node, offset) dentro do textContent de root. */
export function textOffsetWithin(root: Element, node: Node, offset: number): number {
  const range = root.ownerDocument.createRange()
  range.selectNodeContents(root)
  try {
    range.setEnd(node, offset)
  } catch {
    // (node, offset) fora do root — não deveria acontecer: o chamador já
    // verificou contenção. Degrada para o fim do segmento, sem lançar.
    return root.textContent?.length ?? 0
  }
  return range.toString().length
}

export type SelectionTarget = {
  segmentEl: Element
  segmentId: string
  start: number
  end: number
  clamped: boolean
}

export function resolveSelectionTarget(
  anchorNode: Node | null,
  anchorOffset: number,
  focusNode: Node | null,
  focusOffset: number,
): SelectionTarget | null {
  const anchorSegment = findAnnotatableSegment(anchorNode)
  if (!anchorSegment || !anchorNode) return null

  // Streaming: recusa deliberada (ver comentário do módulo).
  if (anchorSegment.closest('[data-turn-streaming="true"]')) return null

  const segmentId = anchorSegment.getAttribute('data-annotation-segment')
  if (!segmentId) return null

  const segmentLength = anchorSegment.textContent?.length ?? 0
  const anchorAt = textOffsetWithin(anchorSegment, anchorNode, anchorOffset)

  const focusSegment = findAnnotatableSegment(focusNode)
  let start: number
  let end: number
  let clamped = false

  if (focusSegment === anchorSegment && focusNode) {
    const focusAt = textOffsetWithin(anchorSegment, focusNode, focusOffset)
    start = Math.min(anchorAt, focusAt)
    end = Math.max(anchorAt, focusAt)
  } else {
    // Cruzando segmentos ou saindo deles: clamp ao segmento do anchor.
    // Direção: se o foco está depois do anchor no documento (ou é desconhecido),
    // a seleção visual vai para a frente → do anchor até o FIM do segmento.
    clamped = true
    const forward = focusNode
      ? Boolean(anchorSegment.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_FOLLOWING)
      : true
    if (forward) {
      start = anchorAt
      end = segmentLength
    } else {
      start = 0
      end = anchorAt
    }
    if (start > end) [start, end] = [end, start]
  }

  if (end - start <= 0) return null // caret ou clamp degenerado: sem barra
  return { segmentEl: anchorSegment, segmentId, start, end, clamped }
}
