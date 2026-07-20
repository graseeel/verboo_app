import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { densifyMarkdown, normalizeThinkingProse } from './MarkdownMessage'

const markdownCss = readFileSync(resolve(process.cwd(), 'src/renderer/styles/markdown.css'), 'utf8')

describe('markdown code block themes', () => {
  it('uses a legible syntax palette in light mode', () => {
    expect(markdownCss).toContain(':root[data-theme="light"] .markdown-body pre code.hljs')
    expect(markdownCss).toContain('color: #24292f')
  })
})

describe('densifyMarkdown', () => {
  it('normalizes \\r\\n to \\n', () => {
    expect(densifyMarkdown('a\r\nb\r\nc')).toBe('a\nb\nc')
  })

  it('trims leading/trailing whitespace', () => {
    expect(densifyMarkdown('  \nhello\n  ')).toBe('hello')
  })

  it('collapses 3+ blank lines to a single blank line', () => {
    const input = 'a\n\n\n\nb\n\n\n\n\nc'
    expect(densifyMarkdown(input)).toBe('a\n\nb\n\nc')
  })

  describe('numbered lists (tight → loose prevention)', () => {
    it('removes blank line before next numbered item', () => {
      const input = '1. First step\n\nSome detail\n\n2. Second step\n\n3. Third step'
      // blank lines before "2." and "3." are removed; blank before "Some detail" stays
      const result = densifyMarkdown(input)
      expect(result).toBe('1. First step\n\nSome detail\n2. Second step\n3. Third step')
    })

    it('handles multi-digit numbers', () => {
      const input = '10. Item ten\n\n11. Item eleven'
      expect(densifyMarkdown(input)).toBe('10. Item ten\n11. Item eleven')
    })

    it('handles indented list items', () => {
      const input = '1. Top\n\n   1. Sub\n\n   2. Sub\n\n2. Next'
      // Indented items are also tightened (blank line before sub-item is
      // not semantically required — the indent defines nesting level).
      expect(densifyMarkdown(input)).toBe('1. Top\n   1. Sub\n   2. Sub\n2. Next')
    })

    it('preserves blank lines inside list item content (not before next marker)', () => {
      const input = '1. Para one\n\n   Para two\n\n2. Second'
      // blank before "2." removed; blank between paras preserved
      const result = densifyMarkdown(input)
      expect(result).toBe('1. Para one\n\n   Para two\n2. Second')
    })
  })

  describe('bullet lists', () => {
    it('removes blank line before next bullet item (-)', () => {
      const input = '- Alpha\n\n- Beta\n\n- Gamma'
      expect(densifyMarkdown(input)).toBe('- Alpha\n- Beta\n- Gamma')
    })

    it('removes blank line before next bullet item (*)', () => {
      const input = '* Foo\n\n* Bar'
      expect(densifyMarkdown(input)).toBe('* Foo\n* Bar')
    })

    it('removes blank line before next bullet item (+)', () => {
      const input = '+ One\n\n+ Two'
      expect(densifyMarkdown(input)).toBe('+ One\n+ Two')
    })
  })

  it('handles empty input', () => {
    expect(densifyMarkdown('')).toBe('')
    expect(densifyMarkdown('   ')).toBe('')
  })

  it('does NOT modify plain text without lists', () => {
    const input = 'Just a paragraph.\n\nAnother paragraph.'
    expect(densifyMarkdown(input)).toBe(input)
  })

  it('handles mixed numbered and bullet lists', () => {
    const input = '1. First\n\n2. Second\n\n- bullet\n\n- another'
    expect(densifyMarkdown(input)).toBe('1. First\n2. Second\n- bullet\n- another')
  })
})

describe('normalizeThinkingProse', () => {
  it('joins short prose lines broken by the model', () => {
    const input = 'We need to approach this\nsystematically. First, let us\nexamine the root cause.'
    expect(normalizeThinkingProse(input)).toBe('We need to approach this systematically. First, let us examine the root cause.')
  })

  it('preserves list items (not joined into prose)', () => {
    const input = 'Reasons:\n- Performance\n- Maintainability\n- Test coverage'
    expect(normalizeThinkingProse(input)).toBe('Reasons:\n- Performance\n- Maintainability\n- Test coverage')
  })

  it('preserves paragraphs (double newline acts as a break)', () => {
    const input = 'First paragraph about something.\n\nSecond paragraph about another thing.'
    expect(normalizeThinkingProse(input)).toBe('First paragraph about something.\n\nSecond paragraph about another thing.')
  })

  it('preserves code fences', () => {
    const input = 'Here is the fix:\n```\nconst x = 1\n```\nThat should work.'
    expect(normalizeThinkingProse(input)).toBe('Here is the fix:\n```\nconst x = 1\n```\nThat should work.')
  })

  it('preserves headings', () => {
    const input = '# Analysis\nThe system is working.\n## Next steps\nDeploy.'
    expect(normalizeThinkingProse(input)).toBe('# Analysis\nThe system is working.\n## Next steps\nDeploy.')
  })

  it('handles empty input', () => {
    expect(normalizeThinkingProse('')).toBe('')
    expect(normalizeThinkingProse('   ')).toBe('')
  })

  it('joins a long chain of single-word lines (worst-case model output)', () => {
    const input = 'The\nquick\nbrown\nfox\njumps\nover\nthe\nlazy\ndog'
    expect(normalizeThinkingProse(input)).toBe('The quick brown fox jumps over the lazy dog')
  })
})
