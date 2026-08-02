import type { Annotation, TranscriptItem } from '../../../shared/types'

export function annotationTurnItemId(annotationIds: readonly string[]): string {
  return `annotation:${annotationIds.join(':')}`
}

/**
 * O item de transcript da anotação enviada (F3, N3) — "o chip vira turno".
 *
 * AUTOCONTIDO: os pares quote+comment são CONGELADOS dentro do item no
 * instante do envio. "Consultável para sempre" não pode depender de
 * re-ancorar contra o transcript — o trecho pode ser editado, compactado
 * ou o segmento pode sumir; o item continua legível.
 *
 * DEGRADAÇÃO PARA BUILD ANTIGO: `text` carrega uma renderização LEGÍVEL dos
 * mesmos pares. Um app de versão antiga, que não conhece kind 'annotation',
 * renderiza o item como mensagem de usuário comum mostrando esse texto —
 * degrada para conteúdo, nunca para quebra nem para item invisível. O app
 * novo ignora o fallback e renderiza o cartão dedicado a partir de
 * annotationEntries. (A sanitizer do store não filtra por kind — o item
 * atravessa versões intacto.)
 *
 * O fallback é montado com os rótulos da locale ATIVA no instante do envio
 * (o texto persistido não re-localiza depois — mesmo comportamento do resto
 * do store, que persiste strings da sessão).
 */
export function buildAnnotationTurnItem(
  annotations: readonly Annotation[],
  labels: { quoteLabel: string; commentLabel: string },
  id: string,
  timestamp: number,
): TranscriptItem {
  const fallbackLines: string[] = []
  for (const [index, annotation] of annotations.entries()) {
    fallbackLines.push(`${index + 1}. ${labels.quoteLabel}: "${annotation.quote}"`)
    if (annotation.comment) fallbackLines.push(`   ${labels.commentLabel}: "${annotation.comment}"`)
  }

  return {
    id,
    role: 'user',
    kind: 'annotation',
    text: fallbackLines.join('\n'),
    annotationEntries: annotations.map(a => ({ quote: a.quote, comment: a.comment })),
    timestamp,
  }
}

export function insertAnnotationTurnBeforeResponse(
  items: TranscriptItem[],
  annotationItem: TranscriptItem,
  turnId: string,
): TranscriptItem[] {
  if (items.some(item => item.id === annotationItem.id)) return items

  const firstResponseIndex = items.findIndex(item =>
    item.id === turnId || item.id.startsWith(`${turnId}:`),
  )
  if (firstResponseIndex === -1) return [...items, annotationItem]

  return [
    ...items.slice(0, firstResponseIndex),
    annotationItem,
    ...items.slice(firstResponseIndex),
  ]
}
