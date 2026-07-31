import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

describe('GoalActivePanel — T4 batch states', () => {
  function renderPanelIn(goal: GoalState, language: 'en-US' | 'pt-BR') {
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

  it('paused by batchStagnation shows the TRANSLATED reason, never the raw literal (both locales)', () => {
    // T2 shipped pauseReason 'batchStagnation' with no translator entry:
    // the panel rendered the raw camelCase literal via the free-form
    // passthrough. Pin the fix in the REAL DOM, both locales.
    const goal = makeGoal({ pauseReason: 'batchStagnation' })

    renderPanelIn(goal, 'en-US')
    expect(screen.getByText('Batch paused after repeated task failures')).toBeTruthy()
    expect(screen.queryByText(/batchStagnation/)).toBeNull()
    cleanup()

    renderPanelIn(goal, 'pt-BR')
    expect(screen.getByText('Lote pausado após falhas repetidas de tarefa')).toBeTruthy()
    expect(screen.queryByText(/batchStagnation/)).toBeNull()
  })

  it('a batch ACTIVE with a failed task still shows the running label — no impossible state', () => {
    // T2 row 8: a loop-killed task fails but the batch STAYS ACTIVE and
    // advances. The panel maps goal.status — 'active' — so it must show
    // the running label, never a paused/blocked reason for a batch that
    // is in fact working.
    const goal = makeGoal({
      status: 'active',
      pauseReason: undefined,
      tasks: [
        { id: 't1', text: 'Stuck task', status: 'failed', failureReason: 'loop', turns: 2 },
        { id: 't2', text: 'Current task', status: 'active' },
      ],
      taskIndex: 1,
    })
    renderPanelIn(goal, 'en-US')

    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.queryByText('Paused')).toBeNull()
    // And no reason span leaks into an active panel.
    expect(screen.queryByText(/batchStagnation|Possible loop/i)).toBeNull()
  })
})

describe('GoalActivePanel — T5 batch edit lock (v1)', () => {
  // Veto→assertion pattern (T4): the v1 limitation is DECLARED, not
  // silent. The edit affordance stays VISIBLE but disabled, with the
  // reason as tooltip — a clear warning, never a mysterious disappearance.

  function makeBatchGoal(): GoalState {
    return makeGoal({
      status: 'active',
      tasks: [
        { id: 't1', text: 'First task', status: 'active' },
        { id: 't2', text: 'Second task', status: 'pending' },
      ],
      taskIndex: 0,
    })
  }

  it('batch goal: full-panel edit button is DISABLED with the v1 reason as tooltip (both locales)', () => {
    renderPanel(makeBatchGoal())
    const button = screen.getByRole('button', {
      name: 'Objective editing is disabled while a batch runs (v1)',
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Objective editing is disabled while a batch runs (v1)')
    // quieter redesign (BY DESIGN, declared in the diff): actions are
    // icon-only now — the visible "Edit objective" caption is GONE, the
    // wording survives as aria-label/tooltip. Pin the absence so nobody
    // reintroduces a labeled button without reading this.
    expect(screen.queryByText('Edit objective')).toBeNull()
    cleanup()

    render(
      <I18nProvider language="pt-BR">
        <GoalActivePanel
          goal={makeBatchGoal()}
          turnInProgress={false}
          onEditObjective={vi.fn()}
          onPause={vi.fn()}
          onResume={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    )
    const buttonPt = screen.getByRole('button', {
      name: 'Edição de objetivo desabilitada durante um lote (v1)',
    }) as HTMLButtonElement
    expect(buttonPt.disabled).toBe(true)
    expect(buttonPt.title).toBe('Edição de objetivo desabilitada durante um lote (v1)')
  })

  it('batch goal: clicking the disabled button does NOT enter edit mode nor call onEditObjective', () => {
    const onEditObjective = vi.fn()
    render(
      <I18nProvider language="en-US">
        <GoalActivePanel
          goal={makeBatchGoal()}
          turnInProgress={false}
          onEditObjective={onEditObjective}
          onPause={vi.fn()}
          onResume={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    )
    const button = screen.getByRole('button', {
      name: 'Objective editing is disabled while a batch runs (v1)',
    })
    fireEvent.click(button)
    // EFEITO: no edit textarea opens, no callback fires.
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onEditObjective).not.toHaveBeenCalled()
  })

  it('batch goal: compact-panel pencil button is disabled too', () => {
    render(
      <I18nProvider language="en-US">
        <GoalActivePanel
          goal={makeBatchGoal()}
          turnInProgress={false}
          compact
          onEditObjective={vi.fn()}
          onPause={vi.fn()}
          onResume={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    )
    const button = screen.getByRole('button', {
      name: 'Objective editing is disabled while a batch runs (v1)',
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('NEGATIVE: a non-batch goal keeps the edit button ENABLED with its original label', () => {
    // The lock must be scoped to batches — a legacy single-task goal
    // edits exactly as before (aceite d, zero regression).
    renderPanel(makeGoal({ status: 'active' }))
    const button = screen.getByRole('button', { name: 'Edit objective' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.title).not.toBe('Objective editing is disabled while a batch runs (v1)')
  })
})

describe('GoalActivePanel — quieter redesign (user request)', () => {
  // The user called the old panel "MUITO GRITANTE": purple card, uppercase
  // status pill, uppercase OBJECTIVE label, labeled buttons with a red
  // Cancel. These tests pin the QUIET contract in the real DOM — what
  // appears AND what must never come back. Note the declared limit:
  // jsdom cannot evaluate stylesheets, so visual quiet (neutral surface,
  // muted danger) is pinned via the styling-hook classes that ARE the
  // documented CSS contract in goal.css.

  it('status is dot + discreet text — the uppercase pill is gone, the dot is the state signal', () => {
    renderPanel(makeGoal({ status: 'evaluating' }))
    // The status text itself still reaches the user…
    expect(screen.getByText('Evaluating')).toBeTruthy()
    // …carried by the dot structure that replaced the pill…
    const dot = document.querySelector('.goal-active-panel-status.evaluating .goal-active-panel-status-dot')
    expect(dot).toBeTruthy()
    // …and the old pill's building blocks are NOT in the DOM anymore:
    // no separate status chip element, no OBJECTIVE label.
    expect(screen.queryByText('Objective')).toBeNull()
  })

  it('the uppercase OBJECTIVE label is gone — objective text stands on its own', () => {
    renderPanel(makeGoal({ status: 'active' }))
    expect(screen.getByText('Create /tmp/test.txt')).toBeTruthy()
    expect(screen.queryByText('Objective')).toBeNull()
    expect(document.querySelector('.goal-active-panel-objective-label')).toBeNull()
  })

  it('actions are icon-only: no visible Pause / Cancel goal captions, buttons still reachable by name', () => {
    renderPanel(makeGoal({ status: 'active' }))
    // NEGATIVE pins — the labeled-button row must not come back.
    expect(screen.queryByText('Pause')).toBeNull()
    expect(screen.queryByText('Cancel goal')).toBeNull()
    // POSITIVE — every action still exists, discoverable via aria-label
    // (a11y) and tooltip, in the icon-button vocabulary (styling hook).
    for (const name of ['Edit objective', 'Pause', 'Cancel goal']) {
      const button = screen.getByRole('button', { name })
      expect(button.className).toContain('goal-panel-icon-button')
    }
  })

  it('paused state: resume uses the primary (accent) icon button, cancel keeps the muted-danger hook', () => {
    renderPanel(makeGoal({ status: 'paused', pauseReason: 'userPaused' }))
    const resume = screen.getByRole('button', { name: 'Resume' })
    expect(resume.className).toContain('goal-panel-icon-button primary')
    const cancel = screen.getByRole('button', { name: 'Cancel goal' })
    expect(cancel.className).toContain('goal-panel-icon-button danger')
    // The dot signals paused (muted) instead of the old gray pill.
    expect(document.querySelector('.goal-active-panel-status.paused .goal-active-panel-status-dot')).toBeTruthy()
  })

  it('compact strip carries the same quiet status vocabulary', () => {
    render(
      <I18nProvider language="en-US">
        <GoalActivePanel
          goal={makeGoal({ status: 'continuing' })}
          turnInProgress={false}
          compact
          onEditObjective={vi.fn()}
          onPause={vi.fn()}
          onResume={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    )
    expect(screen.getByText('Continuing')).toBeTruthy()
    expect(document.querySelector('.goal-active-panel-status.continuing .goal-active-panel-status-dot')).toBeTruthy()
  })
})

describe('GoalActivePanel — batch title is the user message verbatim (user request)', () => {
  // The user rejected the synthetic umbrella ("Lote de 4 tarefas") as
  // title: the panel must show the message HE typed, line breaks
  // included, so he recognizes his own request. The umbrella keeps
  // existing in goal.objective for system messages — it must NOT leak
  // into the panel.

  const RAW_INPUT = '1. Fix the login bug\n2. Refactor the batch parser\n3. Write the migration tests'

  function makeTitledBatchGoal(): GoalState {
    return makeGoal({
      status: 'active',
      // What App.tsx actually produces: umbrella in objective, raw
      // multi-line message in batchInput.
      objective: 'Batch of 3 tasks',
      batchInput: RAW_INPUT,
      tasks: [
        { id: 't1', text: 'Fix the login bug', status: 'active' },
        { id: 't2', text: 'Refactor the batch parser', status: 'pending' },
        { id: 't3', text: 'Write the migration tests', status: 'pending' },
      ],
      taskIndex: 0,
    })
  }

  it('full panel shows the RAW multi-line message — first, middle and last lines all reach the DOM', () => {
    renderPanel(makeTitledBatchGoal())
    // Verbatim: markers and all — this is "literalmente a mensagem".
    expect(screen.getByText(/1\. Fix the login bug/)).toBeTruthy()
    expect(screen.getByText(/2\. Refactor the batch parser/)).toBeTruthy()
    expect(screen.getByText(/3\. Write the migration tests/)).toBeTruthy()
    // The text node preserves the user's line breaks (pre-line CSS
    // renders them; jsdom pins the source contract in the DOM).
    const objectiveEl = document.querySelector('.goal-active-panel-objective-text')
    expect(objectiveEl?.textContent).toBe(RAW_INPUT)
  })

  it('NEGATIVE: the synthetic umbrella never appears in the panel', () => {
    renderPanel(makeTitledBatchGoal())
    expect(screen.queryByText(/Batch of 3 tasks/)).toBeNull()
  })

  it('NEGATIVE: still ONE quiet surface — the multi-line message does NOT become one box per line', () => {
    // Veto-history pin (the user rejected noise boxes twice this cycle):
    // the message renders in the SAME single objective element a
    // single-task goal uses. If someone "improves" this into per-task
    // rows/badges, this breaks with a message explaining why.
    renderPanel(makeTitledBatchGoal())
    const objectiveBlocks = document.querySelectorAll('.goal-active-panel-objective-text')
    expect(
      objectiveBlocks.length,
      'The batch message must render as ONE objective element — per-line boxes are the noise class the user rejected.',
    ).toBe(1)
    // And the panel itself is still the single .goal-active-panel card.
    expect(document.querySelectorAll('.goal-active-panel').length).toBe(1)
  })

  it('compact strip shows the raw message too, with the FULL multi-line text in the tooltip', () => {
    render(
      <I18nProvider language="en-US">
        <GoalActivePanel
          goal={makeTitledBatchGoal()}
          turnInProgress={false}
          compact
          onEditObjective={vi.fn()}
          onPause={vi.fn()}
          onResume={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    )
    const objectiveEl = document.querySelector('.goal-active-panel-compact-objective') as HTMLElement
    expect(objectiveEl).toBeTruthy()
    // The strip truncates visually (CSS ellipsis) but the source text is
    // the user's message, not the umbrella…
    expect(objectiveEl.textContent).toBe(RAW_INPUT)
    // …and the tooltip carries the COMPLETE message (every line), so
    // nothing of his request is hidden behind the truncation.
    expect(objectiveEl.title).toBe(RAW_INPUT)
    expect(screen.queryByText(/Batch of 3 tasks/)).toBeNull()
  })

  it('coherence: a single-task goal (no batchInput) shows its objective exactly as before', () => {
    // Same surface, same rule in both cases: what the user typed.
    renderPanel(makeGoal({ status: 'active', objective: 'Create /tmp/test.txt' }))
    const objectiveEl = document.querySelector('.goal-active-panel-objective-text')
    expect(objectiveEl?.textContent).toBe('Create /tmp/test.txt')
  })
})

describe('GoalActivePanel — leaving prop (genie exit)', () => {
  // useGoalPanelExit keeps the panel mounted briefly after the goal
  // turns terminal; `leaving` is the styling hook the genie-out CSS
  // hangs on (and its pointer-events:none guard).

  it('full panel root carries the leaving class when leaving is set', () => {
    render(
      <I18nProvider language="en-US">
        <GoalActivePanel
          goal={makeGoal({ status: 'active' })}
          turnInProgress={false}
          leaving
          onEditObjective={vi.fn()}
          onPause={vi.fn()}
          onResume={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    )
    const root = document.querySelector('.goal-active-panel.leaving')
    expect(root).toBeTruthy()
  })

  it('compact strip root carries the leaving class too', () => {
    render(
      <I18nProvider language="en-US">
        <GoalActivePanel
          goal={makeGoal({ status: 'active' })}
          turnInProgress={false}
          compact
          leaving
          onEditObjective={vi.fn()}
          onPause={vi.fn()}
          onResume={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    )
    expect(document.querySelector('.goal-active-panel.compact.leaving')).toBeTruthy()
  })

  it('NEGATIVE: without leaving the class is absent (no accidental exit state)', () => {
    renderPanel(makeGoal({ status: 'active' }))
    expect(document.querySelector('.goal-active-panel.leaving')).toBeNull()
  })
})
