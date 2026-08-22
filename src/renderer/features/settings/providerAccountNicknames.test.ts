import { describe, expect, it } from 'vitest'
import type { ExternalProviderId } from '../../../shared/types'
import {
  clearProviderAccountNickname,
  getProviderAccountNickname,
  setProviderAccountNickname,
} from './providerAccountNicknames'

describe('provider account nicknames (P3)', () => {
  it('returns undefined when no nickname was saved for the account', () => {
    window.localStorage.clear()
    expect(getProviderAccountNickname('codex', 'local-a')).toBeUndefined()
  })

  it('persists and reads a nickname per provider:account', () => {
    window.localStorage.clear()
    setProviderAccountNickname('codex', 'local-a', 'Work Codex')
    expect(getProviderAccountNickname('codex', 'local-a')).toBe('Work Codex')
    expect(getProviderAccountNickname('codex', 'local-b')).toBeUndefined()
    expect(getProviderAccountNickname('claude', 'local-a')).toBeUndefined()
  })

  it('clears the nickname for one account without touching others', () => {
    window.localStorage.clear()
    setProviderAccountNickname('codex', 'local-a', 'Work')
    setProviderAccountNickname('codex', 'local-b', 'Personal')
    clearProviderAccountNickname('codex', 'local-a')
    expect(getProviderAccountNickname('codex', 'local-a')).toBeUndefined()
    expect(getProviderAccountNickname('codex', 'local-b')).toBe('Personal')
  })

  it('sanitizes the nickname before persisting (trim, no protocol leakage)', () => {
    window.localStorage.clear()
    setProviderAccountNickname('codex', 'local-a', '  '
      + '   Work Codex  ')
    expect(getProviderAccountNickname('codex', 'local-a')).toBe('Work Codex')
    // The account id itself is never stored as the label key — only the
    // composite key, and the raw CLI account id must not appear in the value.
    const raw = window.localStorage.getItem('verboo.providerAccountNicknames')
    expect(raw).not.toContain('local-a@')
  })
})

// Type-level contract: nicknames are keyed by the same external provider ids
// the rest of the app uses — no free-form provider strings.
const providerTypeCheck: ExternalProviderId = 'codex'
void providerTypeCheck
