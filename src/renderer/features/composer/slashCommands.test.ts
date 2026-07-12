import { describe, it, expect } from 'vitest'
import {
  parseReservedSlashCommand,
  isReservedSlashQuery,
  type ReservedSlashCommand,
} from './slashCommands'

/**
 * Regression tests for slashCommands.ts
 *
 * The composer relies on these pure functions to decide whether a user
 * input is a reserved /goal or /pet command vs free text. A regression
 * here would either (a) let free text be misclassified as a command, or
 * (b) swallow a real command. Both break the composer UX.
 */
describe('parseReservedSlashCommand', () => {
  it('returns undefined for non-slash input', () => {
    expect(parseReservedSlashCommand('hello world')).toBeUndefined()
    expect(parseReservedSlashCommand(' goal')).toBeUndefined()
  })

  it('returns undefined for unknown slash commands', () => {
    expect(parseReservedSlashCommand('/unknown')).toBeUndefined()
    expect(parseReservedSlashCommand('/unknown with args')).toBeUndefined()
  })

  it('parses /pet when no arguments', () => {
    const result = parseReservedSlashCommand('/pet')
    expect(result).toEqual<ReservedSlashCommand>({ kind: 'pet', raw: '/pet' })
  })

  it('does NOT parse /pet with arguments', () => {
    expect(parseReservedSlashCommand('/pet me')).toBeUndefined()
  })

  it('parses bare /compact', () => {
    const result = parseReservedSlashCommand('/compact')
    expect(result).toEqual<ReservedSlashCommand>({ kind: 'compact', raw: '/compact' })
  })

  it('parses /compact with summarization instructions', () => {
    const result = parseReservedSlashCommand('/compact keep API design decisions')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'compact',
      instructions: 'keep API design decisions',
      raw: '/compact keep API design decisions',
    })
  })

  it('parses /compact case-insensitively', () => {
    const result = parseReservedSlashCommand('/Compact  focus on tests  ')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'compact',
      instructions: 'focus on tests',
      raw: '/Compact  focus on tests',
    })
  })

  it('parses bare /goal as show action', () => {
    const result = parseReservedSlashCommand('/goal')
    expect(result).toEqual<ReservedSlashCommand>({ kind: 'goal', action: 'show', raw: '/goal' })
  })

  it('parses /goal pause/resume/clear exactly', () => {
    expect(parseReservedSlashCommand('/goal pause')).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'pause',
      raw: '/goal pause',
    })
    expect(parseReservedSlashCommand('/goal resume')).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'resume',
      raw: '/goal resume',
    })
    expect(parseReservedSlashCommand('/goal clear')).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'clear',
      raw: '/goal clear',
    })
  })

  it('treats stop/cancel/reset/off as clear synonyms', () => {
    for (const cmd of ['stop', 'cancel', 'reset', 'off']) {
      const result = parseReservedSlashCommand(`/goal ${cmd}`)
      expect(result).toEqual<ReservedSlashCommand>({
        kind: 'goal',
        action: 'clear',
        raw: `/goal ${cmd}`,
      })
    }
  })

  it('parses /goal <objective> as start action', () => {
    const result = parseReservedSlashCommand('/goal write more tests')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'start',
      objective: 'write more tests',
      raw: '/goal write more tests',
    })
  })

  it('preserves the raw input including leading/trailing whitespace', () => {
    const result = parseReservedSlashCommand('  /goal pause  ')
    expect(result).toBeDefined()
    expect(result!.raw).toBe('/goal pause')
  })
})

describe('isReservedSlashQuery', () => {
  it('returns false for non-slash input', () => {
    expect(isReservedSlashQuery('hello')).toBe(false)
    expect(isReservedSlashQuery(' /goal')).toBe(false)
  })

  it('returns false for queries that match no reserved command', () => {
    expect(isReservedSlashQuery('/xyz')).toBe(false)
    expect(isReservedSlashQuery('/unknown')).toBe(false)
  })

  it('returns true for prefixes of reserved commands', () => {
    expect(isReservedSlashQuery('/g')).toBe(true)
    expect(isReservedSlashQuery('/go')).toBe(true)
    expect(isReservedSlashQuery('/goa')).toBe(true)
    expect(isReservedSlashQuery('/p')).toBe(true)
    expect(isReservedSlashQuery('/pe')).toBe(true)
  })

  it('returns true for exact reserved commands', () => {
    expect(isReservedSlashQuery('/goal')).toBe(true)
    expect(isReservedSlashQuery('/pet')).toBe(true)
    expect(isReservedSlashQuery('/compact')).toBe(true)
  })

  it('returns true for compact prefixes', () => {
    expect(isReservedSlashQuery('/c')).toBe(true)
    expect(isReservedSlashQuery('/co')).toBe(true)
    expect(isReservedSlashQuery('/comp')).toBe(true)
  })

  it('returns false once arguments are present', () => {
    expect(isReservedSlashQuery('/goal pause')).toBe(false)
    expect(isReservedSlashQuery('/pet me')).toBe(false)
    expect(isReservedSlashQuery('/compact keep')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isReservedSlashQuery('/G')).toBe(true)
    expect(isReservedSlashQuery('/P')).toBe(true)
    expect(isReservedSlashQuery('/C')).toBe(true)
  })
})
