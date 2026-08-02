/**
 * T4: RENDER tests for the batch progress line and the final batch
 * report — real DOM, via the REAL Transcript/TurnView, with lines built
 * by the REAL builders (goalReport.ts) from a REAL goal state.
 *
 * The Maestro's criterion: each test must prove the information REACHES
 * THE SCREEN, not that a string was assembled. So these tests close the
 * producer→consumer loop in one shot: goal state → buildBatchReportLines
 * / buildBatchProgressLine → TranscriptItem stamps (the shape the App's
 * onComplete / onStatusChange delegates produce) → rendered DOM →
 * assertions on what is visible and WHERE (inline, same turn, no box).
 *
 * What they do NOT prove: the App.tsx delegate wiring itself (the
 * updateConversation surgery) — that glue mirrors the proven onComplete
 * usage-line stamp. Declared limit, same as goalCompletionRender.test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Transcript } from '../../components/Transcript'
import type { GoalState, GoalTask, TranscriptItem } from '../../../shared/types'
import { createTranslator, I18nProvider } from '../../i18n'
import { buildBatchProgressLine, buildBatchReportLines } from './goalReport'

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

function renderWithLanguage(items: TranscriptItem[], language: 'pt-BR' | 'en-US') {
  return render(
    <I18nProvider language={language}>
      <Transcript items={items} />
    </I18nProvider>,
  )
}

function makeTask(overrides: Partial<GoalTask>): GoalTask {
  return { id: `task-${crypto.randomUUID()}`, text: 'Task', status: 'done', ...overrides }
}

/** A batch goal in its terminal shape — the same fields the scheduler
 *  leaves behind when the batch completes (T1-T4 stamps). */
function makeCompletedBatchGoal(): GoalState {
  return {
    id: 'goal-1',
    objective: 'Ship the batch',
    status: 'completed',
    createdAt: 0,
    updatedAt: 0,
    startedAt: 0,
    completedAt: 100,
    turnsRun: 4,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    noProgressCount: 0,
    recentFingerprints: [],
    accessMode: 'approval',
    workingDirectory: '/tmp',
    skills: [],
    taskIndex: 2,
    turnsRunThisTask: 0,
    consecutiveFailedTasks: 0,
    compactionFailures: 1,
    tasks: [
      makeTask({ text: 'Create the file', status: 'done', turns: 1, evidenceCount: 2 }),
      makeTask({ text: 'Fix the flaky test', status: 'failed', failureReason: 'loop', turns: 3 }),
      makeTask({ text: 'Polish the copy', status: 'skipped', turns: 0 }),
    ],
  }
}

function makeTurnItems(summary: Partial<TranscriptItem>): TranscriptItem[] {
  return [
    {
      // Turn-scoped id (`${turnId}:text:N`) — the same idiom the backend
      // uses, so the final text and the summary land in the SAME turn
      // (a bare 'message-final' id would form its own separate turn).
      id: 'Turn-1:text:0',
      role: 'assistant',
      text: 'Objetivo concluído',
      timestamp: 0,
    },
    {
      id: 'Turn-1:summary',
      role: 'system',
      kind: 'summary',
      text: 'Worked for 8min20s',
      timestamp: 0,
      ...summary,
    },
  ]
}

describe('T4: the batch FINAL REPORT reaches the screen', () => {
  it('renders title, every task line and the compaction footer — inline, same turn, no box (pt-BR)', () => {
    // PRODUCER → CONSUMER, closed loop: the lines are built from a real
    // goal state by the real builder, stamped on the summary item in the
    // exact shape the onComplete delegate produces.
    const goal = makeCompletedBatchGoal()
    const batchReportLines = buildBatchReportLines(goal, createTranslator('pt-BR'))
    const items = makeTurnItems({ batchReportLines, usageLine: 'Total registrado: 150.000 tokens' })

    const { container } = renderWithLanguage(items, 'pt-BR')

    const article = container.querySelector('article.turn-view')
    expect(article).toBeTruthy()
    const text = article!.textContent ?? ''
    // Title, one line per task with its cited evidence, and the footer —
    // ALL visible inside the SAME turn as the agent's final message.
    expect(text).toContain('Relatório do lote')
    expect(text).toContain('1. Create the file — concluída (turnos: 1, ações: 2)')
    expect(text).toContain('2. Fix the flaky test — falhou (Possível loop detectado)')
    expect(text).toContain('3. Polish the copy — pulada por você')
    expect(text).toContain('Compactações que falharam: 1 — o lote seguiu sem compactar')
    // The report renders in the usage-line typographic family — inline,
    // no badge, no separate green box (the G-C13 rejection).
    const reportContainer = Array.from(container.querySelectorAll('.turn-usage-line'))
      .find(el => (el.textContent ?? '').includes('Relatório do lote'))
    expect(reportContainer).toBeTruthy()
    expect(reportContainer!.closest('article.turn-view')).toBeTruthy()
    expect(container.querySelector('.message-row.summary')).toBeNull()
    expect(container.querySelectorAll('[id$=":completion"]').length).toBe(0)
  })

  it('renders the SAME report in en-US (both locales reach the DOM, not just the table)', () => {
    const goal = makeCompletedBatchGoal()
    const batchReportLines = buildBatchReportLines(goal, createTranslator('en-US'))
    const items = makeTurnItems({ batchReportLines })

    const { container } = renderWithLanguage(items, 'en-US')

    const text = container.querySelector('article.turn-view')!.textContent ?? ''
    expect(text).toContain('Batch report')
    expect(text).toContain('done (turns: 1, actions: 2)')
    expect(text).toContain('failed (Possible loop detected)')
    expect(text).toContain('skipped by you')
    expect(text).toContain('Compactions failed: 1 — the batch continued without compacting')
  })
})

describe('T4: the batch PROGRESS line reaches the screen', () => {
  it('renders "Tarefa k de N" inline in the turn (pt-BR) — and "Task k of N" in en-US', () => {
    const goal = makeCompletedBatchGoal()
    const progressLine = buildBatchProgressLine(goal, createTranslator('pt-BR'))
    expect(progressLine).toBe('Tarefa 3 de 3')
    const { container } = renderWithLanguage(makeTurnItems({ progressLine: progressLine! }), 'pt-BR')

    const progressContainer = Array.from(container.querySelectorAll('.turn-usage-line'))
      .find(el => (el.textContent ?? '').includes('Tarefa 3 de 3'))
    expect(progressContainer).toBeTruthy()
    expect(progressContainer!.closest('article.turn-view')).toBeTruthy()

    const progressLineEn = buildBatchProgressLine(goal, createTranslator('en-US'))
    const { container: containerEn } = renderWithLanguage(makeTurnItems({ progressLine: progressLineEn! }), 'en-US')
    expect(containerEn.querySelector('article.turn-view')!.textContent).toContain('Task 3 of 3')
  })

  it('a LEGACY (non-batch) turn renders NOTHING extra — no line, no report', () => {
    // The builders return null/[] for legacy goals, so the App stamps
    // nothing and the summary item carries neither field — pin the
    // render consequence: zero .turn-usage-line containers.
    const { container } = renderWithLanguage(makeTurnItems({}), 'pt-BR')
    expect(container.querySelector('.turn-usage-line')).toBeNull()
  })

  it('the completed batch shows the REPORT, not the progress line (progressLine cleared by onComplete)', () => {
    // The onComplete delegate clears progressLine when stamping the
    // report — the final item carries batchReportLines and NO
    // progressLine. Pin the render of that shape: the "Tarefa N de N"
    // line (which would duplicate what the report already says) is NOT
    // on screen.
    const goal = makeCompletedBatchGoal()
    const batchReportLines = buildBatchReportLines(goal, createTranslator('pt-BR'))
    const items = makeTurnItems({ batchReportLines, progressLine: undefined })

    const { container } = renderWithLanguage(items, 'pt-BR')

    const text = container.querySelector('article.turn-view')!.textContent ?? ''
    expect(text).toContain('Relatório do lote')
    expect(text).not.toContain('Tarefa 3 de 3')
  })
})
