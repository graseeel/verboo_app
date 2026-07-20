import { describe, expect, it } from 'vitest'
import {
  isAuthenticationFailure,
  shouldAutoRecoverAuthentication,
  shouldRetryIncompleteTurn,
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

  it('retries an incomplete turn only once without the stale session', () => {
    const incompleteFailure = {
      ...recoverableFailure,
      category: 'incomplete_turn',
      recoveryReady: false,
    }

    expect(shouldRetryIncompleteTurn(incompleteFailure, false)).toBe(true)
    expect(shouldRetryIncompleteTurn(incompleteFailure, true)).toBe(false)
    expect(shouldRetryIncompleteTurn(recoverableFailure, false)).toBe(false)
  })
})
