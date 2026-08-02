import { describe, it, expect, beforeEach } from 'vitest'
import { resolveSelectionTarget, textOffsetWithin } from './annotationSelectionTarget'

// Monta um mini-DOM no formato do transcript real: segmentos do modelo com
// [data-annotation-segment], mensagem de usuário sem marca, e um turno
// streaming com [data-turn-streaming="true"].
function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body.firstElementChild as HTMLElement
}

const textNodeOf = (selector: string, index = 0): Text => {
  const el = document.querySelector(selector)!
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode() as Text | null
  for (let i = 0; i < index; i++) node = walker.nextNode() as Text | null
  return node!
}

beforeEach(() => { document.body.innerHTML = '' })

describe('resolveSelectionTarget — contenção em segmento do MODELO', () => {
  it('seleção contida num segmento do modelo → alvo com offsets absolutos', () => {
    mount(`<div class="transcript">
      <div class="step-text" data-annotation-segment="t1:text:0"><div class="markdown-body"><p>O modelo respondeu <strong>este trecho</strong> aqui.</p></div></div>
    </div>`)
    // textContent do segmento: 'O modelo respondeu este trecho aqui.'
    const startNode = textNodeOf('[data-annotation-segment]', 0) // 'O modelo respondeu '
    const endNode = textNodeOf('[data-annotation-segment]', 1)   // 'este trecho' (dentro do <strong>)
    const target = resolveSelectionTarget(startNode, 9, endNode, 4)!
    expect(target).not.toBeNull()
    expect(target.segmentId).toBe('t1:text:0')
    expect(target.start).toBe(9)
    expect(target.end).toBe(19 + 4) // 19 = 'O modelo respondeu '.length
    expect(target.clamped).toBe(false)
    const slice = document.querySelector('[data-annotation-segment]')!.textContent!.slice(target.start, target.end)
    expect(slice).toBe('respondeu este')
  })

  it('CONTRAFACTUAL: seleção em mensagem do USUÁRIO → null, nenhuma barra', () => {
    mount(`<div class="transcript">
      <article class="message-row user"><p>mensagem do usuário aqui</p></article>
      <div class="step-text" data-annotation-segment="t1:text:0"><p>texto do modelo</p></div>
    </div>`)
    const node = textNodeOf('.message-row.user')
    expect(resolveSelectionTarget(node, 0, node, 8)).toBeNull()
  })

  it('CONTRAFACTUAL: seleção em segmento de turno STREAMING → null (recusa declarada)', () => {
    mount(`<div class="transcript">
      <article class="turn-view" data-turn-streaming="true">
        <div class="step-text streaming-text" data-annotation-segment="t1:text:0"><p>ainda mudando</p></div>
      </article>
    </div>`)
    const node = textNodeOf('[data-annotation-segment]')
    expect(resolveSelectionTarget(node, 0, node, 5)).toBeNull()
  })

  it('mesmo segmento FORA de streaming vira candidato — a única variável é o atributo streaming', () => {
    mount(`<div class="transcript">
      <article class="turn-view">
        <div class="step-text" data-annotation-segment="t1:text:0"><p>já terminou</p></div>
      </article>
    </div>`)
    const node = textNodeOf('[data-annotation-segment]')
    expect(resolveSelectionTarget(node, 0, node, 5)).not.toBeNull()
  })

  it('seleção CRUZANDO dois segmentos → CLAMPA ao primeiro, com clamped=true', () => {
    mount(`<div class="transcript">
      <div class="step-text" data-annotation-segment="t1:text:0"><p>primeiro segmento do modelo</p></div>
      <div class="step-text" data-annotation-segment="t1:text:1"><p>segundo segmento do modelo</p></div>
    </div>`)
    const anchorNode = textNodeOf('[data-annotation-segment="t1:text:0"]')
    const focusNode = textNodeOf('[data-annotation-segment="t1:text:1"]')
    const target = resolveSelectionTarget(anchorNode, 9, focusNode, 7)!
    expect(target.clamped).toBe(true)
    expect(target.segmentId).toBe('t1:text:0')
    expect(target.start).toBe(9)
    expect(target.end).toBe('primeiro segmento do modelo'.length) // até o FIM do primeiro
  })

  it('seleção de TRÁS PARA FRENTE no mesmo segmento → offsets ordenados', () => {
    mount(`<div class="transcript">
      <div class="step-text" data-annotation-segment="t1:text:0"><p>abcdef</p></div>
    </div>`)
    const node = textNodeOf('[data-annotation-segment]')
    const target = resolveSelectionTarget(node, 5, node, 1)!
    expect(target.start).toBe(1)
    expect(target.end).toBe(5)
  })

  it('caret (start === end) → null, sem barra', () => {
    mount(`<div class="transcript">
      <div class="step-text" data-annotation-segment="t1:text:0"><p>abcdef</p></div>
    </div>`)
    const node = textNodeOf('[data-annotation-segment]')
    expect(resolveSelectionTarget(node, 3, node, 3)).toBeNull()
  })

  it('seleção que SAI do segmento para área sem marca → clamp ao segmento, clamped=true', () => {
    mount(`<div class="transcript">
      <div class="step-text" data-annotation-segment="t1:text:0"><p>texto do modelo</p></div>
      <div class="turn-usage-line">Uso registrado: 100 tokens</div>
    </div>`)
    const anchorNode = textNodeOf('[data-annotation-segment]')
    const outsideNode = textNodeOf('.turn-usage-line')
    const target = resolveSelectionTarget(anchorNode, 6, outsideNode, 3)!
    expect(target.clamped).toBe(true)
    expect(target.end).toBe('texto do modelo'.length)
  })
})

describe('textOffsetWithin — offsets UTF-16 sobre DOM aninhado', () => {
  it('soma text nodes anteriores: negrito no meio não desloca a conta', () => {
    mount(`<div data-annotation-segment="t1:text:0"><p>ab<strong>cd</strong>ef</p></div>`)
    const root = document.querySelector('[data-annotation-segment]')!
    const strongText = textNodeOf('strong')
    expect(textOffsetWithin(root as Element, strongText, 1)).toBe(3) // 'ab' + 'c'
  })
})
