import { describe, expect, it } from 'vitest'
import { supportsEmbeddedBrowser } from './browserAvailability'

describe('supportsEmbeddedBrowser', () => {
  it('enables the embedded browser on macOS', () => {
    expect(supportsEmbeddedBrowser('darwin')).toBe(true)
  })

  it('keeps the embedded browser unavailable on Windows and Linux', () => {
    expect(supportsEmbeddedBrowser('win32')).toBe(false)
    expect(supportsEmbeddedBrowser('linux')).toBe(false)
  })
})
