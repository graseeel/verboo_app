import { describe, expect, it } from 'vitest'
import { supportsEmbeddedBrowser } from './browserAvailability'

describe('supportsEmbeddedBrowser', () => {
  it('enables the embedded browser on macOS', () => {
    expect(supportsEmbeddedBrowser('darwin')).toBe(true)
  })

  it('enables the embedded browser on Windows', () => {
    expect(supportsEmbeddedBrowser('win32')).toBe(true)
  })

  it('enables the embedded browser on Linux', () => {
    expect(supportsEmbeddedBrowser('linux')).toBe(true)
  })

  it('keeps the embedded browser unavailable on non-desktop platforms', () => {
    expect(supportsEmbeddedBrowser('freebsd' as NodeJS.Platform)).toBe(false)
  })
})
