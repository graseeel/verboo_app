import { describe, it, expect } from 'vitest'
import { createAnnotation } from './createAnnotation'
import { resolveAnnotationAnchor, renderedTextFromTextContent } from './resolveAnnotationAnchor'
import { ANNOTATION_QUOTE_MAX } from '../../../shared/types'

const rt = renderedTextFromTextContent

const base = {
  segmentId: 'turn1:text:0',
  comment: null,
  id: 'ann1',
  createdAt: 1000,
}

describe('createAnnotation — montagem da âncora', () => {
  it('âncora completa: quote, prefix e suffix de até 40, occurrenceIndex 0', () => {
    const text = rt('O modelo respondeu este trecho aqui no meio e seguiu.')
    // 'trecho' está em start=24, end=30 (medido na F0)
    const made = createAnnotation({ ...base, segmentText: text, start: 24, end: 30 })
    expect(made).not.toBeNull()
    expect(made!.truncated).toBe(false)
    expect(made!.annotation).toEqual({
      id: 'ann1',
      segmentId: 'turn1:text:0',
      quote: 'trecho',
      prefix: 'O modelo respondeu este ',
      suffix: ' aqui no meio e seguiu.',
      occurrenceIndex: 0,
      comment: null,
      createdAt: 1000,
    })
  })

  it('prefix/suffix CLAMPADOS em 40 chars no início e no fim do texto', () => {
    const before = 'A'.repeat(60)
    const after = 'Z'.repeat(60)
    const text = rt(`${before}trecho${after}`)
    const made = createAnnotation({ ...base, segmentText: text, start: 60, end: 66 })
    expect(made!.annotation.prefix).toBe('A'.repeat(40)) // só os 40 imediatos
    expect(made!.annotation.suffix).toBe('Z'.repeat(40))
  })

  it('occurrenceIndex conta a POSIÇÃO da ocorrência: segunda instância → 1', () => {
    const text = rt('trecho e outro trecho')
    const made = createAnnotation({ ...base, segmentText: text, start: 15, end: 21 })
    expect(made!.annotation.occurrenceIndex).toBe(1)
  })

  it('CONTRAFACTUAL: primeira instância no mesmo texto → 0 (a única variável é a posição)', () => {
    const text = rt('trecho e outro trecho')
    const made = createAnnotation({ ...base, segmentText: text, start: 0, end: 6 })
    expect(made!.annotation.occurrenceIndex).toBe(0)
  })

  it('TRUNCAGEM no teto de 2000: quote cortado, truncated=true, suffix vazio (marca declarada)', () => {
    const text = rt(`inicio ${'a'.repeat(2500)} fim`)
    const made = createAnnotation({ ...base, segmentText: text, start: 7, end: 7 + 2500 })
    expect(made!.truncated).toBe(true)
    expect(made!.annotation.quote).toBe('a'.repeat(ANNOTATION_QUOTE_MAX))
    expect(made!.annotation.suffix).toBe('') // convenção F0: truncado ⇒ suffix ''
    expect(made!.annotation.prefix).toBe('inicio ')
  })

  it('comentário em branco vira null; comentário real é aparado', () => {
    const text = rt('trecho')
    expect(createAnnotation({ ...base, segmentText: text, start: 0, end: 6, comment: '   ' })!.annotation.comment).toBeNull()
    expect(createAnnotation({ ...base, segmentText: text, start: 0, end: 6, comment: '  ver isso  ' })!.annotation.comment).toBe('ver isso')
  })

  it('seleção inválida (invertida, vazia, fora do texto) → null, sem lançar', () => {
    const text = rt('trecho')
    expect(createAnnotation({ ...base, segmentText: text, start: 4, end: 2 })).toBeNull()
    expect(createAnnotation({ ...base, segmentText: text, start: 2, end: 2 })).toBeNull()
    expect(createAnnotation({ ...base, segmentText: text, start: 0, end: 99 })).toBeNull()
  })
})

describe('createAnnotation × resolveAnnotationAnchor — ROUND-TRIP (a prova rainha)', () => {
  it('criação e resolução CONCORDAM: a âncora criada resolve de volta ao intervalo exato', () => {
    const text = rt('O modelo respondeu este trecho aqui, e repetiu trecho adiante.')
    const made = createAnnotation({ ...base, segmentText: text, start: 24, end: 30 })!
    const resolved = resolveAnnotationAnchor(text, made.annotation)
    expect(resolved).toEqual({ start: 24, end: 30 })
  })

  it('round-trip na SEGUNDA ocorrência (occurrenceIndex 1)', () => {
    const text = rt('O modelo respondeu este trecho aqui, e repetiu trecho adiante.')
    const start = text.indexOf('trecho', 30)
    const made = createAnnotation({ ...base, segmentText: text, start, end: start + 6 })!
    expect(made.annotation.occurrenceIndex).toBe(1)
    expect(resolveAnnotationAnchor(text, made.annotation)).toEqual({ start, end: start + 6 })
  })

  it('round-trip com TRUNCAMENTO: quote truncado ainda resolve ao início exato do trecho', () => {
    const text = rt(`inicio ${'a'.repeat(2500)} fim`)
    const made = createAnnotation({ ...base, segmentText: text, start: 7, end: 7 + 2500 })!
    expect(made.truncated).toBe(true)
    const resolved = resolveAnnotationAnchor(text, made.annotation)
    expect(resolved).toEqual({ start: 7, end: 7 + ANNOTATION_QUOTE_MAX })
  })

  it('round-trip com ocorrências SOBREPOSTAS ("aa" em "aaaa") — passo +1 dos dois lados', () => {
    const text = rt('aaaa')
    const made = createAnnotation({ ...base, segmentText: text, start: 1, end: 3 })!
    expect(made.annotation.occurrenceIndex).toBe(1) // uma ocorrência ("aa" em 0) começa antes
    expect(resolveAnnotationAnchor(text, made.annotation)).toEqual({ start: 1, end: 3 })
  })
})
