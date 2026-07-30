import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../../i18n'
import { GoalActivePanel } from './GoalActivePanel'
import type { GoalEvaluationResult, GoalState } from '../../../shared/types'

afterEach(cleanup)

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'goal-1',
    objective: 'Create /tmp/test.txt',
    status: 'paused',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnsRun: 0,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    noProgressCount: 0,
    recentFingerprints: [],
    accessMode: 'approval',
    workingDirectory: '/tmp',
    skills: [],
    ...overrides,
  }
}

function makeEvaluation(overrides: Partial<GoalEvaluationResult> = {}): GoalEvaluationResult {
  return {
    decision: 'pause',
    reasonId: 'infraError',
    reason: 'Goal evaluator CLI timed out after 240s',
    gaps: [],
    confidence: 0,
    ...overrides,
  }
}

function renderPanel(goal: GoalState) {
  render(
    <I18nProvider language="en-US">
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

describe('GoalActivePanel — evaluator error message (G-C6-FIX-UI)', () => {
  // Regression: the Rust evaluator emits a useful timeout/failure
  // reason stored in goal.lastEvaluation.reason, but the panel never
  // rendered it — the user saw only the generic "Erro de
  // infraestrutura do avaliador". These tests prove the specific
  // message reaches the DOM.

  it('renders the specific evaluator error message when paused by infraError', () => {
    const goal = makeGoal({
      pauseReason: 'infraError',
      lastEvaluation: makeEvaluation({ reason: 'Goal evaluator CLI timed out after 240s' }),
    })
    renderPanel(goal)

    // The specific timeout message must reach the DOM — not just the
    // generic "Evaluator infrastructure error" label.
    expect(screen.getByText(/Goal evaluator CLI timed out after 240s/)).toBeTruthy()
  })

  it('falls back to generic label when lastEvaluation is absent', () => {
    // No lastEvaluation at all (e.g. legacy goal paused before the
    // scheduler started synthesizing one). Must NOT render an empty
    // string or "undefined" — the generic pauseReason label still
    // shows, and no detail line appears.
    const goal = makeGoal({ pauseReason: 'infraError' })
    delete goal.lastEvaluation
    renderPanel(goal)

    // Generic label still present (translated reasonId).
    expect(screen.getByText(/Evaluator infrastructure error|infraError/i)).toBeTruthy()
    // No detail line with "Last error:" should appear.
    expect(screen.queryByText(/Last error:/)).toBeNull()
  })

  it('falls back to generic label when lastEvaluation.reason is empty', () => {
    const goal = makeGoal({
      pauseReason: 'infraError',
      lastEvaluation: makeEvaluation({ reason: '' }),
    })
    renderPanel(goal)

    // Generic label still present.
    expect(screen.getByText(/Evaluator infrastructure error|infraError/i)).toBeTruthy()
    // No detail line.
    expect(screen.queryByText(/Last error:/)).toBeNull()
  })

  it('does NOT render the error detail when paused for a non-infraError reason', () => {
    // A goal paused by 'userPaused' should not show the evaluator
    // error detail even if lastEvaluation happens to be present.
    const goal = makeGoal({
      pauseReason: 'userPaused',
      lastEvaluation: makeEvaluation({ reason: 'Some stale reason' }),
    })
    renderPanel(goal)

    // The stale reason must NOT appear in the DOM.
    expect(screen.queryByText(/Some stale reason/)).toBeNull()
  })
})
