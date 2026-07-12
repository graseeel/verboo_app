import { describe, it, expect } from 'vitest'
import type { Translator } from '../../i18n'
import {
  translateGoalReasonById,
  translateGoalReason,
  isInfraError,
} from './goalReason'

/**
 * Stub translator: returns the key verbatim (with params interpolated)
 * so tests can assert which i18n key was selected without depending on
 * the real translation table.
 */
const t: Translator = ((key: string, params?: Record<string, unknown>) => {
  if (!params) return key
  return key + ':' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')
}) as Translator

describe('translateGoalReasonById', () => {
  it('translates each known reasonId to its i18n key', () => {
    expect(translateGoalReasonById('taskIncomplete', t)).toBe('goal.reasonId.taskIncomplete')
    expect(translateGoalReasonById('taskFailure', t)).toBe('goal.reasonId.taskFailure')
    expect(translateGoalReasonById('unsafe', t)).toBe('goal.reasonId.unsafe')
    expect(translateGoalReasonById('needsUser', t)).toBe('goal.reasonId.needsUser')
    expect(translateGoalReasonById('done', t)).toBe('goal.reasonId.done')
    expect(translateGoalReasonById('infraError', t)).toBe('goal.reasonId.infraError')
  })

  it('falls back to unknown for undefined or unrecognized ids', () => {
    expect(translateGoalReasonById(undefined, t)).toBe('goal.reasonId.unknown')
    expect(translateGoalReasonById('notARealId', t)).toBe('goal.reasonId.unknown')
  })
})

describe('isInfraError', () => {
  it('returns true only for infraError', () => {
    expect(isInfraError('infraError')).toBe(true)
    expect(isInfraError('taskIncomplete')).toBe(false)
    expect(isInfraError('unsafe')).toBe(false)
    expect(isInfraError(undefined)).toBe(false)
  })
})

describe('translateGoalReason (legacy/internal namespace)', () => {
  it('translates internal budget/loop reasons via goal.reason.* keys', () => {
    expect(translateGoalReason('maxTurns', t)).toBe('goal.reason.maxTurns')
    expect(translateGoalReason('maxTime', t)).toBe('goal.reason.maxTime')
    expect(translateGoalReason('loop', t)).toBe('goal.reason.loop')
    expect(translateGoalReason('blocked', t)).toBe('goal.reason.blocked')
    expect(translateGoalReason('noInstruction', t)).toBe('goal.reason.noInstruction')
    // 'infraError' is a stable reasonId from the backend, so the
    // reasonId namespace wins over the internal namespace.
    expect(translateGoalReason('infraError', t)).toBe('goal.reasonId.infraError')
  })

  it('passes through free-form model text unchanged', () => {
    expect(translateGoalReason('the model said something specific', t)).toBe('the model said something specific')
  })

  it('falls back to unknown for empty input', () => {
    expect(translateGoalReason(undefined, t)).toBe('goal.reasonId.unknown')
    expect(translateGoalReason('', t)).toBe('goal.reasonId.unknown')
  })
})
