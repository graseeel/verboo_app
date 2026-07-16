import { describe, expect, it } from 'vitest'
import { nextComputerUseTranscriptScroll } from './computerUseCompactScroll'

describe('nextComputerUseTranscriptScroll', () => {
  it('follows compact activity with immediate scrolling only while already following', () => {
    expect(nextComputerUseTranscriptScroll({
      following: true,
      compact: true,
      streaming: true,
    })).toBe('auto')
    expect(nextComputerUseTranscriptScroll({
      following: false,
      compact: true,
      streaming: true,
    })).toBeUndefined()
  })

  it('preserves the existing smooth behavior outside compact streaming', () => {
    expect(nextComputerUseTranscriptScroll({
      following: true,
      compact: false,
      streaming: false,
    })).toBe('smooth')
  })
})
