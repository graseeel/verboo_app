import type { Annotation } from '../../../shared/types'

// --- RenderedText: o espaço de coordenadas é IMPOSTO POR TIPO, não por comentário
//
// REGRA CRÍTICA DE ESPAÇO DE COORDENADAS: o resolvedor opera sobre o TEXTO
// RENDERIZADO (textContent), NUNCA o markdown-fonte. A seleção do usuário
// acontece no DOM renderizado; âncora na fonte NUNCA casa com seleção do
// renderizado — trecho com negrito, código ou link morreria no nascimento,
// porque o textContent não contém os marcadores (`**`, crases, `](url)`).
//
// Esta regra já foi só comentário e o QA reprovou: comentário não impede
// ninguém. Agora ela É o tipo do parâmetro — RenderedText é uma marca
// nominal que só nasce via renderedTextFromTextContent, e passar uma string
// qualquer (ex.: a fonte markdown) NÃO COMPILA. A marca não é prova
// criptográfica: quem fizer `as RenderedText` de propósito fura. O que ela
// elimina é o erro ACIDENTAL — que é o que nos queimaria na F1.
declare const RENDERED_TEXT_BRAND: unique symbol
export type RenderedText = string & { readonly [RENDERED_TEXT_BRAND]: 'rendered-text-content' }

/** ÚNICO ponto de carimbo: chame com element.textContent (o texto RENDERIZADO). NUNCA com a fonte markdown. */
export function renderedTextFromTextContent(textContent: string): RenderedText {
  return textContent as RenderedText
}

/**
 * Resolve a âncora de uma anotação contra o TEXTO RENDERIZADO do segmento.
 * O parâmetro é RenderedText: a regra de espaço de coordenadas acima é
 * imposta pelo tipo — markdown-fonte simplesmente não compila aqui.
 *
 * Os índices devolvidos são unidades UTF-16 — o mesmo espaço de string do JS,
 * de textContent e de DOM Range. Emoji e caracteres fora do plano básico
 * contam 2 unidades; como quote/prefix/suffix foram capturados no mesmo
 * espaço na criação, indexOf casa de forma consistente.
 *
 * Estratégia, da evidência mais forte para a mais fraca:
 * 1. quote ou text vazios → null.
 * 2. Uma única ocorrência de quote → é ela (contexto não é necessário).
 * 3. Várias ocorrências: o contexto VERBATIM (prefix/suffix, os presentes)
 *    que casa EXATAMENTE uma ocorrência vence — a posição ordinal quebra com
 *    qualquer edição anterior no texto, o contexto só quebra se editarem a
 *    vizinhança do trecho.
 * 4. Sem decisão por contexto (empate ou ausência): occurrenceIndex em faixa.
 * 5. Nada decide → null. null NÃO é erro: é a degradação esperada do desenho
 *    — significa "perde o visual, mantém o dado". A anotação continua
 *    existindo como registro; só o destaque renderizado é que se perde.
 *
 * Quote truncado (ver ANNOTATION_QUOTE_MAX em shared/types.ts): não exige
 * lógica especial — o quote truncado é prefixo do trecho original no texto,
 * então indexOf ainda o encontra; a criação grava suffix === '' nesse caso,
 * e a desambiguação segue por prefix + occurrenceIndex.
 */
export function resolveAnnotationAnchor(
  text: RenderedText,
  anchor: Pick<Annotation, 'quote' | 'prefix' | 'suffix' | 'occurrenceIndex'>,
): { start: number; end: number } | null {
  const { quote, prefix, suffix, occurrenceIndex } = anchor
  if (text.length === 0 || quote.length === 0) return null

  const occurrences: number[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf(quote, from)
    if (at === -1) break
    occurrences.push(at)
    from = at + 1 // +1: ocorrências sobrepostas também contam (ex.: "aa" em "aaa")
  }

  if (occurrences.length === 0) return null
  if (occurrences.length === 1) return { start: occurrences[0], end: occurrences[0] + quote.length }

  const matchesContext = (start: number): boolean => {
    if (prefix.length > 0 && text.slice(Math.max(0, start - prefix.length), start) !== prefix) return false
    const end = start + quote.length
    if (suffix.length > 0 && text.slice(end, end + suffix.length) !== suffix) return false
    return true
  }
  const contextMatches = occurrences.filter(matchesContext)
  if (contextMatches.length === 1) {
    return { start: contextMatches[0], end: contextMatches[0] + quote.length }
  }

  if (occurrenceIndex >= 0 && occurrenceIndex < occurrences.length) {
    return { start: occurrences[occurrenceIndex], end: occurrences[occurrenceIndex] + quote.length }
  }

  return null
}
