/**
 * computerUseStore.test.ts — state machine + mock lifecycle.
 *
 * Verifies the transitions that the UX depends on:
 *   idle → consent → active → stopped → idle
 *   idle → consent → denied → idle
 *   active → paused → active
 *   active → emergency-stopping → stopped → idle
 *   mock action events update banner subtext
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computerUseStore } from './computerUseStore'

describe('computerUseStore', () => {
  beforeEach(() => {
    computerUseStore.__reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts idle', () => {
    expect(computerUseStore.getSnapshot().status).toBe('idle')
  })

  it('idle → consent → active → stopped → idle', async () => {
    computerUseStore.__mockRequestConsent({ goal: 'Toggle a toggle', appName: 'Verboo Settings' })
    expect(computerUseStore.getSnapshot().status).toBe('consent')
    expect(computerUseStore.getSnapshot().pendingRequest?.appName).toBe('Verboo Settings')

    await computerUseStore.grant({ type: 'once' })
    expect(computerUseStore.getSnapshot().status).toBe('active')
    expect(computerUseStore.getSnapshot().session?.goal).toBe('Toggle a toggle')
    expect(computerUseStore.getSnapshot().session?.actionCount).toBe(0)

    await computerUseStore.stop('user_cancelled')
    expect(computerUseStore.getSnapshot().status).toBe('stopped')
    expect(computerUseStore.getSnapshot().lastStop?.reason).toBe('user_cancelled')
    expect(computerUseStore.getSnapshot().lastStop?.actionCount).toBe(0)
  })

  it('idle → consent → denied → idle (auto-clear)', async () => {
    vi.useFakeTimers()
    computerUseStore.__mockRequestConsent({ goal: 'Test', appName: 'Notes' })
    await computerUseStore.deny('user_denied')
    expect(computerUseStore.getSnapshot().status).toBe('denied')
    expect(computerUseStore.getSnapshot().lastDeny?.reason).toBe('user_denied')

    vi.advanceTimersByTime(4100)
    expect(computerUseStore.getSnapshot().status).toBe('idle')
    expect(computerUseStore.getSnapshot().lastDeny).toBeUndefined()
  })

  it('active ⇄ paused', async () => {
    computerUseStore.__mockRequestConsent({ goal: 'G', appName: 'App' })
    await computerUseStore.grant({ type: 'session' })
    expect(computerUseStore.getSnapshot().status).toBe('active')

    await computerUseStore.pause()
    expect(computerUseStore.getSnapshot().status).toBe('paused')

    await computerUseStore.resume()
    expect(computerUseStore.getSnapshot().status).toBe('active')
  })

  it('emergency stop flashes then stops', async () => {
    vi.useFakeTimers()
    computerUseStore.__mockRequestConsent({ goal: 'G', appName: 'App' })
    await computerUseStore.grant({ type: 'once' })

    const stopPromise = computerUseStore.emergencyStop()
    // During the 600ms flash, isEmergencyFlashing is true.
    expect(computerUseStore.getSnapshot().isEmergencyFlashing).toBe(true)

    vi.advanceTimersByTime(600)
    await stopPromise
    expect(computerUseStore.getSnapshot().isEmergencyFlashing).toBe(false)
    expect(computerUseStore.getSnapshot().status).toBe('stopped')
    expect(computerUseStore.getSnapshot().lastStop?.reason).toBe('emergency_stop')
  })

  it('mock action events update lastAction + actionCount', async () => {
    vi.useFakeTimers()
    computerUseStore.__mockRequestConsent({ goal: 'G', appName: 'App' })
    await computerUseStore.grant({ type: 'once' })

    // The mock timer fires every 2200ms. The first tick increments
    // mockActionIndex to 1, so the first verb is MOCK_VERBS[1] = 'type'.
    vi.advanceTimersByTime(2200)
    const s1 = computerUseStore.getSnapshot().session
    expect(s1?.actionCount).toBe(1)
    expect(s1?.lastAction?.verb).toBe('type')

    vi.advanceTimersByTime(2200)
    const s2 = computerUseStore.getSnapshot().session
    expect(s2?.actionCount).toBe(2)
    expect(s2?.lastAction?.verb).toBe('read')
  })

  it('deny with no pending request is a no-op', async () => {
    await computerUseStore.deny('user_denied')
    expect(computerUseStore.getSnapshot().status).toBe('idle')
  })

  it('pause with no active session is a no-op', async () => {
    await computerUseStore.pause()
    expect(computerUseStore.getSnapshot().status).toBe('idle')
  })

  it('self-test request sets isSelfTest=true', () => {
    computerUseStore.__mockRequestConsent({
      goal: 'Self-test',
      appName: 'Verboo Settings',
      isSelfTest: true,
    })
    expect(computerUseStore.getSnapshot().pendingRequest?.isSelfTest).toBe(true)
  })
})
