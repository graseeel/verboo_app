import { describe, expect, it } from 'vitest'
import {
  isAuthenticationFailure,
  shouldAutoRecoverAuthentication,
} from './cliFailureRecovery'

describe('CLI authentication failure recovery', () => {
  const recoverableFailure = {
    category: 'authentication_failed',
    message: 'API Error: 401 invalid or expired token',
    details: ['API Error: 401 invalid or expired token'],
    exitCode: 1,
    sessionId: 'session-1',
    recoveryReady: true,
  }

  it('recognizes structured and legacy authentication failures', () => {
    expect(isAuthenticationFailure(recoverableFailure, recoverableFailure.message)).toBe(true)
    expect(isAuthenticationFailure(undefined, 'Failed to authenticate: OAuth session expired')).toBe(true)
    expect(isAuthenticationFailure(undefined, 'API Error: 529 overloaded')).toBe(false)
  })

  it('recovers automatically only when refresh succeeded and no recovery is active', () => {
    expect(shouldAutoRecoverAuthentication(recoverableFailure, false)).toBe(true)
    expect(shouldAutoRecoverAuthentication({ ...recoverableFailure, recoveryReady: false }, false)).toBe(false)
    expect(shouldAutoRecoverAuthentication(recoverableFailure, true)).toBe(false)
  })

  it('never treats non-authentication failures as automatic auth recovery', () => {
    expect(shouldAutoRecoverAuthentication({
      ...recoverableFailure,
      category: 'rate_limit',
    }, false)).toBe(false)
  })
})
