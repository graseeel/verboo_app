import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { Transcript, buildTranscriptEntries, cleanLeakedThinkTagItem } from './Transcript'
import type { TranscriptItem } from '../../shared/types'
import { annotationTurnItemId, insertAnnotationTurnBeforeResponse } from '../features/annotations/annotationTurnItem'

// Transcript → TurnView imports MarkdownMessage, StepFlow, ThinkingIcon,
// useI18n. Mock all so the test focuses on the .turn-recap mounting behavior.
vi.mock('../features/transcript/MarkdownMessage', () => ({
  MarkdownMessage: ({ text }: { text: string }) => <div className="mock-markdown">{text}</div>,
  normalizeThinkingProse: (t: string) => t,
}))
vi.mock('../features/transcript/StepFlow', () => ({
  StepFlow: ({ hideFinalTextId }: { hideFinalTextId?: string }) => (
    <div className="mock-stepflow" data-hide-id={hideFinalTextId ?? ''} />
  ),
}))
vi.mock('../features/transcript/TranscriptIcons', () => ({ ThinkingIcon: () => null }))
vi.mock('../i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))

beforeEach(() => cleanup())

describe('TurnView — .turn-recap stays mounted after expand', () => {
  const turnId = 'turn-recap-test'

  it('renders .turn-recap when turn has final text and actions (non-streaming)', () => {
    const items: TranscriptItem[] = [
      {
        id: `${turnId}:activity:0`,
        role: 'assistant',
        kind: 'activity',
        activityKind: 'edit',
        text: 'Editou arquivo',
        activityDetail: 'src/foo.ts',
        timestamp: 0,
      },
      {
        id: `${turnId}:text:0`,
        role: 'assistant',
        text: 'I fixed the bug by correcting the type annotation.',
        timestamp: 0,
      },
    ]
    const { container } = render(<Transcript items={items} />)
    // .turn-recap should be present BEFORE expand (no longer gated on !expanded)
    const recap = container.querySelector('.turn-recap')
    expect(recap).toBeTruthy()
    expect(recap?.textContent).toContain('I fixed the bug by correcting the type annotation.')

    // Click the expand button
    const collapseBtn = container.querySelector('.turn-collapsed')
    expect(collapseBtn).toBeTruthy()
    fireEvent.click(collapseBtn!)

    // .turn-recap must STILL be mounted after expand
    expect(container.querySelector('.turn-recap')).toBeTruthy()
  })

  it('renders .turn-recap even when turn has no actions (text only, non-streaming)', () => {
    const items: TranscriptItem[] = [
      {
        id: `${turnId}:text:0`,
        role: 'assistant',
        text: 'Just a response message.',
        timestamp: 0,
      },
    ]
    const { container } = render(<Transcript items={items} />)
    // Text-only turns still show the recap (the "static" span variant)
    expect(container.querySelector('.turn-recap')).toBeTruthy()
  })

  it('renders persisted browser annotations as image thumbnails', () => {
    const items: TranscriptItem[] = [{
      id: 'user:annotation',
      role: 'user',
      text: 'Use this visual context',
      timestamp: 0,
      attachments: [{
        path: '/app/browser_captures/owner/crop.png',
        name: 'browser-annotation.png',
        size: 100,
        kind: 'browser-annotation',
        browserAnnotation: {
          kind: 'pen', crop: '/app/browser_captures/owner/crop.png', url: 'http://localhost:3000',
          rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 },
        },
      }],
    }]

    const { container } = render(<Transcript items={items} />)

    expect(container.querySelector('.message-attachment-image img')).toBeTruthy()
    expect(container.querySelector('.message-attachment-file')).toBeNull()
  })

  it('renders a turn error in the main transcript with a friendly summary and expandable detail', () => {
    const rawDiagnostic = '(signal, runtime=bundled-node, cwd=/project)'
    const { container } = render(
      <Transcript
        items={[{
          id: 'turn-main:error',
          role: 'system',
          text: 'Turn interrupted by the user.',
          errorDetail: rawDiagnostic,
          timestamp: 0,
        }]}
      />,
    )

    expect(container).toHaveTextContent('Turn interrupted by the user.')
    const details = container.querySelector('details.turn-error-details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('pre')).toHaveTextContent(rawDiagnostic)
    fireEvent.click(screen.getByText('transcript.showTechnicalDetails'))
    expect(details.open).toBe(true)
    expect(container).toHaveTextContent(rawDiagnostic)
  })

  it('renders an interruption with the assistant treatment while keeping a real failure highlighted', () => {
    const interruptionText = 'Turn interrupted by the user.'
    const failureText = '(signal, runtime=bundled-node, cwd=/project)'
    const { container } = render(
      <Transcript
        items={[
          {
            id: 'turn-interruption:error',
            role: 'system',
            text: interruptionText,
            errorDetail: failureText,
            presentation: 'interruption',
            timestamp: 0,
          },
          {
            id: 'turn-failure:error',
            role: 'system',
            text: failureText,
            timestamp: 1,
          },
        ]}
      />,
    )

    const interruptionRow = screen.getByText(interruptionText).closest('article')
    const failureRow = Array.from(container.querySelectorAll('article')).find(row =>
      row.querySelector('.message-text')?.textContent === failureText,
    )
    expect(interruptionRow).toHaveClass('assistant')
    expect(interruptionRow).not.toHaveClass('system')
    expect(within(interruptionRow!).queryByText('transcript.system')).not.toBeInTheDocument()
    expect(failureRow).toHaveClass('system')
    expect(within(failureRow!).getByText('transcript.system')).toBeInTheDocument()
  })
})

// --- Vazamento de </think> cru no transcript ----------------------------------
// Insumos: as CINCO formas medidas pelo Maestro no histórico persistido real
// (verboo:chat-store:v1, 36 ocorrências), verbatim. Alegação vale pelo insumo.
describe('</think> vazado — limpeza na exibição (função pura)', () => {
  const seg = (id: string, text: string): TranscriptItem => ({ id, role: 'assistant', text, timestamp: 0 })

  // 30x / 3x / 1x = só ruído → segmento descartado (null).
  // 1x / 1x = a resposta do modelo veio JUNTO → conteúdo sobrevive INTEIRO,
  // só a linha da tag some. Descartar o segmento aqui apagaria a resposta.
  const LEAKED_FORMS: Array<{ name: string; input: string; expected: string | null }> = [
    { name: 'forma dominante (30x no real): só a tag', input: '\n\n</think>', expected: null },
    { name: 'tag entre quebras (3x)', input: '\n</think>\n', expected: null },
    { name: 'duas tags, nada mais (1x)', input: '\n</think>\n\n\n</think>', expected: null },
    {
      name: 'tag após relatório parcial (1x): conteúdo sobrevive inteiro',
      input: '\n\nResultado inicial:\n\n- lista1.txt -> alpha\n\nVerificacao cruzada em andamento...\n\n</think>',
      expected: '\n\nResultado inicial:\n\n- lista1.txt -> alpha\n\nVerificacao cruzada em andamento...\n',
    },
    {
      name: 'tag antes da resposta completa (1x): resposta sobrevive inteira',
      input: '\n</think>\n\n\nI cannot do this task.\n\nMy memory is explicit about the limit.',
      expected: '\n\n\nI cannot do this task.\n\nMy memory is explicit about the limit.',
    },
  ]

  it.each(LEAKED_FORMS)('$name', ({ input, expected }) => {
    const cleaned = cleanLeakedThinkTagItem(seg('t1:text:0', input))
    if (expected === null) expect(cleaned).toBeNull()
    else expect(cleaned?.text).toBe(expected)
  })

  it('menção inline no meio de uma frase SOBREVIVE (a tag não ocupa linha própria)', () => {
    const item = seg('t1:text:0', 'o fechamento é </think> nesse formato')
    expect(cleanLeakedThinkTagItem(item)).toBe(item)
  })

  it('tag indentada (ex.: bloco de código) SOBREVIVE — não começa na coluna 0', () => {
    const item = seg('t1:text:0', '```xml\n  </think>\n```')
    expect(cleanLeakedThinkTagItem(item)).toBe(item)
  })

  it('abertura <think> em linha própria também é removida (simetria, custo zero)', () => {
    expect(cleanLeakedThinkTagItem(seg('t1:text:0', '\n\n<think>'))).toBeNull()
  })

  it('mensagem de USUÁRIO com a tag em linha própria é INTOCÁVEL', () => {
    // O usuário pode colar output de modelo no composer; limpar isso seria
    // destruir dado que ele mesmo digitou.
    const item: TranscriptItem = { id: 'user:1', role: 'user', text: 'colei isso do log:\n</think>\nfim', timestamp: 0 }
    expect(cleanLeakedThinkTagItem(item)).toBe(item)
  })

  it('itens activity e summary são INTOCÁVEIS mesmo com a tag no texto', () => {
    const activity: TranscriptItem = {
      id: 't1:activity:0', role: 'assistant', kind: 'activity', activityKind: 'thinking', text: '</think>', timestamp: 0,
    }
    expect(cleanLeakedThinkTagItem(activity)).toBe(activity)
  })

  it('item sem nada a limpar retorna a MESMA referência (fast-path, sem realocar o transcript inteiro)', () => {
    const item = seg('t1:text:0', 'resposta normal do modelo')
    expect(cleanLeakedThinkTagItem(item)).toBe(item)
  })

  it('tag na coluna zero DENTRO de cerca de crases: o bloco sai INTACTO (mesma referência)', () => {
    // Dentro da cerca a tag é conteúdo visível do usuário — apagá-la seria
    // pior que o vazamento. Intacto ao ponto de nem realocar o item.
    const item = seg('t1:text:0', '```\n</think>\n```')
    expect(cleanLeakedThinkTagItem(item)).toBe(item)
  })

  it('CONTRAFACTUAL: a MESMA tag na coluna zero FORA de cerca é removida — a única variável é a cerca', () => {
    expect(cleanLeakedThinkTagItem(seg('t1:text:0', '</think>'))).toBeNull()
  })

  it('tag fora E dentro de cerca no mesmo texto: só a de fora é removida', () => {
    const cleaned = cleanLeakedThinkTagItem(seg('t1:text:0', '</think>\n```\n</think>\n```'))
    expect(cleaned?.text).toBe('```\n</think>\n```')
  })

  it('cerca NÃO FECHADA protege até o fim do texto (mesmo comportamento do render markdown)', () => {
    const item = seg('t1:text:0', '```\n</think>')
    expect(cleanLeakedThinkTagItem(item)).toBe(item)
  })
})

describe('</think> vazado — agrupamento de turnos (riscos 1 e 2)', () => {
  const seg = (id: string, text: string): TranscriptItem => ({ id, role: 'assistant', text, timestamp: 0 })
  const summary = (turnId: string, text = 'Worked for 8s'): TranscriptItem => ({
    id: `${turnId}:summary`, role: 'assistant', kind: 'summary', text, timestamp: 0,
  })

  it('RISCO 1: turno cujo único segmento era a tag mantém cabeçalho e summary, sem itens de texto', () => {
    const entries = buildTranscriptEntries([seg('t1:text:0', '\n\n</think>'), summary('t1')])
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry.kind).toBe('assistant-turn')
    if (entry.kind === 'assistant-turn') {
      expect(entry.items).toHaveLength(0) // impossível renderizar bolha vazia
      expect(entry.summary?.text).toBe('Worked for 8s') // o turno não some com o cabeçalho
    }
  })

  it('RISCO 1 (degenerado): turno que só continha a tag e NADA mais (sem summary) some — desfecho declarado', () => {
    // No fluxo real todo turno encerrado recebe summary, então isto não ocorre;
    // se ocorresse, o que sumiu era 100% ruído — uma bolha vazia seria pior.
    expect(buildTranscriptEntries([seg('t1:text:0', '\n\n</think>')])).toHaveLength(0)
  })

  it('RISCO 2: tag no MEIO da sequência — um turno só, ordem preservada, sem duplicar', () => {
    const entries = buildTranscriptEntries([
      seg('t1:text:0', 'Antes da tag.'),
      seg('t1:text:1', '\n</think>\n'),
      seg('t1:text:2', 'Depois da tag.'),
      summary('t1'),
    ])
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    if (entry.kind === 'assistant-turn') {
      expect(entry.items.map(i => i.id)).toEqual(['t1:text:0', 't1:text:2'])
      expect(entry.items.map(i => i.text)).toEqual(['Antes da tag.', 'Depois da tag.'])
      expect(entry.summary?.text).toBe('Worked for 8s')
    }
  })
})

describe('</think> vazado — DOM real: a tag nunca chega à tela', () => {
  it('tag + resposta real: a resposta aparece INTEIRA no recap e a tag não aparece em lugar nenhum', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1:text:0', role: 'assistant',
        text: '\n</think>\n\n\nI cannot do this task.\n\nMy memory is explicit about the limit.',
        timestamp: 0,
      },
      { id: 't1:summary', role: 'assistant', kind: 'summary', text: 'Worked for 8s', timestamp: 0 },
    ]
    const { container } = render(<Transcript items={items} />)
    const recap = container.querySelector('.turn-recap')
    expect(recap?.textContent).toContain('I cannot do this task.')
    expect(recap?.textContent).toContain('My memory is explicit about the limit.')
    expect(container.textContent).not.toContain('</think>')
  })

  it('turno só-ruído com summary: cabeçalho Verboo permanece, NENHUMA bolha de texto vazia', () => {
    const items: TranscriptItem[] = [
      { id: 't2:text:0', role: 'assistant', text: '\n\n</think>', timestamp: 0 },
      { id: 't2:summary', role: 'assistant', kind: 'summary', text: 'Worked for 3s', timestamp: 0 },
    ]
    const { container } = render(<Transcript items={items} />)
    expect(container.querySelector('.message-meta')?.textContent).toContain('Verboo')
    expect(container.querySelector('.turn-recap')).toBeNull()
    expect(container.textContent).not.toContain('</think>')
  })

  it('multi-segmento com tag no meio: um turno só na tela, último texto limpo no recap', () => {
    const items: TranscriptItem[] = [
      { id: 't3:text:0', role: 'assistant', text: 'Antes da tag.', timestamp: 0 },
      { id: 't3:text:1', role: 'assistant', text: '\n</think>\n', timestamp: 0 },
      { id: 't3:text:2', role: 'assistant', text: 'Depois da tag.', timestamp: 0 },
      { id: 't3:summary', role: 'assistant', kind: 'summary', text: 'Worked for 5s', timestamp: 0 },
    ]
    const { container } = render(<Transcript items={items} />)
    expect(container.querySelectorAll('article.turn-view')).toHaveLength(1)
    expect(container.querySelector('.turn-recap')?.textContent).toContain('Depois da tag.')
    expect(container.textContent).not.toContain('</think>')
  })
})

describe('F3 (N3) — annotation turn card reaches the DOM', () => {
  const annotationIds = ['annotation-source-1']
  const baseItem: TranscriptItem = {
    id: annotationTurnItemId(annotationIds),
    role: 'user',
    kind: 'annotation',
    text: '1. Selected text: "excerpt one"\n   Your comment: "first note"',
    annotationEntries: [
      { quote: 'excerpt one', comment: 'first note' },
      { quote: 'excerpt two', comment: null },
    ],
    timestamp: 0,
  }

  const responseItem: TranscriptItem = {
    id: 'turn-after-annotation:text:0',
    role: 'assistant',
    text: 'Model response caused by the user turn.',
    timestamp: 1,
  }

  function expectUserTurnBeforeResponse(container: HTMLElement, userSelector: string) {
    const userTurn = container.querySelector(userSelector)
    const response = container.querySelector('article.turn-view')
    expect(userTurn).toBeTruthy()
    expect(response).toBeTruthy()
    expect(userTurn!.compareDocumentPosition(response!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }

  it('EFFECT: the annotation user turn appears BEFORE the model response it caused', () => {
    const items = insertAnnotationTurnBeforeResponse(
      [responseItem],
      baseItem,
      'turn-after-annotation',
    )
    const { container } = render(<Transcript items={items} />)

    expectUserTurnBeforeResponse(container, 'article.annotation-turn')
  })

  it('CONTRAFACTUAL: a normal text user turn produces the SAME user-before-response DOM order', () => {
    const normalUser: TranscriptItem = {
      id: 'user:normal-order',
      role: 'user',
      text: 'Normal user message.',
      timestamp: 0,
    }
    const { container } = render(<Transcript items={[normalUser, responseItem]} />)

    expectUserTurnBeforeResponse(container, 'article.message-row.user')
  })

  it('RETRY: the same annotation turn is not duplicated when a replacement turn executes', () => {
    const first = insertAnnotationTurnBeforeResponse(
      [responseItem],
      baseItem,
      'turn-after-annotation',
    )
    const replacementResponse: TranscriptItem = {
      ...responseItem,
      id: 'replacement-turn:text:0',
    }

    const retried = insertAnnotationTurnBeforeResponse(
      [...first, replacementResponse],
      { ...baseItem, id: annotationTurnItemId(annotationIds) },
      'replacement-turn',
    )
    const { container } = render(<Transcript items={retried} />)

    expect(container.querySelectorAll('article.annotation-turn')).toHaveLength(1)
  })

  it('EFFECT: the frozen pairs render as a sober card — quote AND comment reach the screen', () => {
    const { container } = render(<Transcript items={[baseItem]} />)

    const card = container.querySelector('.annotation-turn-list')
    expect(card).toBeTruthy()
    const quotes = container.querySelectorAll('.annotation-turn-quote')
    expect(quotes).toHaveLength(2)
    expect(quotes[0].textContent).toBe('excerpt one')
    expect(quotes[1].textContent).toBe('excerpt two')
    // No orphan comment node for the comment-less entry:
    const comments = container.querySelectorAll('.annotation-turn-comment')
    expect(comments).toHaveLength(1)
    expect(comments[0].textContent).toBe('first note')
    // Numbers come from position — renumbered, no holes:
    const indexes = [...container.querySelectorAll('.annotation-turn-index')].map(n => n.textContent)
    expect(indexes).toEqual(['1', '2'])
    // The dedicated card REPLACES the markdown fallback in the new build —
    // the readable `text` exists only for old builds:
    expect(container.querySelector('.mock-markdown')).toBeNull()
  })

  it('DEGRADATION: annotation item WITHOUT entries (corrupted/legacy) falls back to the readable text bubble', () => {
    const legacyOnly: TranscriptItem = { ...baseItem, annotationEntries: undefined }
    const { container } = render(<Transcript items={[legacyOnly]} />)
    expect(container.querySelector('.annotation-turn-list')).toBeNull()
    const fallback = container.querySelector('.mock-markdown')
    expect(fallback?.textContent).toContain('excerpt one')
  })

  it('OLD-APP STORE: an item with a FUTURE unknown kind degrades to a normal bubble (never breaks, never invisible)', () => {
    // Simulates an old build opening a store written by a newer one: the kind
    // is unknown, so the generic message path renders the readable text.
    const future = {
      id: 'future:1',
      role: 'user',
      kind: 'whatever-v9-kind',
      text: 'content from the future',
      timestamp: 0,
    } as unknown as TranscriptItem
    const { container } = render(<Transcript items={[future]} />)
    expect(container.querySelector('.mock-markdown')?.textContent).toContain('content from the future')
  })
})
