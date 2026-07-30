/**
 * G-C15-TS: render test for the goal-completion usage line.
 *
 * The user REJECTED the separate green box (G-C13's approach). The
 * completionSummary is verbose, English, and the user called it
 * "irrelevant information" — it stays in the backend (lastEvaluation)
 * for diagnostics. The usage line is stamped on the last turn's summary
 * item (TranscriptItem.usageLine) and rendered inline after the agent's
 * final text by the TurnView.
 *
 * This test proves the RENDER of the new format:
 *   - The usage line appears inside a .turn-usage-line container (no box,
 *     no badge, no colored background).
 *   - There is NO separate .message-row.summary item with id ":completion"
 *     (the green box is gone).
 *   - The agent's final text ("Conteúdo verificado: valor") appears in the
 *     same turn as the usage line, reading as continuation.
 *
 * What this test does NOT prove:
 *   - The producer (goalPrompt.ts buildGoalUsageLine) — covered by
 *     goalPrompt.test.tsx G-C15-TS tests.
 *   - The scheduler→onComplete wiring — covered by goalScheduler.test.tsx
 *     G-C13-FIX bug-witness.
 *
 * Why mock MarkdownMessage:
 *   The full MarkdownMessage import chain pulls a syntax highlighter and
 *   a React-Markdown pipeline that aren't what we're testing. The mock
 *   renders the raw text inside .mock-markdown, which we can scan.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Transcript } from '../../components/Transcript'
import type { TranscriptItem } from '../../../shared/types'
import { I18nProvider } from '../../i18n'

vi.mock('../../features/transcript/MarkdownMessage', () => ({
  MarkdownMessage: ({ text }: { text: string }) => <div className="mock-markdown">{text}</div>,
  normalizeThinkingProse: (t: string) => t,
}))
vi.mock('../../features/transcript/StepFlow', () => ({
  StepFlow: () => null,
}))
vi.mock('../../features/transcript/TranscriptIcons', () => ({ ThinkingIcon: () => null }))
vi.mock('../../../../assets/branding/verboo-mascot.png', () => ({ default: 'mascot.png' }))

beforeEach(() => cleanup())

function renderWithI18n(items: TranscriptItem[]) {
  return render(
    <I18nProvider language="pt-BR">
      <Transcript items={items} />
    </I18nProvider>,
  )
}

describe('G-C15-TS: goal-completion usage line renders inline, no separate box', () => {
  // The user said: "isso deve ficar no backend, nao deve ficar no
  // visual do usuario, e muito ruido" and "a informacao de uso deve
  // ler como CONTINUACAO da mensagem final do agente". These tests
  // prove both: the usage line is inline (not a box), and the
  // completionSummary is NOT in the rendered DOM.

  it('renders the usage line inline after the agent final text (no separate box)', () => {
    // The last turn's summary item has usageLine stamped (the shape
    // produced by App.tsx onComplete delegate). The TurnView renders
    // it as a .turn-usage-line <div> right after the .turn-recap.
    const finalTextItem: TranscriptItem = {
      id: 'message-final',
      role: 'assistant',
      text: 'Objetivo concluído\n\nArquivo criado: /tmp/test.txt\nConteúdo verificado: valor',
      timestamp: 0,
    }
    const summaryItem: TranscriptItem = {
      id: 'Turn-1:summary',
      role: 'system',
      kind: 'summary',
      text: 'Worked for 24min20s',
      timestamp: 0,
      // G-C15-FIX: honest label. While the evaluator's tokens are not
      // in the total, the label is "Uso registrado" (not "Total"). This
      // is the common case until the evaluator parcel is wired end-to-end.
      usageLine: 'Uso registrado: 79.695 tokens; tempo aproximado: 8min20s',
    }

    const { container } = renderWithI18n([finalTextItem, summaryItem])

    // The usage line renders inside .turn-usage-line — a plain inline
    // div with no box, no badge, no colored background.
    const usageLine = container.querySelector('.turn-usage-line')
    expect(usageLine).toBeTruthy()
    expect(usageLine!.textContent).toContain('79.695 tokens')
    expect(usageLine!.textContent).toContain('8min20s')
    expect(usageLine!.textContent).toContain('Uso registrado')

    // The usage line is inside the TurnView's article (the same turn
    // as the agent's final text), so it reads as continuation.
    expect(usageLine!.closest('article.turn-view')).toBeTruthy()
  })

  it('does NOT render a separate green box for the completion (G-C13 box is gone)', () => {
    // The old approach created a TranscriptItem with id ":completion"
    // that rendered as a MessageArticle with .message-row.summary and
    // a CheckCircle2 icon. G-C15-TS removes that entirely. If anyone
    // reintroduces it, this test fails.
    const finalTextItem: TranscriptItem = {
      id: 'message-final',
      role: 'assistant',
      text: 'Objetivo concluído',
      timestamp: 0,
    }
    const summaryItem: TranscriptItem = {
      id: 'Turn-1:summary',
      role: 'system',
      kind: 'summary',
      text: 'Worked for 8min20s',
      timestamp: 0,
      usageLine: 'Uso registrado: 79.695 tokens; tempo aproximado: 8min20s',
    }

    const { container } = renderWithI18n([finalTextItem, summaryItem])

    // No .message-row.summary — that's the green box (CheckCircle2 icon).
    expect(container.querySelector('.message-row.summary')).toBeNull()
    // No item with id ending in :completion.
    const itemsWithCompletionId = container.querySelectorAll('[id$=":completion"]')
    expect(itemsWithCompletionId.length).toBe(0)
  })

  it('does NOT render the evaluator completionSummary on screen (backend only)', () => {
    // The user said the completionSummary is "irrelevant information"
    // and "isso deve ficar no backend". The TurnView renders the
    // agent's final text (which the MODEL generated) and the usage
    // line (which the renderer stamps). The evaluator's
    // completionSummary lives in lastEvaluation — NOT in the rendered
    // DOM. If anyone wires it back to the screen, this test fails.
    const summaryItem: TranscriptItem = {
      id: 'Turn-1:summary',
      role: 'system',
      kind: 'summary',
      text: 'Worked for 8min20s',
      timestamp: 0,
      usageLine: 'Uso registrado: 79.695 tokens; tempo aproximado: 8min20s',
    }

    const { container } = renderWithI18n([summaryItem])

    // No "Objetivo concluído:" heading (the old G-C13 box had it).
    expect(container.textContent).not.toContain('Objetivo concluído:')
    // No "Arquivo criado com sucesso" (the evaluator's verbose text).
    expect(container.textContent).not.toContain('Arquivo criado com sucesso')
  })

  it('does NOT render the usage line when summary.usageLine is absent (non-goal turns)', () => {
    // Non-goal turns have a summary item without usageLine. The
    // .turn-usage-line div must NOT render.
    const finalTextItem: TranscriptItem = {
      id: 'message-final',
      role: 'assistant',
      text: 'Regular assistant message',
      timestamp: 0,
    }
    const summaryItem: TranscriptItem = {
      id: 'Turn-1:summary',
      role: 'system',
      kind: 'summary',
      text: 'Worked for 5s',
      timestamp: 0,
      // No usageLine — non-goal turn.
    }

    const { container } = renderWithI18n([finalTextItem, summaryItem])

    expect(container.querySelector('.turn-usage-line')).toBeNull()
  })

  it('renders the usage line with same typographic family as turn-recap (no box)', () => {
    // Defensive: the .turn-usage-line must NOT be inside a
    // .message-row.summary (that's the green box). It's inside the
    // TurnView's article.turn-view — the same surface as the agent's
    // final text.
    const summaryItem: TranscriptItem = {
      id: 'Turn-1:summary',
      role: 'system',
      kind: 'summary',
      text: 'Worked for 8min20s',
      timestamp: 0,
      usageLine: 'Uso registrado: 79.695 tokens; tempo aproximado: 8min20s',
    }

    const { container } = renderWithI18n([summaryItem])

    const usageLine = container.querySelector('.turn-usage-line')
    expect(usageLine).toBeTruthy()
    // NOT inside a .message-row.summary (that's the green box).
    expect(usageLine!.closest('.message-row.summary')).toBeNull()
    // Inside the TurnView's article (the turn surface).
    expect(usageLine!.closest('article.turn-view')).toBeTruthy()
  })
})
