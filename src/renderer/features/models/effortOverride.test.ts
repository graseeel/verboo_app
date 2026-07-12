import { describe, it, expect } from 'vitest'
import type { ModelReasoning } from '../../../shared/types'
import { validOverride, displayEffort, migrateEffortPrefs } from './effortOverride'

const reasoning: ModelReasoning = {
  effortLevels: ['low', 'medium', 'high', 'max'],
  defaultEffort: 'high',
}

const reasoningWithNone: ModelReasoning = {
  effortLevels: ['none', 'low', 'medium', 'high'],
  defaultEffort: 'medium',
}

describe('validOverride', () => {
  it('returns undefined when reasoning is missing', () => {
    expect(validOverride({ 'glm-5.2': 'high' }, 'glm-5.2', undefined)).toBeUndefined()
  })

  it('returns undefined when modelId is missing', () => {
    expect(validOverride({ 'glm-5.2': 'high' }, undefined, reasoning)).toBeUndefined()
  })

  it('returns undefined when no preference is saved for the model', () => {
    expect(validOverride({ 'kimi-k2': 'high' }, 'glm-5.2', reasoning)).toBeUndefined()
  })

  it('returns undefined when effortLevels is empty (model without levels)', () => {
    expect(
      validOverride({ 'glm-5.2': 'high' }, 'glm-5.2', {
        effortLevels: [],
        defaultEffort: 'high',
      }),
    ).toBeUndefined()
  })

  it('returns the saved value when it is in effortLevels', () => {
    expect(validOverride({ 'glm-5.2': 'low' }, 'glm-5.2', reasoning)).toBe('low')
    expect(validOverride({ 'glm-5.2': 'max' }, 'glm-5.2', reasoning)).toBe('max')
  })

  it('preserves "none" when offered in effortLevels (regression: must not be coerced to undefined)', () => {
    expect(validOverride({ 'glm-5.2': 'none' }, 'glm-5.2', reasoningWithNone)).toBe('none')
  })

  it('returns undefined when the saved value is no longer in effortLevels (stale)', () => {
    expect(validOverride({ 'glm-5.2': 'max' }, 'glm-5.2', reasoningWithNone)).toBeUndefined()
  })

  it('never falls back to defaultEffort (that is the display rule, not the wire rule)', () => {
    expect(validOverride({}, 'glm-5.2', reasoning)).toBeUndefined()
    expect(validOverride(undefined, 'glm-5.2', reasoning)).toBeUndefined()
  })

  it('treats empty-string saved value as absent', () => {
    // Defensive: a corrupt persisted map should not match an empty effortLevel.
    expect(validOverride({ 'glm-5.2': '' }, 'glm-5.2', reasoning)).toBeUndefined()
  })
})

describe('displayEffort', () => {
  it('returns the saved override when valid', () => {
    expect(displayEffort({ 'glm-5.2': 'low' }, 'glm-5.2', reasoning)).toBe('low')
  })

  it('falls back to defaultEffort when no override is saved', () => {
    expect(displayEffort({}, 'glm-5.2', reasoning)).toBe('high')
    expect(displayEffort(undefined, 'glm-5.2', reasoning)).toBe('high')
  })

  it('falls back to defaultEffort when the saved override is stale', () => {
    expect(displayEffort({ 'glm-5.2': 'max' }, 'glm-5.2', reasoningWithNone)).toBe('medium')
  })

  it('returns undefined when reasoning is missing (no pill)', () => {
    expect(displayEffort({ 'glm-5.2': 'high' }, 'glm-5.2', undefined)).toBeUndefined()
  })

  it('returns "none" as a valid display when set and offered', () => {
    expect(displayEffort({ 'glm-5.2': 'none' }, 'glm-5.2', reasoningWithNone)).toBe('none')
  })
})

describe('migrateEffortPrefs', () => {
  it('returns backend prefs and no migrate signal when backend has entries', () => {
    const backend = { 'glm-5.2': 'high', 'kimi-k2': 'low' }
    const ls = { 'glm-5.2': 'max' }
    const out = migrateEffortPrefs(backend, ls)
    expect(out.prefs).toEqual(backend)
    expect(out.migrate).toBeUndefined()
  })

  it('returns ls prefs and a migrate payload when backend is empty but ls has entries', () => {
    const ls = { 'glm-5.2': 'high' }
    const out = migrateEffortPrefs(undefined, ls)
    expect(out.prefs).toEqual(ls)
    expect(out.migrate).toEqual(ls)
  })

  it('returns ls prefs and a migrate payload when backend is {} but ls has entries', () => {
    const ls = { 'glm-5.2': 'high' }
    const out = migrateEffortPrefs({}, ls)
    expect(out.prefs).toEqual(ls)
    expect(out.migrate).toEqual(ls)
  })

  it('returns empty prefs and no migrate when both are empty', () => {
    expect(migrateEffortPrefs(undefined, undefined)).toEqual({ prefs: {}, migrate: undefined })
    expect(migrateEffortPrefs({}, {})).toEqual({ prefs: {}, migrate: undefined })
  })

  it('returns empty prefs and no migrate when both are missing', () => {
    expect(migrateEffortPrefs(undefined, undefined)).toEqual({ prefs: {}, migrate: undefined })
  })

  it('does not migrate when backend already has data (even if ls has different data)', () => {
    // The user may have edited prefs on another device — backend wins, ls is dropped.
    const backend = { 'glm-5.2': 'low' }
    const ls = { 'glm-5.2': 'high', 'kimi-k2': 'max' }
    const out = migrateEffortPrefs(backend, ls)
    expect(out.prefs).toEqual(backend)
    expect(out.migrate).toBeUndefined()
  })
})
