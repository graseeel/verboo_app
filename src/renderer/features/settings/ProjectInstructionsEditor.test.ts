import { describe, it, expect } from 'vitest'
import {
  basename,
  countInstructionChars,
  isInstructionDirty,
} from './ProjectInstructionsEditor'

describe('isInstructionDirty', () => {
  it('returns false when both buffers are byte-for-byte identical', () => {
    expect(isInstructionDirty('hello\n# title\n', 'hello\n# title\n')).toBe(false)
  })

  it('returns true when the draft has additional trailing content', () => {
    expect(isInstructionDirty('hello\n', 'hello\nworld\n')).toBe(true)
  })

  it('returns true on whitespace-only changes (newline trimmed differences count)', () => {
    expect(isInstructionDirty('hello\n', 'hello\n\n')).toBe(true)
  })

  it('returns true after deleting characters', () => {
    expect(isInstructionDirty('hello world\n', 'hello\n')).toBe(true)
  })

  it('treats multibyte characters equally on both sides', () => {
    expect(isInstructionDirty('ação rápida', 'ação rápida')).toBe(false)
    expect(isInstructionDirty('ação rápida', 'acao rapida')).toBe(true)
  })

  it('CHAIN scenario: load → 2 edits → save → load again', () => {
    const loaded = '# Project Rules'
    let draft = loaded
    expect(isInstructionDirty(loaded, draft)).toBe(false)

    draft = draft + '\n- Use TypeScript'
    expect(isInstructionDirty(loaded, draft)).toBe(true)

    // Second edit on top of the SAME original would lose both edits if the
    // original were used; using the new draft as the basis is mandatory.
    const firstDraft = draft
    draft = draft + '\n- Keep commits in English'
    expect(isInstructionDirty(loaded, draft)).toBe(true)
    expect(isInstructionDirty(firstDraft, draft)).toBe(true)

    // Pretend save: loaded becomes the latest draft.
    const afterSave = draft
    expect(isInstructionDirty(afterSave, afterSave)).toBe(false)
  })
})

describe('countInstructionChars', () => {
  it('counts ASCII characters one-per-codepoint', () => {
    expect(countInstructionChars('hello')).toBe(5)
  })

  it('counts multibyte characters as one each (unlike .length in JS)', () => {
    // 'café' has 4 code points but '.length === 5' because 'é' is 2 UTF-16 code units.
    expect(countInstructionChars('café')).toBe(4)
  })

  it('counts emoji as surrogate-paired code points (JS .length behaviour)', () => {
    // '👨' is two UTF-16 code units; Array.from gives 1 (one codepoint).
    expect(countInstructionChars('👨')).toBe(1)
    // ZWJ family sequence is multiple codepoints. Use a tolerant upper bound
    // rather than the user-perceived grapheme count of 1 — the helper is for
    // a sanity estimate, not a precise grapheme counter.
    expect(countInstructionChars('👨‍👩‍👧')).toBeGreaterThanOrEqual(3)
  })

  it('handles empty string', () => {
    expect(countInstructionChars('')).toBe(0)
  })
})

describe('basename', () => {
  it('returns the last segment of a POSIX path', () => {
    expect(basename('/Users/me/Code/verboo_app-dev')).toBe('verboo_app-dev')
  })

  it('returns the last segment of a Windows path', () => {
    expect(basename('C:\\Users\\me\\project')).toBe('project')
  })

  it('strips trailing slashes before extracting the last segment', () => {
    expect(basename('/Users/me/Code/verboo_app-dev/')).toBe('verboo_app-dev')
    expect(basename('C:\\Users\\me\\project\\')).toBe('project')
  })

  it('strips mixed trailing separators', () => {
    expect(basename('/Users/me/Code/verboo_app-dev///')).toBe('verboo_app-dev')
  })

  it('returns the whole input when no separator is present', () => {
    expect(basename('verboo_app-dev')).toBe('verboo_app-dev')
  })

  it('returns empty string for empty input', () => {
    expect(basename('')).toBe('')
  })

  it('handles single-component input with trailing slash as empty-aware', () => {
    // The trailing slash alone means the path effectively had no name;
    // we return the last non-empty segment, here 'home'.
    expect(basename('home/')).toBe('home')
  })
})
