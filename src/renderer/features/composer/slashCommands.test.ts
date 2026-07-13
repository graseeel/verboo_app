import { describe, it, expect } from 'vitest'
import {
  parseReservedSlashCommand,
  parseGoalCommand,
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

  it('parses an explicit computer-use request with target app and goal', () => {
    expect(parseReservedSlashCommand('/computer-use "Notes" open it and type hello')).toEqual<ReservedSlashCommand>({
      kind: 'computer-use',
      app: 'Notes',
      goal: 'open it and type hello',
      raw: '/computer-use "Notes" open it and type hello',
    })
  })

  it('parses computer-use requests when the app or goal is omitted', () => {
    expect(parseReservedSlashCommand('/computer-use')).toEqual<ReservedSlashCommand>({
      kind: 'computer-use',
      raw: '/computer-use',
    })
    expect(parseReservedSlashCommand('/computer-use update the release note')).toEqual<ReservedSlashCommand>({
      kind: 'computer-use',
      goal: 'update the release note',
      raw: '/computer-use update the release note',
    })
  })

  it('accepts quoted application names with spaces', () => {
    expect(parseReservedSlashCommand('/computer-use "Google Chrome" open a new tab')).toEqual<ReservedSlashCommand>({
      kind: 'computer-use',
      app: 'Google Chrome',
      goal: 'open a new tab',
      raw: '/computer-use "Google Chrome" open a new tab',
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

  it('treats end/halt as clear synonyms', () => {
    for (const cmd of ['end', 'halt']) {
      const result = parseReservedSlashCommand(`/goal ${cmd}`)
      expect(result).toEqual<ReservedSlashCommand>({
        kind: 'goal',
        action: 'clear',
        raw: `/goal ${cmd}`,
      })
    }
  })

  it('parses /goal status as status action', () => {
    const result = parseReservedSlashCommand('/goal status')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'status',
      raw: '/goal status',
    })
  })

  it('parses /goal help and /goal ? as help action', () => {
    expect(parseReservedSlashCommand('/goal help')).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'help',
      raw: '/goal help',
    })
    expect(parseReservedSlashCommand('/goal ?')).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'help',
      raw: '/goal ?',
    })
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
    expect(isReservedSlashQuery('/computer-use')).toBe(true)
  })

  it('returns true for compact prefixes', () => {
    expect(isReservedSlashQuery('/c')).toBe(true)
    expect(isReservedSlashQuery('/co')).toBe(true)
    expect(isReservedSlashQuery('/comp')).toBe(true)
    expect(isReservedSlashQuery('/computer')).toBe(true)
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

describe('parseGoalCommand (no-slash)', () => {
  it('parses `goal implement X` (no slash) as start', () => {
    const result = parseGoalCommand('goal implement the payment endpoint')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'start',
      objective: 'implement the payment endpoint',
      raw: 'goal implement the payment endpoint',
    })
  })

  it('parses `/goal implement X` (with slash) as start', () => {
    const result = parseGoalCommand('/goal implement the payment endpoint')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'start',
      objective: 'implement the payment endpoint',
      raw: '/goal implement the payment endpoint',
    })
  })

  it('parses `goal pause` (no slash) as pause', () => {
    const result = parseGoalCommand('goal pause')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'pause',
      raw: 'goal pause',
    })
  })

  it('parses `goal` (no slash, no args) as show', () => {
    const result = parseGoalCommand('goal')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'show',
      raw: 'goal',
    })
  })

  it('is case-insensitive for the command word', () => {
    expect(parseGoalCommand('GOAL implement X')?.kind).toBe('goal')
    expect(parseGoalCommand('Goal implement X')?.kind).toBe('goal')
  })

  it('returns undefined for non-goal text', () => {
    expect(parseGoalCommand('hello world')).toBeUndefined()
    expect(parseGoalCommand('implement the payment endpoint')).toBeUndefined()
    expect(parseGoalCommand('')).toBeUndefined()
  })

  it('parses `goal status` (no slash) as status', () => {
    const result = parseGoalCommand('goal status')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'status',
      raw: 'goal status',
    })
  })

  it('parses `goal help` (no slash) as help', () => {
    const result = parseGoalCommand('goal help')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'help',
      raw: 'goal help',
    })
  })

  it('parses `goal stop` (no slash) as clear synonym', () => {
    const result = parseGoalCommand('goal stop')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'clear',
      raw: 'goal stop',
    })
  })

  it('rejects `goal is to ship` (no slash, filler first token) → undefined', () => {
    expect(parseGoalCommand('goal is to ship')).toBeUndefined()
  })

  it('rejects `goal my objective is X` (no slash, filler) → undefined', () => {
    expect(parseGoalCommand('goal my objective is X')).toBeUndefined()
  })

  it('accepts `/goal is to ship` (slash, explicit) → start', () => {
    const result = parseGoalCommand('/goal is to ship')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'start',
      objective: 'is to ship',
      raw: '/goal is to ship',
    })
  })

  it('accepts `goal implement auth` (no slash, non-filler) → start', () => {
    const result = parseGoalCommand('goal implement auth')
    expect(result).toEqual<ReservedSlashCommand>({
      kind: 'goal',
      action: 'start',
      objective: 'implement auth',
      raw: 'goal implement auth',
    })
  })

  it('rejects `hello goal world` (goal not first word) → undefined', () => {
    expect(parseGoalCommand('hello goal world')).toBeUndefined()
  })

  it('rejects `goal é fazer X` (PT filler) → undefined', () => {
    expect(parseGoalCommand('goal é fazer X')).toBeUndefined()
  })
})
