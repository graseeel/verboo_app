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

  describe('native bridge', () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo

    function mockNativeBridge(overrides: {
      request?: (goal: string, app: string | null, scope: string) => Promise<unknown>
      grant?: (id: string, screenshot: boolean) => Promise<unknown>
      deny?: (id: string) => Promise<void>
      stop?: (id: string, reason: string) => Promise<void>
    }) {
      const bridge = {
        requestComputerUseSession: overrides.request ?? vi.fn().mockResolvedValue({
          id: 'rust-req-1',
          goal: 'Native goal',
          app: 'Safari',
          scope: 'input',
          created_at_mono: 1000,
          created_at_wall: Date.now(),
        }),
        grantComputerUseSession: overrides.grant ?? vi.fn().mockResolvedValue({
          id: 'rust-sess-1',
          state: 'active',
          goal: 'Native goal',
          scope: 'input',
          allowlist_version: 1,
          self_test_enabled: false,
          screenshot_attach_to_llm: false,
          pid_lock: 12345,
          started_at_mono: 1000,
          started_at_wall: Date.now(),
          last_activity_mono: 1000,
          idle_timeout_secs: 900,
        }),
        denyComputerUseSession: overrides.deny ?? vi.fn().mockResolvedValue(undefined),
        stopComputerUseSession: overrides.stop ?? vi.fn().mockResolvedValue(undefined),
      }
      ;(window as unknown as { verboo?: unknown }).verboo = bridge
      return bridge
    }

    afterEach(() => {
      ;(window as unknown as { verboo?: unknown }).verboo = originalVerboo
    })

    it('requestConsent calls native request_computer_use_session', async () => {
      const bridge = mockNativeBridge({})
      await computerUseStore.requestConsent({
        goal: 'Click save',
        appName: 'Safari',
        appBundleId: 'com.apple.Safari',
        scope: 'input',
      })
      expect(bridge.requestComputerUseSession).toHaveBeenCalledWith('Click save', 'com.apple.Safari', 'input')
      expect(computerUseStore.getSnapshot().status).toBe('consent')
      expect(computerUseStore.getSnapshot().pendingRequest?.id).toBe('rust-req-1')
      expect(computerUseStore.getSnapshot().pendingRequest?.appName).toBe('Safari')
    })

    it('grant calls native grant_computer_use_session and translates session', async () => {
      mockNativeBridge({})
      await computerUseStore.requestConsent({
        goal: 'Click save',
        appName: 'Safari',
        scope: 'input',
      })
      await computerUseStore.grant({ type: 'once' })
      expect(computerUseStore.getSnapshot().status).toBe('active')
      expect(computerUseStore.getSnapshot().session?.id).toBe('rust-sess-1')
      expect(computerUseStore.getSnapshot().session?.appName).toBe('Safari')
      expect(computerUseStore.getSnapshot().session?.isSelfTest).toBe(false)
    })

    it('deny calls native deny_computer_use_session', async () => {
      const bridge = mockNativeBridge({})
      await computerUseStore.requestConsent({ goal: 'G', appName: 'App', scope: 'ask' })
      await computerUseStore.deny('user_denied')
      expect(bridge.denyComputerUseSession).toHaveBeenCalledWith('rust-req-1')
      expect(computerUseStore.getSnapshot().status).toBe('denied')
    })

    it('stop calls native stop_computer_use_session with reason', async () => {
      const bridge = mockNativeBridge({})
      await computerUseStore.requestConsent({ goal: 'G', appName: 'App', scope: 'ask' })
      await computerUseStore.grant({ type: 'once' })
      await computerUseStore.stop('user_cancelled')
      expect(bridge.stopComputerUseSession).toHaveBeenCalledWith('rust-sess-1', 'user_cancelled')
      expect(computerUseStore.getSnapshot().status).toBe('stopped')
    })

    it('emergencyStop calls native stop with emergency reason', async () => {
      vi.useFakeTimers()
      const bridge = mockNativeBridge({})
      await computerUseStore.requestConsent({ goal: 'G', appName: 'App', scope: 'ask' })
      await computerUseStore.grant({ type: 'once' })
      // emergencyStop is async; it calls native stop then sets a 600ms flash.
      // The native call is awaited, but the 600ms timeout is fire-and-forget.
      await computerUseStore.emergencyStop()
      expect(bridge.stopComputerUseSession).toHaveBeenCalledWith('rust-sess-1', 'emergency')
      // During flash, isEmergencyFlashing is true and lastStop not yet set.
      expect(computerUseStore.getSnapshot().isEmergencyFlashing).toBe(true)
      // Advance past the 600ms flash — lastStop gets set.
      vi.advanceTimersByTime(600)
      expect(computerUseStore.getSnapshot().lastStop?.reason).toBe('emergency_stop')
    })

    it('request failure surfaces as denied', async () => {
      mockNativeBridge({
        request: vi.fn().mockRejectedValue(new Error('policy block')),
      })
      await computerUseStore.requestConsent({ goal: 'G', appName: 'App', scope: 'ask' })
      expect(computerUseStore.getSnapshot().status).toBe('denied')
      expect(computerUseStore.getSnapshot().lastDeny?.detail).toBe('policy block')
    })

    it('goal-directed: requestConsent with no app passes null to native', async () => {
      const bridge = mockNativeBridge({
        request: vi.fn().mockResolvedValue({
          id: 'rust-req-goal',
          goal: 'Teste a feature que acabei de adicionar',
          app: null,
          scope: 'input',
          created_at_mono: 1000,
          created_at_wall: Date.now(),
        }),
      })
      await computerUseStore.requestConsent({
        goal: 'Teste a feature que acabei de adicionar',
        scope: 'input',
      })
      expect(bridge.requestComputerUseSession).toHaveBeenCalledWith(
        'Teste a feature que acabei de adicionar',
        null,
        'input',
      )
      expect(computerUseStore.getSnapshot().status).toBe('consent')
      expect(computerUseStore.getSnapshot().pendingRequest?.appBundleId).toBeUndefined()
      expect(computerUseStore.getSnapshot().pendingRequest?.appName).toBe('Teste a feature que acabei de adicionar')
    })

    it('goal-directed: grant with no app produces active session', async () => {
      mockNativeBridge({
        request: vi.fn().mockResolvedValue({
          id: 'rust-req-goal',
          goal: 'Teste a feature',
          app: null,
          scope: 'input',
          created_at_mono: 1000,
          created_at_wall: Date.now(),
        }),
        grant: vi.fn().mockResolvedValue({
          id: 'rust-sess-goal',
          state: 'active',
          goal: 'Teste a feature',
          target_app: null,
          scope: 'input',
          allowlist_version: 0,
          self_test_enabled: false,
          screenshot_attach_to_llm: true,
          pid_lock: 12345,
          started_at_mono: 1000,
          started_at_wall: Date.now(),
          last_activity_mono: 1000,
          idle_timeout_secs: 900,
        }),
      })
      await computerUseStore.requestConsent({
        goal: 'Teste a feature',
        scope: 'input',
      })
      await computerUseStore.grant({ type: 'session' })
      expect(computerUseStore.getSnapshot().status).toBe('active')
      expect(computerUseStore.getSnapshot().session?.id).toBe('rust-sess-goal')
      // appName falls back to goal when no app was resolved
      expect(computerUseStore.getSnapshot().session?.appName).toBe('Teste a feature')
    })
  })
})
