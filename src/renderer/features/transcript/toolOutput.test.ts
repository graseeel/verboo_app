import { describe, expect, it } from 'vitest'
import {
  TOOL_OUTPUT_MAX,
  TOOL_OUTPUT_MAX_ERROR,
  truncateToolOutput,
} from './toolOutput'

describe('truncateToolOutput', () => {
  it('preserves short output after stripping terminal controls', () => {
    expect(truncateToolOutput('\u001b[31mhello\u001b[0m', false)).toBe('hello')
  })

  it('bounds normal output at the existing 2,000 character policy', () => {
    const value = 'a'.repeat(TOOL_OUTPUT_MAX + 7)
    const result = truncateToolOutput(value, false)

    expect(result).toContain('a'.repeat(TOOL_OUTPUT_MAX))
    expect(result).toContain('[… 7 more characters truncated]')
  })

  it('uses the larger bound for errors', () => {
    const value = 'e'.repeat(TOOL_OUTPUT_MAX_ERROR + 3)
    const result = truncateToolOutput(value, true)

    expect(result).toContain('e'.repeat(TOOL_OUTPUT_MAX_ERROR))
    expect(result).toContain('[… 3 more characters truncated]')
  })
})
