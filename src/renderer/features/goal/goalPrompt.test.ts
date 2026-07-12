import { describe, it, expect } from 'vitest'
import type { GoalEvaluationResult } from '../../../shared/types'
import { buildContinuePrompt, buildCompletionMessage, buildObjectiveUpdatedPrompt } from './goalPrompt'

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
