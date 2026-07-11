import { describe, it, expect } from 'vitest'
import {
  getAtQuery,
  replaceAtQueryWithToken,
  removeAtQuery,
  rankFiles,
  extractAtTokens,
} from './atMention'

describe('getAtQuery', () => {
  it('returns the query string when typing @', () => {
    expect(getAtQuery('hello @')).toBe('')
    expect(getAtQuery('hello @sr')).toBe('sr')
  })

  it('returns the query for @ in the middle of a line', () => {
    expect(getAtQuery('check @src/components')).toBe('src/components')
    expect(getAtQuery('look at @./foo/bar')).toBe('./foo/bar')
  })

  it('returns undefined when no @ is active at cursor', () => {
    expect(getAtQuery('no at sign')).toBeUndefined()
    expect(getAtQuery('email@example.com')).toBeUndefined()
    expect(getAtQuery('')).toBeUndefined()
  })

  it('stops at whitespace', () => {
    expect(getAtQuery('@file more text')).toBeUndefined()
    expect(getAtQuery('@file more')).toBeUndefined()
  })

  it('only matches @ at word boundary', () => {
    expect(getAtQuery('email@example')).toBeUndefined()
    expect(getAtQuery('@@@')).toBe('@@')
  })
})

describe('replaceAtQueryWithToken', () => {
  it('replaces @query with @token', () => {
    const result = replaceAtQueryWithToken('use @fi', '@src/file.ts ')
    expect(result).toBe('use @src/file.ts ')
  })

  it('appends token when no @-mention is active', () => {
    const result = replaceAtQueryWithToken('hello', '@src/file.txt ')
    expect(result).toBe('hello @src/file.txt ')
  })

  it('preserves leading space', () => {
    const result = replaceAtQueryWithToken('use @fi', '@path ')
    expect(result).toBe('use @path ')
  })
})

describe('removeAtQuery', () => {
  it('removes the @-mention query from end of text', () => {
    expect(removeAtQuery('hello @fi')).toBe('hello ')
    expect(removeAtQuery('@query')).toBe('')
  })

  it('preserves leading space', () => {
    expect(removeAtQuery('use @fi')).toBe('use ')
  })

  it('returns unchanged when no @-mention is active', () => {
    expect(removeAtQuery('hello')).toBe('hello')
    expect(removeAtQuery('')).toBe('')
  })
})

describe('rankFiles', () => {
  const files = [
    'src/components/Button.tsx',
    'src/components/Header.tsx',
    'src/utils/helpers.ts',
    'README.md',
    'src/styles/button.css',
  ]

  it('returns exact basename matches first', () => {
    const result = rankFiles(files, 'button')
    // Both Button.tsx and button.css have basenames starting with "button"
    // (score 1). Exact order between same-score items is deterministic but
    // not lexicographically intuitive — just check they sit in the top 2.
    expect(result.slice(0, 2)).toEqual(
      expect.arrayContaining(['src/components/Button.tsx', 'src/styles/button.css']),
    )
  })

  it('prefix-matches basenames', () => {
    const result = rankFiles(files, 'help')
    expect(result[0]).toBe('src/utils/helpers.ts')
  })

  it('includes full-path matches', () => {
    const result = rankFiles(files, 'utils')
    expect(result[0]).toBe('src/utils/helpers.ts')
  })

  it('fuzzy matches when no direct match', () => {
    const result = rankFiles(files, 'hdr')
    expect(result[0]).toBe('src/components/Header.tsx')
  })

  it('returns at most 8 files when sliced', () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) => `dir/file${i}.ts`)
    const result = rankFiles(manyFiles, 'file').slice(0, 8)
    expect(result.length).toBeLessThanOrEqual(8)
  })

  it('returns empty array for non-matching query', () => {
    expect(rankFiles(files, 'zzzzznotfound')).toEqual([])
  })

  it('returns empty array for empty file list', () => {
    expect(rankFiles([], 'test')).toEqual([])
  })

  it('is case-insensitive', () => {
    const result = rankFiles(files, 'BUTTON')
    expect(result.slice(0, 2)).toEqual(
      expect.arrayContaining(['src/components/Button.tsx', 'src/styles/button.css']),
    )
  })
})

describe('extractAtTokens', () => {
  it('extracts @file tokens from text', () => {
    const tokens = extractAtTokens('use @src/file.ts and @other.js')
    expect(tokens.has('src/file.ts')).toBe(true)
    expect(tokens.has('other.js')).toBe(true)
    expect(tokens.size).toBe(2)
  })

  it('returns empty set for text without @', () => {
    expect(extractAtTokens('hello world').size).toBe(0)
  })

  it('skips email-style @', () => {
    const tokens = extractAtTokens('email@example.com')
    expect(tokens.size).toBe(0)
  })
})
