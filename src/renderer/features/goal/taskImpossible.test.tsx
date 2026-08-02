/**
 * D-D: PAUSE WITH REPLY-TO-RESUME (taskImpossible) — the renderer
 * counterpart of the new Rust verdict. Covers:
 *
 *   1. resumeGoalSessionId — session rehydration on resume (the "sem
 *      perda de contexto" fix): after an app restart the resume must
 *      attach the OLD session, never open a new one in silence.
 *   2. shouldResumeGoalOnUserMessage — a composer reply auto-resumes
 *      ONLY a taskImpossible pause on the OWNER conversation.
 *   3. translateGoalReason — the new reasonId translates in both
 *      locales, never the raw camelCase literal.
 *   4. The pause MESSAGE in the real DOM — legible reason + the v1
 *      contract sentence reach the screen (the contract lives in the
 *      message, not in a comment).
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, createTranslator } from '../../i18n'
import { GoalActivePanel } from './GoalActivePanel'
import { resumeGoalSessionId, shouldResumeGoalOnUserMessage } from './goalState'
import { translateGoalReason } from './goalReason'
import type { GoalEvaluationResult, GoalState } from '../../../shared/types'

afterEach(cleanup)

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'goal-1',
    objective: 'Fetch from https://example.invalid/data',
    status: 'paused',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnsRun: 2,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    noProgressCount: 0,
    recentFingerprints: [],
    accessMode: 'approval',
    workingDirectory: '/tmp',
    skills: [],
    ownerConversationId: 'conv-owner',
    ...overrides,
  }
}

const IMPOSSIBLE_EVAL: GoalEvaluationResult = {
  decision: 'pause',
  reasonId: 'taskImpossible',
  reason: 'The URL uses the reserved .invalid TLD — no HTTP fetch can ever succeed.',
  gaps: [],
  confidence: 0.95,
}

// ─── 1. Session rehydration (item 1) ────────────────────────────────
describe('resumeGoalSessionId — retomar após REINÍCIO usa a sessão ANTIGA', () => {
  it('restart (no live session): falls back to the PERSISTED lastSessionId — never a silent new session', () => {
    const goal = makeGoal({ lastSessionId: 'sess-old-123' })
    // COUNTERFACTUAL: if this returned undefined, sendTrackedTurn would
    // open a NEW session and the model would start from zero while the
    // user believes it continued — the exact defect being fixed.
    expect(resumeGoalSessionId(goal, undefined)).toBe('sess-old-123')
    expect(resumeGoalSessionId(goal, undefined)).not.toBeUndefined()
  })

  it('in-app pause (live session present): the LIVE session always wins — never clobbered by a stale persisted id', () => {
    const goal = makeGoal({ lastSessionId: 'sess-old-123' })
    expect(resumeGoalSessionId(goal, 'sess-live-456')).toBe('sess-live-456')
  })

  it('legacy goal without lastSessionId and no live session: undefined — a fresh session is CORRECT here (nothing to lose)', () => {
    const goal = makeGoal()
    delete goal.lastSessionId
    expect(resumeGoalSessionId(goal, undefined)).toBeUndefined()
  })
})

// ─── 2. Reply resumes (item 2) ──────────────────────────────────────
describe('shouldResumeGoalOnUserMessage — responder no composer retoma SÓ a pausa taskImpossible', () => {
  it('paused by taskImpossible on the OWNER conversation: reply resumes', () => {
    const goal = makeGoal({ status: 'paused', pauseReason: 'taskImpossible' })
    expect(shouldResumeGoalOnUserMessage(goal, 'conv-owner')).toBe(true)
  })

  it('COUNTERFACTUAL: paused by ANY OTHER reason — a reply must NOT resume by accident', () => {
    // userPaused/unsafe/batchStagnation keep explicit-resume semantics.
    for (const pauseReason of ['userPaused', 'unsafe', 'batchStagnation', 'infraError', 'goalError']) {
      const goal = makeGoal({ status: 'paused', pauseReason })
      expect(
        shouldResumeGoalOnUserMessage(goal, 'conv-owner'),
        `pauseReason ${pauseReason} must NOT auto-resume on a reply`,
      ).toBe(false)
    }
  })

  it('COUNTERFACTUAL: an ACTIVE goal is never re-triggered by a normal message', () => {
    const goal = makeGoal({ status: 'active', pauseReason: undefined })
    expect(shouldResumeGoalOnUserMessage(goal, 'conv-owner')).toBe(false)
  })

  it('POSSE: a reply in ANOTHER conversation does not drive the goal (G-C8)', () => {
    const goal = makeGoal({ status: 'paused', pauseReason: 'taskImpossible' })
    expect(shouldResumeGoalOnUserMessage(goal, 'conv-other')).toBe(false)
  })

  it('no goal at all: false', () => {
    expect(shouldResumeGoalOnUserMessage(undefined, 'conv-owner')).toBe(false)
  })
})

// ─── 3. Translation pin (item 3) ────────────────────────────────────
describe('translateGoalReason — taskImpossible traduzido nas DUAS locales, nunca o literal cru', () => {
  it('en-US', () => {
    expect(translateGoalReason('taskImpossible', createTranslator('en-US'))).toBe('Task reported as impossible')
  })

  it('pt-BR', () => {
    expect(translateGoalReason('taskImpossible', createTranslator('pt-BR'))).toBe('Tarefa relatada como impossível')
  })

  it('never falls through to the raw literal or the unknown placeholder', () => {
    for (const lang of ['en-US', 'pt-BR'] as const) {
      const translated = translateGoalReason('taskImpossible', createTranslator(lang))
      expect(translated).not.toBe('taskImpossible')
      expect(translated).not.toBe(createTranslator(lang)('goal.reasonId.unknown'))
    }
  })
})

// ─── 4. The pause MESSAGE in the real DOM (item 4) ──────────────────
describe('GoalActivePanel — a mensagem de pausa taskImpossible CHEGA À TELA (render real)', () => {
  function renderPanel(goal: GoalState, language: 'en-US' | 'pt-BR' = 'en-US') {
    render(
      <I18nProvider language={language}>
        <GoalActivePanel
          goal={goal}
          turnInProgress={false}
          onEditObjective={vi.fn()}
          onPause={vi.fn()}
          onResume={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    )
  }

  it('en-US: the legible reason AND the contract sentence are visible', () => {
    renderPanel(makeGoal({ pauseReason: 'taskImpossible', lastEvaluation: IMPOSSIBLE_EVAL }))
    // The evaluator's human-legible reason — not just a generic label.
    expect(screen.getByText(/reserved \.invalid TLD/)).toBeTruthy()
    // THE CONTRACT, declared in the message: reply resumes THIS SAME
    // task; changing the task means cancel + relaunch.
    expect(screen.getByText(/resumes THIS SAME task with your guidance/)).toBeTruthy()
    expect(screen.getByText(/cancel and relaunch the batch/)).toBeTruthy()
  })

  it('pt-BR: o motivo legível E a frase do contrato estão visíveis', () => {
    renderPanel(
      makeGoal({ pauseReason: 'taskImpossible', lastEvaluation: IMPOSSIBLE_EVAL }),
      'pt-BR',
    )
    expect(screen.getByText(/reserved \.invalid TLD/)).toBeTruthy()
    expect(screen.getByText(/retoma ESTA MESMA tarefa com a sua orientação/)).toBeTruthy()
    expect(screen.getByText(/cancele e relance o lote/)).toBeTruthy()
  })

  it('NEGATIVE: a pause for ANY OTHER reason does NOT show the contract', () => {
    // The message is scoped to taskImpossible — a userPaused goal must
    // not grow a reply-to-resume instruction it does not honor.
    renderPanel(makeGoal({ pauseReason: 'userPaused' }))
    expect(screen.queryByText(/THIS SAME task/)).toBeNull()
    expect(document.querySelector('.goal-active-panel-impossible-detail')).toBeNull()
  })

  it('NEGATIVE anti-noise: ONE quiet text block — no box, no badge, no per-line elements', () => {
    renderPanel(makeGoal({ pauseReason: 'taskImpossible', lastEvaluation: IMPOSSIBLE_EVAL }))
    const blocks = document.querySelectorAll('.goal-active-panel-impossible-detail')
    expect(
      blocks.length,
      'The pause message must be a single text block in the panel — a separate box/badge is the noise class the user vetoed.',
    ).toBe(1)
    // And it is plain text on the calm surface: no dedicated background
    // container (the vetoed green-box shape).
    expect(document.querySelector('.goal-active-panel-impossible-detail')?.className).toBe(
      'goal-active-panel-impossible-detail',
    )
  })

  it('compact strip: the detail stays out (one chevron away) but the translated label still shows', () => {
    render(
      <I18nProvider language="en-US">
        <GoalActivePanel
          goal={makeGoal({ pauseReason: 'taskImpossible', lastEvaluation: IMPOSSIBLE_EVAL })}
          turnInProgress={false}
          compact
          onEditObjective={vi.fn()}
          onPause={vi.fn()}
          onResume={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    )
    expect(document.querySelector('.goal-active-panel-impossible-detail')).toBeNull()
    expect(screen.getByText('Task reported as impossible')).toBeTruthy()
  })

  it('missing lastEvaluation: the message still renders with the translated label as reason — never empty, never "undefined"', () => {
    const goal = makeGoal({ pauseReason: 'taskImpossible' })
    delete goal.lastEvaluation
    renderPanel(goal)
    // The label appears (header span AND as the body's reason fallback —
    // both legitimate); what matters is WHERE the message lands.
    const detail = document.querySelector('.goal-active-panel-impossible-detail')
    expect(detail?.textContent).toContain('Task reported as impossible')
    expect(detail?.textContent).not.toContain('undefined')
    expect(screen.queryByText('undefined')).toBeNull()
    // And the contract is still there — the user must know how to
    // unblock even when the model gave no prose.
    expect(screen.getByText(/resumes THIS SAME task/)).toBeTruthy()
  })
})
