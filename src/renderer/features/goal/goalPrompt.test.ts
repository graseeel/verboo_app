import { describe, it, expect } from 'vitest'
import type { GoalEvaluationResult, GoalState } from '../../../shared/types'
import type { Translator } from '../../i18n'
import { buildContinuePrompt, buildCompletionMessage, buildObjectiveUpdatedPrompt, formatTokenCount, formatElapsedMs, buildUsageSummary, buildGoalUsageLine } from './goalPrompt'
import { accumulateEvaluatorUsage } from './tokenAccumulator'

/**
 * Minimal Translator mock for buildGoalUsageLine tests.
 * Maps the goal-completion i18n keys to their pt-BR templates (mirrors
 * i18n.tsx) and interpolates {tokens}/{elapsed}. This lets the tests
 * assert on the rendered text shape without pulling the full i18n
 * provider. Keys not in the map fall through to the key itself.
 */
const PT_BR_TEMPLATES: Record<string, string> = {
  'goal.completedHeading': 'Objetivo concluído',
  'goal.totalUsage': 'Total registrado: {tokens} tokens; tempo aproximado: {elapsed}',
  'goal.totalUsageTokens': 'Total registrado: {tokens} tokens',
  'goal.completedUsage': 'Uso registrado: {tokens} tokens; tempo aproximado: {elapsed}',
  'goal.completedUsageTokens': 'Uso registrado: {tokens} tokens',
}
const tMock: Translator = ((key: string, params?: Record<string, string | number | undefined>) => {
  const template = PT_BR_TEMPLATES[key] ?? key
  if (!params) return template
  return Object.entries(params).reduce(
    (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
    template,
  )
}) as Translator

const baseEval: GoalEvaluationResult = {
  decision: 'continue',
  reasonId: 'taskIncomplete',
  reason: 'Still working on the API endpoint',
  sessionSummary: 'Wrote the route handler and added a unit test.',
  gaps: ['Add error handling for 404', 'Wire up the database call'],
  nextAction: 'Implement the 404 branch in getUserHandler',
  completionSummary: undefined,
  confidence: 0.8,
}

describe('buildContinuePrompt', () => {
  it('includes the objective as a heading', () => {
    const prompt = buildContinuePrompt({
      objective: 'Ship the login endpoint',
      evaluation: baseEval,
    })
    expect(prompt).toContain('## Continuing toward: Ship the login endpoint')
  })

  it('includes sessionSummary, gaps, nextAction, and reason when present', () => {
    const prompt = buildContinuePrompt({
      objective: 'Ship the login endpoint',
      evaluation: baseEval,
    })
    expect(prompt).toContain('**Session summary:**')
    expect(prompt).toContain('Wrote the route handler and added a unit test.')
    expect(prompt).toContain('**Remaining gaps:**')
    expect(prompt).toContain('- Add error handling for 404')
    expect(prompt).toContain('- Wire up the database call')
    expect(prompt).toContain('**Next action:**')
    expect(prompt).toContain('Implement the 404 branch in getUserHandler')
    expect(prompt).toContain('**Reason:**')
    expect(prompt).toContain('Still working on the API endpoint')
  })

  it('omits empty optional sections instead of leaving blank headers', () => {
    const prompt = buildContinuePrompt({
      objective: 'Minimal objective',
      evaluation: {
        decision: 'continue',
        reasonId: 'taskIncomplete',
        reason: '',
        sessionSummary: undefined,
        gaps: [],
        nextAction: undefined,
        completionSummary: undefined,
        confidence: 0.5,
      },
    })
    expect(prompt).not.toContain('**Session summary:**')
    expect(prompt).not.toContain('**Remaining gaps:**')
    expect(prompt).not.toContain('**Next action:**')
    expect(prompt).not.toContain('**Reason:**')
    // Always includes the autonomy directive
    expect(prompt).toContain('Continue autonomously')
  })

  it('appends working directory when provided', () => {
    const prompt = buildContinuePrompt({
      objective: 'Test objective',
      evaluation: { ...baseEval, gaps: [] },
      workingDirectory: '/tmp/project',
    })
    expect(prompt).toContain('Working directory: /tmp/project')
  })

  it('trims whitespace from each field before emitting', () => {
    const prompt = buildContinuePrompt({
      objective: 'Trim test',
      evaluation: {
        decision: 'continue',
        reasonId: 'taskIncomplete',
        reason: '  padded reason  ',
        sessionSummary: '  padded summary  ',
        gaps: ['  padded gap  ', '', '  '],
        nextAction: '  padded action  ',
        completionSummary: undefined,
        confidence: 0.5,
      },
    })
    expect(prompt).toContain('**Session summary:** padded summary')
    expect(prompt).toContain('**Next action:** padded action')
    expect(prompt).toContain('**Reason:** padded reason')
    // Empty/whitespace-only gaps are dropped
    expect(prompt).not.toContain('-   ')
    expect(prompt).toContain('- padded gap')
  })
})

describe('buildCompletionMessage', () => {
  it('uses completionSummary as the card content', () => {
    const message = buildCompletionMessage({
      ...baseEval,
      decision: 'complete',
      reasonId: 'done',
      completionSummary: 'All endpoints shipped and tests green.',
    })
    expect(message).toBe('All endpoints shipped and tests green.')
  })

  it('falls back to reason when completionSummary is absent', () => {
    const message = buildCompletionMessage({
      ...baseEval,
      decision: 'complete',
      reasonId: 'done',
      completionSummary: undefined,
      reason: 'Objective met.',
    })
    expect(message).toBe('Objective met.')
  })

  it('does NOT use gaps as evidence (gaps = remaining work, empty on completion)', () => {
    const message = buildCompletionMessage({
      ...baseEval,
      decision: 'complete',
      reasonId: 'done',
      completionSummary: 'Done.',
      gaps: ['gap1', 'gap2', 'gap3', 'gap4'],
    })
    expect(message).toBe('Done.')
    expect(message).not.toContain('gap1')
    expect(message).not.toContain('- ')
  })

  it('preserves multi-line completionSummary (evaluator controls formatting)', () => {
    const message = buildCompletionMessage({
      ...baseEval,
      decision: 'complete',
      reasonId: 'done',
      completionSummary: 'First line.\nSecond line.',
      gaps: [],
    })
    expect(message).toBe('First line.\nSecond line.')
  })

  it('returns empty string when no summary or reason is present', () => {
    const message = buildCompletionMessage({
      ...baseEval,
      decision: 'complete',
      reasonId: 'done',
      completionSummary: undefined,
      reason: '',
      gaps: [],
    })
    expect(message).toBe('')
  })
})

describe('buildObjectiveUpdatedPrompt', () => {
  it('includes the new objective', () => {
    const prompt = buildObjectiveUpdatedPrompt('Ship the payment integration')
    expect(prompt).toContain('Ship the payment integration')
    expect(prompt).toContain('NEW objective')
  })

  it('instructs the model to continue from current work, not restart', () => {
    const prompt = buildObjectiveUpdatedPrompt('New goal')
    expect(prompt).toContain('Continue from the current work')
    expect(prompt).toContain('Do not restart from scratch')
  })
})

describe('G-C10 item 3b: formatTokenCount', () => {
  it('formats with thousand separators (pt-BR uses period)', () => {
    expect(formatTokenCount(569180)).toBe('569.180')
    expect(formatTokenCount(1000000)).toBe('1.000.000')
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1000)).toBe('1.000')
  })

  it('does NOT return a bare unseparated number', () => {
    // The whole point of the formatter: 569180 → "569.180", not "569180".
    expect(formatTokenCount(569180)).not.toBe('569180')
    expect(formatTokenCount(569180)).not.toMatch(/^\d{6,}$/)
  })
})

describe('G-C10 item 3b: formatElapsedMs', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatElapsedMs(0)).toBe('0s')
    expect(formatElapsedMs(999)).toBe('0s')
    expect(formatElapsedMs(1000)).toBe('1s')
    expect(formatElapsedMs(59000)).toBe('59s')
  })

  it('formats minute durations as Xmin Ys', () => {
    expect(formatElapsedMs(60000)).toBe('1min0s')
    expect(formatElapsedMs(89000)).toBe('1min29s')
    expect(formatElapsedMs(1460000)).toBe('24min20s')
  })

  it('rejects non-finite and negative inputs', () => {
    expect(formatElapsedMs(Number.NaN)).toBe('0s')
    expect(formatElapsedMs(Number.POSITIVE_INFINITY)).toBe('0s')
    expect(formatElapsedMs(-1000)).toBe('0s')
  })
})

describe('G-C10 item 3: buildUsageSummary — token survival to completion', () => {
  // The Maestro measured usedInputTokens=0 and usedOutputTokens=0 in
  // the store after a goal completed with turnsRun=2 and real token
  // consumption. The root cause was a ref/state desync: the token
  // accumulator at App.tsx:1810 called setGoal without synchronizing
  // goalRef.current, so the scheduler (which reads via delegate.getGoal()
  // → goalRef.current) saw a stale snapshot and the completion write
  // preserved the zeros.
  //
  // buildUsageSummary is the user-facing proof that tokens survived.
  // These tests pin the contract: given a goal with real token counts
  // and real timestamps, the summary must show the real numbers and
  // the real elapsed time — not zeros.

  function makeGoalWithUsage(overrides: Partial<GoalState> = {}): GoalState {
    return {
      id: 'goal-1',
      objective: 'Create /tmp/test.txt',
      status: 'completed',
      createdAt: Date.now() - 89_000,
      updatedAt: Date.now(),
      startedAt: Date.now() - 89_000,
      completedAt: Date.now(),
      turnsRun: 2,
      usedInputTokens: 420_000,
      usedOutputTokens: 149_180,
      noProgressCount: 0,
      recentFingerprints: [],
      accessMode: 'approval',
      workingDirectory: '/tmp',
      skills: [],
      ...overrides,
    }
  }

  it('reports the SUM of input + output tokens with thousand separators', () => {
    const goal = makeGoalWithUsage()
    const summary = buildUsageSummary(goal)
    // 420_000 + 149_180 = 569_180 → "569.180"
    expect(summary).toContain('569.180')
    expect(summary).toContain('tokens')
  })

  it('reports the elapsed time from startedAt to completedAt', () => {
    const startedAt = Date.now() - 89_000
    const completedAt = Date.now()
    const goal = makeGoalWithUsage({ startedAt, completedAt })
    const summary = buildUsageSummary(goal)
    // 89_000 ms = 1min29s
    expect(summary).toContain('1min29s')
    expect(summary).toContain('tempo aproximado')
  })

  it('survives the G-C10 regression: does NOT report zero tokens when the goal consumed real tokens', () => {
    // This is the test the Maestro asked for: prove the tokens survive
    // to completion, not just that the field exists. If the ref/state
    // desync returns, the goal would arrive here with
    // usedInputTokens=0 and usedOutputTokens=0, and the summary would
    // say "0 tokens" — this assertion catches that.
    const goal = makeGoalWithUsage({ usedInputTokens: 569_180, usedOutputTokens: 0 })
    const summary = buildUsageSummary(goal)
    expect(summary).not.toContain('Uso registrado: 0 tokens')
    expect(summary).toContain('569.180')
  })

  it('returns just the tokens part when startedAt or completedAt is missing (legacy goal)', () => {
    const goal = makeGoalWithUsage({ startedAt: undefined, completedAt: undefined })
    const summary = buildUsageSummary(goal)
    expect(summary).not.toContain('tempo aproximado')
    expect(summary).toContain('tokens')
  })

  it('formats the full line in the documented shape', () => {
    const startedAt = Date.now() - 24 * 60 * 1000 - 20 * 1000 // 24min20s
    const completedAt = Date.now()
    const goal = makeGoalWithUsage({
      usedInputTokens: 500_000,
      usedOutputTokens: 69_180,
      startedAt,
      completedAt,
    })
    const summary = buildUsageSummary(goal)
    // Expected: "Uso registrado: 569.180 tokens; tempo aproximado: 24min20s"
    expect(summary).toBe('Uso registrado: 569.180 tokens; tempo aproximado: 24min20s')
  })
})

describe('G-C17: buildGoalUsageLine — ACCUMULATED evaluator tokens (evaluatorInputTokens/evaluatorOutputTokens)', () => {
  // G-C15-FIX placed `evaluatorUsage` as a SIBLING of evaluation in the
  // Tauri boundary struct (GoalEvaluationEnvelope) — NOT inside
  // GoalEvaluationResult (the earlier G-C15-TS adendo read
  // evaluation.evaluatorUsage, a key that never existed).
  //
  // G-C17 replaces the renderer-side STORAGE: the delegate used to keep
  // `lastEvaluatorUsage` (last-write-wins), so in a multi-evaluation
  // goal only the FINAL parcel reached this line while the label read
  // "Total registrado" (QA blocking). The evaluateGoal delegate now
  // ACCUMULATES every evaluation into goal.evaluatorInputTokens /
  // goal.evaluatorOutputTokens (tokenAccumulator.ts), and the
  // scheduler's completion path overlays the fresh totals from the live
  // ref onto finalGoal (goalScheduler.ts G-C17 adendo) so the last
  // evaluation's parcel is included too. buildGoalUsageLine reads those
  // accumulated fields — NOT evaluation.evaluatorUsage.
  //
  // HONEST LABEL (G-C15-FIX item 5, preserved): while the evaluator's
  // tokens are NOT in the total (absent or zero), the label is "Uso
  // registrado" — it cannot promise "Total" because the evaluator's
  // ~1/3 is missing. When the evaluator's tokens ARE present and
  // non-zero, the label switches to "Total registrado".

  function makeCompletedGoal(overrides: Partial<GoalState> = {}): GoalState {
    return {
      id: 'goal-1',
      objective: 'Create /tmp/test.txt',
      status: 'completed',
      createdAt: Date.now() - 89_000,
      updatedAt: Date.now(),
      startedAt: Date.now() - 89_000,
      completedAt: Date.now(),
      turnsRun: 3,
      usedInputTokens: 106_082,
      usedOutputTokens: 102,
      noProgressCount: 0,
      recentFingerprints: [],
      accessMode: 'approval',
      workingDirectory: '/tmp',
      skills: [],
      ...overrides,
    }
  }

  it('returns ONLY the usage line — no heading, no completionSummary', () => {
    const goal = makeCompletedGoal()
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).not.toContain('Objetivo concluído')
    expect(text).not.toContain('Arquivo criado com sucesso.')
    expect(text).toContain('106.184 tokens')
    expect(text).toContain('tempo aproximado')
  })

  it('uses "Uso registrado" label when evaluator tokens are ABSENT (honest — not total)', () => {
    // G-C15-FIX item 5: while the evaluator's tokens are not in the
    // total, the label is "Uso registrado" — it cannot promise "Total".
    // G-C17: ABSENT = the goal carries NO accumulator keys (legacy
    // goal, or an evaluator that never returned usage).
    const goal = makeCompletedGoal()
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toContain('Uso registrado')
    expect(text).not.toContain('Total registrado')
  })

  it('uses "Total registrado" label when evaluator tokens are present and non-zero', () => {
    // When the evaluator's tokens ARE in the total, the label is
    // honest as the full goal cost.
    const goal = makeCompletedGoal({
      evaluatorInputTokens: 30_000,
      evaluatorOutputTokens: 500,
    })
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toContain('Total registrado')
    expect(text).not.toContain('Uso registrado:')
  })

  it('uses "Uso registrado" when evaluatorUsage is present but zero', () => {
    // Edge case: evaluator ran but consumed zero tokens. The label
    // stays "Uso registrado" — the evaluator parcel is not in the
    // total (it's zero, but the label reflects what's measured).
    const goal = makeCompletedGoal({
      evaluatorInputTokens: 0,
      evaluatorOutputTokens: 0,
    })
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toContain('Uso registrado')
    expect(text).not.toContain('Total registrado')
  })

  it('sums the accumulated evaluator parcels into the total (evaluator parcel included)', () => {
    // turn: 106082 + 102 = 106184
    // evaluator (accumulated): 30000 + 500 = 30500
    // total: 136684 → "136.684"
    const goal = makeCompletedGoal({
      evaluatorInputTokens: 30_000,
      evaluatorOutputTokens: 500,
    })
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toContain('136.684 tokens')
  })

  it('tokens-only line when elapsed time is unavailable (G-C13-FIX bifurcation preserved)', () => {
    const goal = makeCompletedGoal({ startedAt: undefined, completedAt: undefined })
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toContain('106.184 tokens')
    expect(text).not.toContain('tempo aproximado')
  })

  it('tokens-only when only completedAt is missing (the G-C13-FIX bug case)', () => {
    const goal = makeCompletedGoal({ completedAt: undefined })
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toContain('106.184 tokens')
    expect(text).not.toContain('tempo aproximado')
  })

  it('returns empty string when tokens are zero (zero-guard)', () => {
    const goal = makeCompletedGoal({ usedInputTokens: 0, usedOutputTokens: 0 })
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toBe('')
  })

  it('returns empty string when both turn and evaluator tokens are zero', () => {
    const goal = makeCompletedGoal({
      usedInputTokens: 0,
      usedOutputTokens: 0,
      evaluatorInputTokens: 0,
      evaluatorOutputTokens: 0,
    })
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toBe('')
  })

  it('produces line when turn tokens are zero but evaluator has usage (total > 0)', () => {
    // Edge case: turn tokens = 0, evaluator tokens > 0. Total > 0,
    // so the line is produced. Proves the zero-guard checks the
    // SUMMED total, not just turn tokens.
    const goal = makeCompletedGoal({
      usedInputTokens: 0,
      usedOutputTokens: 0,
      evaluatorInputTokens: 5_000,
      evaluatorOutputTokens: 100,
    })
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toContain('5.100 tokens')
    expect(text).toContain('Total registrado')
  })

  it('handles partial accumulated usage (only inputTokens, outputTokens absent)', () => {
    const goal = makeCompletedGoal({
      evaluatorInputTokens: 10_000,
    })
    // 106184 + 10000 = 116184
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toContain('116.184 tokens')
  })

  it('handles partial accumulated usage (only outputTokens, inputTokens absent)', () => {
    const goal = makeCompletedGoal({
      evaluatorOutputTokens: 200,
    })
    // 106184 + 200 = 106384
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toContain('106.384 tokens')
  })

  it('handles absent accumulator keys (undefined, not null) — total is just turn tokens', () => {
    // Legacy goals persisted before G-C17 lack the accumulator keys
    // entirely — on the TS side they read as undefined (not null),
    // the same absence lesson as the Rust skip_serializing_if
    // omission. The function must not crash nor produce NaN.
    const goal = makeCompletedGoal()
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toContain('106.184 tokens')
    expect(text).toContain('Uso registrado')
  })

  it('G-C17 end-to-end: TWO accumulated evaluations reach the LINE (not just the store) with "Total registrado"', () => {
    // The handoff's standing question: does the test prove the
    // information REACHES THE SCREEN, or only that it is ASSEMBLED?
    // This chains the real accumulation helper (what the App.tsx
    // delegate calls per evaluation) into the real line builder (what
    // onComplete renders). turn: 106082 + 102 = 106184; evaluations:
    // 30_000+500 and 32_000+600 → 63_100; total: 169_284.
    let goal = makeCompletedGoal({ usedInputTokens: 106_082, usedOutputTokens: 102 })
    goal = accumulateEvaluatorUsage(goal, { inputTokens: 30_000, outputTokens: 500 })
    goal = accumulateEvaluatorUsage(goal, { inputTokens: 32_000, outputTokens: 600 })
    const text = buildGoalUsageLine(goal, tMock)
    expect(text).toContain('169.284 tokens')
    expect(text).toContain('Total registrado')
    // The G-C17 bug shape: only the LAST parcel (32_600) would show
    // → 138.784. Pin the exact wrong number so a regression to
    // last-write-wins fails loudly.
    expect(text).not.toContain('138.784 tokens')
  })
})
