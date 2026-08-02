import type { Annotation } from '../../../shared/types'
import { ANNOTATION_QUOTE_MAX, ANNOTATION_CONTEXT_MAX } from '../../../shared/types'
import type { RenderedText } from './resolveAnnotationAnchor'

/**
 * Cria a âncora de uma anotação a partir da seleção do usuário.
 *
 * ESPAÇO DE COORDENADAS: `segmentText` é RenderedText — o textContent do
 * segmento renderizado, nunca a fonte markdown (a marca nominal impede o
 * erro acidental). `start`/`end` são os offsets da seleção DENTRO desse
 * textContent, em unidades UTF-16 — o mesmo espaço que o resolvedor consome,
 * então criação e resolução concordam por construção (há teste de round-trip
 * pinnando isso, inclusive com ocorrências repetidas e sobrepostas).
 *
 * occurrenceIndex conta as ocorrências de quote que COMEÇAM antes de `start`,
 * com passo de +1 — o mesmo passo do resolvedor, para que ocorrências
 * sobrepostas (ex.: "aa" em "aaa") contem igual nos dois lados.
 *
 * TRUNCAGEM (teto de ANNOTATION_QUOTE_MAX = 2000 unidades UTF-16), feita
 * AQUI na criação, como mandado: o Rust tem um teto defensivo de 6144 bytes
 * derivado deste número que NUNCA deve ser alcançado se truncarmos direito.
 * Marcação do truncamento (convenção da F0, sem campo novo no contrato):
 * ao truncar, `suffix` é gravado como '' — o suffix real do trecho completo
 * não é vizinho do quote truncado, logo não teria poder de desempate. O
 * chamador deve sinalizar o truncamento ao usuário (o retorno `truncated`
 * existe para isso) — truncar em silêncio seria a classe de defeito que
 * este projeto passou um ciclo eliminando.
 */
export function createAnnotation(params: {
  segmentId: string
  segmentText: RenderedText
  start: number
  end: number
  comment: string | null
  id: string
  createdAt: number
}): { annotation: Annotation; truncated: boolean } | null {
  const { segmentId, segmentText, start, end, comment, id, createdAt } = params
  if (start < 0 || end > segmentText.length || end <= start) return null

  const fullQuote = segmentText.slice(start, end)
  const truncated = fullQuote.length > ANNOTATION_QUOTE_MAX
  const quote = truncated ? fullQuote.slice(0, ANNOTATION_QUOTE_MAX) : fullQuote

  const prefix = segmentText.slice(Math.max(0, start - ANNOTATION_CONTEXT_MAX), start)
  const suffix = truncated ? '' : segmentText.slice(end, end + ANNOTATION_CONTEXT_MAX)

  // occurrenceIndex: quantas ocorrências do quote (passo +1, sobrepostas
  // inclusas — igual ao resolvedor) começam antes de `start`.
  let occurrenceIndex = 0
  let from = 0
  for (;;) {
    const at = segmentText.indexOf(quote, from)
    if (at === -1 || at >= start) break
    occurrenceIndex++
    from = at + 1
  }

  return {
    annotation: {
      id,
      segmentId,
      quote,
      prefix,
      suffix,
      occurrenceIndex,
      comment: comment && comment.trim().length > 0 ? comment.trim() : null,
      createdAt,
    },
    truncated,
  }
}
