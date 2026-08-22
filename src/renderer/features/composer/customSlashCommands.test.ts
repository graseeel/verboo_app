import { describe, it, expect } from 'vitest'
import {
  CUSTOM_COMMAND_NAME_PATTERN,
  generateCustomCommandId,
  getCustomCommandLabel,
  getCustomCommandToken,
  isReservedCommandName,
  isValidCustomCommandName,
  rankCustomCommands,
} from './customSlashCommands'
import type { CustomSlashCommand } from '../../../shared/types'

function makeCommand(overrides: Partial<CustomSlashCommand> = {}): CustomSlashCommand {
  return {
    id: overrides.id ?? 'fixed-id',
    name: overrides.name ?? 'demo',
    description: overrides.description ?? 'Demo description',
    body: overrides.body ?? 'Demo body',
    createdAt: overrides.createdAt ?? 0,
  }
}

describe('isValidCustomCommandName', () => {
  it('accepts letters, digits, underscores and dashes', () => {
    expect(isValidCustomCommandName('review-pr')).toBe(true)
    expect(isValidCustomCommandName('Plan9')).toBe(true)
    expect(isValidCustomCommandName('foo_bar')).toBe(true)
  })

  it('rejects empty / whitespace / slash / special chars', () => {
    expect(isValidCustomCommandName('')).toBe(false)
    expect(isValidCustomCommandName('   ')).toBe(false)
    expect(isValidCustomCommandName('/foo')).toBe(false)
    expect(isValidCustomCommandName('foo bar')).toBe(false)
    expect(isValidCustomCommandName('foo.bar')).toBe(false)
    expect(isValidCustomCommandName('foo$')).toBe(false)
    expect(isValidCustomCommandName('café')).toBe(false)
  })

  it('matches the documented regex', () => {
    expect(CUSTOM_COMMAND_NAME_PATTERN.test('foo')).toBe(isValidCustomCommandName('foo'))
    expect(CUSTOM_COMMAND_NAME_PATTERN.test('foo!')).toBe(isValidCustomCommandName('foo!'))
  })
})

describe('isReservedCommandName', () => {
  it('flags goal, pet, and compact regardless of case', () => {
    expect(isReservedCommandName('goal')).toBe(true)
    expect(isReservedCommandName('GOAL')).toBe(true)
    expect(isReservedCommandName('Pet')).toBe(true)
    expect(isReservedCommandName('compact')).toBe(true)
    expect(isReservedCommandName('COMPACT')).toBe(true)
  })

  it('does NOT flag arbitrary prefixes or extensions', () => {
    // `goal` is reserved, but `goal-mode` / `goal_v2` aren't the reserved
    // *command* — they're distinct tokens. The composer wires them through
    // normal matching. Blocking them here would be over-reach.
    expect(isReservedCommandName('goal-mode')).toBe(false)
    expect(isReservedCommandName('goals')).toBe(false)
    expect(isReservedCommandName('peter')).toBe(false)
  })

  it('does NOT flag arbitrary custom names', () => {
    expect(isReservedCommandName('review')).toBe(false)
    expect(isReservedCommandName('meeting')).toBe(false)
  })
})

describe('rankCustomCommands', () => {
  const all = [
    makeCommand({ name: 'review-pr', description: 'Prepare a code review' }),
    makeCommand({ name: 'meeting', description: 'Prep for a sync', body: 'Add calendar event' }),
    makeCommand({ name: 'commit', description: 'Writes a commit message draft', body: '' }),
    makeCommand({ name: 'refactor', description: 'Cleanup noisy code' }),
  ]

  it('returns the input order when the query is empty', () => {
    expect(rankCustomCommands(all, '').map(c => c.name)).toEqual(['review-pr', 'meeting', 'commit', 'refactor'])
  })

  it('ranks an exact name match first', () => {
    // Only `meeting` matches in body/description; the rest of the corpus is
    // safely filtered out by the score cut-off.
    expect(rankCustomCommands(all, 'meeting').map(c => c.name)).toEqual(['meeting'])
  })

  it('falls back to description / body / fuzzy matches', () => {
    const ranked = rankCustomCommands(all, 'review').map(c => c.name)
    expect(ranked[0]).toBe('review-pr')
  })

  it('filters out unrelated commands', () => {
    expect(rankCustomCommands(all, 'xyz')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(rankCustomCommands(all, 'MEET').map(c => c.name)).toContain('meeting')
  })

  it('does not mutate the input array', () => {
    const before = all.slice()
    rankCustomCommands(all, 'meeting')
    expect(all).toEqual(before)
  })
})

describe('getCustomCommandToken', () => {
  it('returns the body verbatim when it ends in whitespace', () => {
    expect(getCustomCommandToken(makeCommand({ name: 'demo', body: 'hello world\n' }))).toBe('hello world\n')
  })

  it('pads a single trailing space when body ends in punctuation', () => {
    expect(getCustomCommandToken(makeCommand({ name: 'demo', body: 'Hello world.' }))).toBe('Hello world. ')
  })

  it('falls back to /name + space when body is empty', () => {
    expect(getCustomCommandToken(makeCommand({ name: 'demo', body: '' }))).toBe('/demo ')
  })

  it('falls back to /name + space when body is whitespace only', () => {
    expect(getCustomCommandToken(makeCommand({ name: 'demo', body: '   \n  ' }))).toBe('/demo ')
  })

  it('preserves multi-line bodies', () => {
    const body = 'Line one\nLine two\n- bullet\n- bullet'
    expect(getCustomCommandToken(makeCommand({ name: 'demo', body }))).toBe(body + ' ')
  })

  it('preserves tab terminators without padding', () => {
    // Body that genuinely ends with a tab character — last char must be the
    // tab itself for the no-padding branch to fire.
    expect(getCustomCommandToken(makeCommand({ name: 'demo', body: 'hello\t' }))).toBe('hello\t')
  })

  it('preserves carriage-return terminators without padding', () => {
    // 'hello\r\n' ends in \n (already a no-pad terminator); bare \r must
    // also skip padding.
    expect(getCustomCommandToken(makeCommand({ name: 'demo', body: 'hello\r' }))).toBe('hello\r')
  })
})

describe('getCustomCommandLabel', () => {
  it('prefixes with a slash', () => {
    expect(getCustomCommandLabel(makeCommand({ name: 'review-pr' }))).toBe('/review-pr')
  })
})

describe('generateCustomCommandId', () => {
  it('produces a UUID-like string', () => {
    const id = generateCustomCommandId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(16)
    // shape: 8-4-4-4-12 hex chunks
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]+$/)
  })

  it('produces non-empty outputs on consecutive calls', () => {
    const a = generateCustomCommandId()
    const b = generateCustomCommandId()
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    // May collide in pathological cases — extremely unlikely with at least 88
    // bits of randomness per call.
    expect(a).not.toBe(b)
  })
})
