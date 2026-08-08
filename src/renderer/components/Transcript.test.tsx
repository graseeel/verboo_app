import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Transcript, buildTranscriptEntries, cleanLeakedThinkTagItem } from './Transcript'
import type { TranscriptItem, VerbooModel } from '../../shared/types'
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
vi.mock('../../assets/branding/verboo-mascot.png', () => ({ default: 'mascot.png' }))

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

  it('renders persisted simulator annotations as image thumbnails', () => {
    const items: TranscriptItem[] = [{
      id: 'user:simulator-annotation',
      role: 'user',
      text: 'Use the selected component',
      timestamp: 0,
      attachments: [{
        path: '/app/simulator_captures/owner/crop.png',
        name: 'simulator-element.png',
        size: 100,
        kind: 'simulator-annotation',
        simulatorAnnotation: {
          kind: 'element', crop: '/app/simulator_captures/owner/crop.png',
          device: { name: 'iPhone 17 Pro', udid: 'phone', iosVersion: '26.5', orientation: 'portrait' },
          deviceGeneration: 1, frameGeneration: 2,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          deviceRect: { x: 0, y: 0, width: 393, height: 852 },
          viewportSnapshot: { path: '/app/simulator_captures/owner/full.png', width: 393, height: 852, size: 200 },
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

  it('T12: nenhum item assistant chega em MessageArticle — buildTranscriptEntries agrupa TODO assistant em turno (inalcançabilidade pinada)', () => {
    // O caminho labelForItem assistant (Transcript.tsx:768-781) só renderiza
    // via MessageArticle (kind:'message'). Mas turnIdOf (Transcript.tsx:714-718)
    // sempre retorna um turnId para role:'assistant' — turnIdFromText(item) ?? item.id
    // — então TODO assistant item é agrupado em assistant-turn e NUNCA chega em
    // kind:'message'. Este teste pina a invariante: se alguém remover o fallback
    // `?? item.id` de turnIdOf, um assistant bare-id fica vivo em MessageArticle
    // e este teste morre — forçando cobertura do labelForItem assistant branch.
    const assistantShapes: TranscriptItem[] = [
      { id: 'bare-assistant', role: 'assistant', text: 'texto solto', timestamp: 0 },
      { id: 'turn1:text:0', role: 'assistant', text: 'segmento', timestamp: 0 },
      { id: 'turn1:summary', role: 'assistant', kind: 'summary', text: 'Worked for 8s', timestamp: 0 },
      { id: 'turn2:activity:0', role: 'assistant', kind: 'activity', activityKind: 'edit', text: 'Editou', activityDetail: 'foo.ts', timestamp: 0 },
    ]
    const entries = buildTranscriptEntries(assistantShapes)
    const messageEntriesWithAssistant = entries.filter(
      e => e.kind === 'message' && e.item.role === 'assistant',
    )
    expect(messageEntriesWithAssistant).toEqual([])
    const turnEntries = entries.filter(e => e.kind === 'assistant-turn')
    expect(turnEntries.length).toBeGreaterThan(0)
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

  it('turno só-ruído com summary: cabeçalho SEM marca de provedor (T10), NENHUMA bolha de texto vazia', () => {
    const items: TranscriptItem[] = [
      { id: 't2:text:0', role: 'assistant', text: '\n\n</think>', timestamp: 0 },
      { id: 't2:summary', role: 'assistant', kind: 'summary', text: 'Worked for 3s', timestamp: 0 },
    ]
    const { container } = render(<Transcript items={items} />)
    // T10: sem metadado de modelo o cabeçalho não nomeia provedor — o antigo
    // 'Verboo' literal era a mentira medida no campo.
    const meta = container.querySelector('.message-meta')?.textContent
    expect(meta).not.toContain('Verboo')
    expect(meta).toContain('transcript.assistantFallback')
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

describe('TurnView — provider prefix (F3)', () => {
  // Real F2 contract shapes: `provider` absent = verboo; 'claude'/'codex'
  // seen. The i18n mock here passes keys through, so providerDisplayName
  // falls back to Title Case of the id — 'claude' → 'Claude', 'codex' → 'Codex'.
  const catalog: VerbooModel[] = [
    { id: 'glm-5.2', displayName: 'Ultra', raw: {} },
    { id: 'claude-sonnet-4.6', displayName: 'Claude Sonnet 4.6', raw: {}, provider: 'claude' },
    { id: 'gpt-5', displayName: 'GPT-5', raw: {}, provider: 'codex' },
  ]

  function turnItems(modelId: string, modelDisplayName: string): TranscriptItem[] {
    return [{
      id: `turn-${modelId}:text:0`,
      role: 'assistant',
      text: 'Done.',
      timestamp: 0,
      modelId,
      modelDisplayName,
    }]
  }

  it('external provider turn gets the provider prefix and the official brand icon in the header', () => {
    const { container } = render(
      <Transcript items={turnItems('claude-sonnet-4.6', 'Claude Sonnet 4.6')} models={catalog} />,
    )
    const meta = container.querySelector('.message-meta')!
    expect(meta.textContent).toBe('Claude - Claude Sonnet 4.6')
    expect(meta.textContent).not.toContain('Verboo')
    const icon = container.querySelector('.message-meta [data-testid="provider-icon-claude"]')
    expect(icon).toBeTruthy()
    expect(icon!.querySelector('svg')).toBeTruthy()
    // Deterministic per-provider color rides on a CSS var (fallback tile hue).
    expect(icon?.getAttribute('style')).toContain('--provider-color')
  })

  it('T16: verboo turn shows the house mascot icon in the header (same size/alignment as external providers)', () => {
    const { container } = render(
      <Transcript items={turnItems('glm-5.2', 'Ultra')} models={catalog} />,
    )
    const meta = container.querySelector('.message-meta')!
    expect(meta.textContent).toBe('Verboo - Ultra')
    const icon = container.querySelector('.message-meta [data-testid="provider-icon-verboo"]')!
    expect(icon).toBeTruthy()
    expect(icon.querySelector('img.provider-icon-mascot')).toBeTruthy()
  })

  it('no catalog prop → every turn renders as verboo with the house mascot icon', () => {
    const { container } = render(
      <Transcript items={turnItems('claude-sonnet-4.6', 'Claude Sonnet 4.6')} />,
    )
    const meta = container.querySelector('.message-meta')!
    expect(meta.textContent).toBe('Verboo - Claude Sonnet 4.6')
    expect(container.querySelector('[data-testid="provider-icon-verboo"]')).toBeTruthy()
  })

  it('falls back to the displayName lookup when the modelId is unknown', () => {
    const { container } = render(
      <Transcript items={turnItems('stale-id-from-old-session', 'GPT-5')} models={catalog} />,
    )
    const meta = container.querySelector('.message-meta')!
    expect(meta.textContent).toBe('Codex - GPT-5')
    expect(container.querySelector('[data-testid="provider-icon-codex"]')).toBeTruthy()
  })

  it('T16: icone presente nos TRES provedores — verboo (mascot), claude (svg), codex (svg)', () => {
    const { container } = render(
      <>
        <Transcript items={turnItems('glm-5.2', 'Ultra')} models={catalog} />
        <Transcript items={turnItems('claude-sonnet-4.6', 'Claude Sonnet 4.6')} models={catalog} />
        <Transcript items={turnItems('gpt-5', 'GPT-5')} models={catalog} />
      </>,
    )
    const verbooIcon = container.querySelector('[data-testid="provider-icon-verboo"]')!
    expect(verbooIcon).toBeTruthy()
    expect(verbooIcon.querySelector('img.provider-icon-mascot')).toBeTruthy()
    const claudeIcon = container.querySelector('[data-testid="provider-icon-claude"]')!
    expect(claudeIcon).toBeTruthy()
    expect(claudeIcon.querySelector('svg')).toBeTruthy()
    const codexIcon = container.querySelector('[data-testid="provider-icon-codex"]')!
    expect(codexIcon).toBeTruthy()
    expect(codexIcon.querySelector('svg')).toBeTruthy()
  })

  it('model absent from the catalog → verboo header with house mascot icon', () => {
    const { container } = render(
      <Transcript items={turnItems('ghost-model', 'Ghost Model')} models={catalog} />,
    )
    const meta = container.querySelector('.message-meta')!
    expect(meta.textContent).toBe('Verboo - Ghost Model')
    expect(container.querySelector('[data-testid="provider-icon-verboo"]')).toBeTruthy()
  })
})

describe('TurnView — T10: o cabeçalho nunca afirma provedor sem evidência (foto do dono)', () => {
  const catalog: VerbooModel[] = [
    { id: 'glm-5.2', displayName: 'Ultra', raw: {} },
    { id: 'claude-fable-5', displayName: 'Claude Fable 5', raw: {}, provider: 'claude' },
  ]
  // Field measurement (Maestro, owner's real verboo:chat-store:v1): the
  // assistant items of the claude-fable-5 turn carry ONLY id, role, text,
  // timestamp, streaming, kind, activityDetail, skills — NO model fields.
  // The header read that state and still printed the literal 'Verboo'.
  it('turno SEM metadado de modelo → cabeçalho neutro, sem nome de provedor', () => {
    const items: TranscriptItem[] = [{
      id: 'turn-owner:text:1',
      role: 'assistant',
      text: 'ok',
      timestamp: 0,
      streaming: false,
    }]
    const { container } = render(<Transcript items={items} models={catalog} />)
    const meta = container.querySelector('.message-meta')!
    for (const brand of ['Verboo', 'Claude', 'Codex']) {
      expect(meta.textContent).not.toContain(brand)
    }
    // Neutral role label (the i18n mock passes keys through).
    expect(meta.textContent).toContain('transcript.assistantFallback')
    // T16: the house mascot icon is present (decorative — no external provider
    // claimed, just the Verboo brand mark for the fallback provider).
    expect(container.querySelector('[data-testid="provider-icon-verboo"]')).toBeTruthy()
  })

  it('turno claude COM carimbo → "Claude - Claude Fable 5", mesma forma do caminho de sucesso', () => {
    // The send-time stamp wins with NO catalog at all (the catalog may have
    // degraded by render time — the stamp is the evidence).
    const items: TranscriptItem[] = [{
      id: 'turn-claude:text:1',
      role: 'assistant',
      text: 'ok',
      timestamp: 0,
      streaming: false,
      modelId: 'claude-fable-5',
      modelDisplayName: 'Claude Fable 5',
      provider: 'claude',
    }]
    const { container } = render(<Transcript items={items} />)
    const meta = container.querySelector('.message-meta')!
    expect(meta.textContent).toBe('Claude - Claude Fable 5')
    expect(meta.textContent).not.toContain('Verboo')
    expect(container.querySelector('[data-testid="provider-icon-claude"]')).toBeTruthy()
  })
})

describe('T7: a linha de Sistema nunca é verde — erro usa a linguagem de erro do app (field photo do dono)', () => {
  it('item system com id :error ganha is-turn-error (dispara a variante de erro, não verde)', () => {
    const { container } = render(
      <Transcript
        items={[{
          id: 'turn-t7:error',
          role: 'system',
          text: 'API Error: 400 {"error":{"type":"invalid_request"}}',
          timestamp: 0,
        }]}
      />,
    )
    const article = container.querySelector('article.message-row.system')!
    expect(article, 'system row must render').toBeTruthy()
    // A variante de erro (não verde) é disparada por is-turn-error.
    expect(article).toHaveClass('is-turn-error')
    expect(article).toHaveClass('system')
  })

  it('item system com presentation interruption (visualRole assistant) NÃO ganha is-turn-error', () => {
    const { container } = render(
      <Transcript
        items={[{
          id: 'turn-t7-int:error',
          role: 'system',
          text: 'Turn interrupted by the user.',
          presentation: 'interruption',
          timestamp: 0,
        }]}
      />,
    )
    // O interruption é visualmente assistant — não herda o cartão system.
    const article = container.querySelector('article.message-row.assistant')!
    expect(article).toBeTruthy()
    expect(article).not.toHaveClass('is-turn-error')
  })

  // T7 CSS: a regra .message-row.system (base) não pode referenciar --green,
  // e a variante .is-turn-error deve usar --danger (não --green). Pina a
  // regressão: se alguém reintroduzir o verde, o teste falha.
  it('CSS: .message-row.system base é neutra (sem --green) e .is-turn-error usa --danger (sem --green)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(resolve(here, '../styles/surfaces.css'), 'utf8')

    // Base rule: .message-row.system { ... } (NOT .is-turn-error)
    const baseMatch = css.match(/\.message-row\.system\s*\{([^}]*)\}/)
    expect(baseMatch, '.message-row.system base rule must exist').toBeTruthy()
    expect(baseMatch![1], 'base .message-row.system must not paint green (field photo)').not.toMatch(/--green/)

    // Error variant: .message-row.system.is-turn-error { ... }
    const errorMatch = css.match(/\.message-row\.system\.is-turn-error\s*\{([^}]*)\}/)
    expect(errorMatch, '.message-row.system.is-turn-error variant must exist').toBeTruthy()
    expect(errorMatch![1], 'error variant must use the app danger language').toMatch(/--danger/)
    expect(errorMatch![1], 'error variant must not paint green').not.toMatch(/--green/)
  })
})
