import { describe, it, expect } from 'vitest'
import { resolveAnnotationAnchor, renderedTextFromTextContent } from './resolveAnnotationAnchor'
import { ANNOTATION_QUOTE_MAX } from '../../../shared/types'

// As fixtures destes testes SÃO textContent simulado, então o carimbo é
// honesto — e obrigatório: o parâmetro é RenderedText, string crua não compila.
const rt = renderedTextFromTextContent

type AnchorInput = Parameters<typeof resolveAnnotationAnchor>[1]

const anchor = (overrides: Partial<AnchorInput> = {}): AnchorInput => ({
  quote: 'trecho',
  prefix: '',
  suffix: '',
  occurrenceIndex: 0,
  ...overrides,
})

describe('resolveAnnotationAnchor — matriz por efeito', () => {
  it('ocorrência única → intervalo certo, e o intervalo fatia de volta o quote', () => {
    const text = 'O modelo respondeu este trecho aqui no meio.'
    const found = resolveAnnotationAnchor(rt(text), anchor())
    expect(found).toEqual({ start: 24, end: 30 })
    expect(text.slice(found!.start, found!.end)).toBe('trecho')
  })

  it('ocorrência REPETIDA com occurrenceIndex 1 → a SEGUNDA instância, não a primeira', () => {
    const text = 'trecho e outro trecho'
    const found = resolveAnnotationAnchor(rt(text), anchor({ occurrenceIndex: 1 }))
    expect(found).toEqual({ start: 15, end: 21 })
    expect(text.slice(found!.start, found!.end)).toBe('trecho')
  })

  it('CONTRAFACTUAL: mesmo texto com occurrenceIndex 0 → a PRIMEIRA instância (a única variável é o índice)', () => {
    const found = resolveAnnotationAnchor(rt('trecho e outro trecho'), anchor({ occurrenceIndex: 0 }))
    expect(found).toEqual({ start: 0, end: 6 })
  })

  it('texto que MUDOU e não contém mais o quote → null, sem lançar', () => {
    expect(() => {
      const found = resolveAnnotationAnchor(rt('o modelo editou tudo depois'), anchor())
      expect(found).toBeNull()
    }).not.toThrow()
  })

  it('quote com acento, emoji e caractere fora do plano básico → índice UTF-16 correto', () => {
    // '🚀' conta 2 unidades UTF-16; '𝒳' (U+1D4B3, astral) também. O contrato de
    // coordenadas é o de textContent/DOM Range: unidades UTF-16, não code points.
    const text = '🚀🚀 açúcar 𝒳 fim'
    const quote = 'açúcar 𝒳'
    const found = resolveAnnotationAnchor(rt(text), anchor({ quote }))
    expect(found).toEqual({ start: 5, end: 5 + quote.length }) // 2+2+1 = 5; quote.length = 9
    expect(text.slice(found!.start, found!.end)).toBe(quote)
  })

  it('prefix/suffix desempatam duas ocorrências idênticas — a única variável entre os dois é o prefix', () => {
    const text = 'AA trecho BB e depois CC trecho DD'
    // occurrenceIndex 0 nos DOIS: sem contexto, o índice devolveria a primeira.
    const first = resolveAnnotationAnchor(rt(text), anchor({ prefix: 'AA ', suffix: ' BB' }))
    expect(first).toEqual({ start: 3, end: 9 })
    const second = resolveAnnotationAnchor(rt(text), anchor({ prefix: 'CC ', suffix: ' DD' }))
    expect(second).toEqual({ start: 25, end: 31 })
    expect(text.slice(second!.start, second!.end)).toBe('trecho')
  })

  it('índice FORA DE FAIXA (texto perdeu ocorrências) com contexto único → resolve pelo contexto', () => {
    // "Quando o índice não basta": a âncora foi criada como occurrenceIndex 2,
    // mas o texto agora só tem 2 ocorrências — o índice não basta, o contexto decide.
    const text = 'AA trecho BB e depois CC trecho DD'
    const found = resolveAnnotationAnchor(rt(text), anchor({ prefix: 'CC ', suffix: ' DD', occurrenceIndex: 2 }))
    expect(found).toEqual({ start: 25, end: 31 })
  })

  it('texto vazio e quote vazio → null, sem lançar', () => {
    expect(resolveAnnotationAnchor(rt(''), anchor())).toBeNull()
    expect(resolveAnnotationAnchor(rt('texto qualquer'), anchor({ quote: '' }))).toBeNull()
    expect(resolveAnnotationAnchor(rt(''), anchor({ quote: '' }))).toBeNull()
  })

  it('quote TRUNCADO na criação (teto de 2000, suffix vazio) → resolve por prefix', () => {
    // Forma do truncamento real: o quote gravado é prefixo do trecho original.
    // As ocorrências se sobrepõem (2000 'a's dentro de 2500) e o occurrenceIndex
    // não diria nada — o prefix 'inicio ' casa exatamente a posição real.
    const text = `inicio ${'a'.repeat(2500)} fim`
    const quote = 'a'.repeat(ANNOTATION_QUOTE_MAX)
    const found = resolveAnnotationAnchor(rt(text), anchor({ quote, prefix: 'inicio ', suffix: '', occurrenceIndex: 0 }))
    expect(found).toEqual({ start: 7, end: 7 + ANNOTATION_QUOTE_MAX })
    expect(text.slice(found!.start, found!.end)).toBe(quote)
  })

  it('contexto EMPATADO (prefix e suffix repetidos) → cai no occurrenceIndex, limite declarado', () => {
    const text = 'X trecho Y e X trecho Y'
    const found = resolveAnnotationAnchor(rt(text), anchor({ prefix: 'X ', suffix: ' Y', occurrenceIndex: 1 }))
    expect(found).toEqual({ start: 15, end: 21 })
    const counter = resolveAnnotationAnchor(rt(text), anchor({ prefix: 'X ', suffix: ' Y', occurrenceIndex: 0 }))
    expect(counter).toEqual({ start: 2, end: 8 })
  })

  it('IMPOSIÇÃO DE TIPO: markdown-fonte no parâmetro NÃO compila — prova de COMPILAÇÃO, não de execução', () => {
    // Esta asserção roda contra o tsc, não contra o vitest: o corpo de
    // neverRuns NUNCA executa. O @ts-expect-error pin a regra — se alguém
    // afrouxar o parâmetro de volta para string crua, a directive vira
    // "unused" e o tsc FALHA (TS2578) no gate. O que ela prova é que o
    // caminho errado NÃO COMPILA; nada afirma sobre runtime.
    const neverRuns = () => {
      const markdownSource = '**negrito** e `codigo` — a fonte, não o textContent'
      // @ts-expect-error — string crua NÃO é RenderedText; só renderedTextFromTextContent produz
      resolveAnnotationAnchor(markdownSource, anchor())
    }
    expect(neverRuns).toBeTypeOf('function')
  })
})
