import { describe, expect, it } from 'vitest'
import { getReleaseCopy, releaseTagUrl } from './releaseCatalog'

describe('releaseCatalog', () => {
  it('returns approved copy in the active locale', () => {
    expect(getReleaseCopy('0.8.0-beta', 'pt-BR')?.title).toBe(
      'Verboo Code 0.8.0-beta — Simulador de Android e correção da tela preta no Linux',
    )
    expect(getReleaseCopy('0.8.0-beta', 'en-US')?.items).toHaveLength(5)
    expect(getReleaseCopy('0.7.3-beta', 'pt-BR')?.title).toBe(
      'Verboo Code 0.7.3-beta — login no Windows e onboarding do simulador',
    )
    expect(getReleaseCopy('0.7.3-beta', 'en-US')?.items).toHaveLength(4)
    expect(getReleaseCopy('0.7.2-beta', 'pt-BR')?.title).toBe(
      'Verboo Code 0.7.2-beta — hotfix dos provedores',
    )
    expect(getReleaseCopy('0.7.2-beta', 'en-US')?.items).toHaveLength(4)
    expect(getReleaseCopy('0.7.1-beta', 'pt-BR')?.title).toBe(
      'Verboo Code 0.7.1-beta — hotfix de conexão',
    )
    expect(getReleaseCopy('0.7.1-beta', 'en-US')?.items).toHaveLength(4)
    expect(getReleaseCopy('0.7.0-beta', 'en-US')?.items).toHaveLength(6)
  })

  it('returns undefined for a version absent from the bundled catalog', () => {
    expect(getReleaseCopy('9.9.9', 'en-US')).toBeUndefined()
  })

  it('derives only the fixed repository tag URL from a canonical version', () => {
    expect(releaseTagUrl('0.7.2-beta')).toBe(
      'https://github.com/graseeel/verboo_app/releases/tag/v0.7.2-beta',
    )
    expect(() => releaseTagUrl('../malicious')).toThrow(/canonical/i)
  })
})
