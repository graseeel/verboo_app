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

function restoreNativeExecutorLease() {
  return computerUseStore.restoreNativeExecutorLease({
    id: 'native-session',
    state: 'active',
    conversation_id: 'conversation-1',
    executor_model_id: 'vision-model',
    goal: 'Write a note',
    target_app: 'com.apple.Notes',
    active_app: 'com.apple.Notes',
    approved_apps: [{
      bundle_id: 'com.apple.Notes',
      display_name: 'Notes',
      tier: 'full_control',
      approved_at_wall: Date.now(),
      sentinel_confirmed: false,
    }],
    scope: 'full',
    allowlist_version: 1,
    self_test_enabled: false,
    screenshot_attach_to_llm: true,
    isolate_other_apps: true,
    pid_lock: 42,
    started_at_mono: 1,
    started_at_wall: 1_700_000_000,
    last_activity_mono: 1,
    idle_timeout_secs: 900,
  }, {
    conversationId: 'conversation-1',
    originalModelId: 'text-model',
    executorModelId: 'vision-model',
    startedAtMs: 1,
    expiresAtMs: Date.now() + 60_000,
  }, 'Text Model', 'Vision Model')
}

describe('computerUseStore', () => {
  beforeEach(() => {
    computerUseStore.__reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts idle', () => {
    expect(computerUseStore.getSnapshot().status).toBe('idle')
    expect(computerUseStore.getSnapshot().layout).toEqual({ mode: 'idle' })
  })

  it('accepts compact layout only for the matching active or paused session', async () => {
    computerUseStore.__mockRequestConsent({ goal: 'Write in Notes', appName: 'Notes' })
    await computerUseStore.grant({ type: 'session' })
    const sessionId = computerUseStore.getSnapshot().session!.id

    computerUseStore.handleNativeLayoutState({
      mode: 'compact',
      sessionId: 'another-session',
      targetBundleId: 'com.apple.Notes',
    })
    expect(computerUseStore.getSnapshot().layout).toEqual({ mode: 'idle' })

    computerUseStore.handleNativeLayoutState({
      mode: 'compact',
      sessionId,
      targetBundleId: 'com.apple.Notes',
    })
    expect(computerUseStore.isCompact()).toBe(true)

    await computerUseStore.pause()
    expect(computerUseStore.isCompact()).toBe(true)

    await computerUseStore.stop('user_cancelled')
    expect(computerUseStore.getSnapshot().layout).toEqual({ mode: 'idle' })
    expect(computerUseStore.isCompact()).toBe(false)
  })

  it('keeps entering and fallback as full-window presentation states', async () => {
    computerUseStore.__mockRequestConsent({ goal: 'Write in Notes', appName: 'Notes' })
    await computerUseStore.grant({ type: 'session' })
    const sessionId = computerUseStore.getSnapshot().session!.id

    computerUseStore.handleNativeLayoutState({ mode: 'entering', sessionId })
    expect(computerUseStore.isCompact()).toBe(false)
    expect(computerUseStore.getSnapshot().layout.mode).toBe('entering')

    computerUseStore.handleNativeLayoutState({ mode: 'fallback', sessionId })
    expect(computerUseStore.isCompact()).toBe(false)
    expect(computerUseStore.getSnapshot().layout.mode).toBe('fallback')
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

  it('preserves executor disclosure from consent into the active session', async () => {
    computerUseStore.__mockRequestConsent({
      goal: 'Write in Notes',
      appName: 'Notes',
      requestedTier: 'full_control',
      originalModel: { id: 'text', displayName: 'Text Model' },
      executorModel: { id: 'vision', displayName: 'Vision Model' },
      temporaryExecutor: true,
    })

    await computerUseStore.grant({ type: 'session' })

    expect(computerUseStore.getSnapshot().session).toMatchObject({
      requestedTier: 'full_control',
      originalModel: { id: 'text', displayName: 'Text Model' },
      executorModel: { id: 'vision', displayName: 'Vision Model' },
      temporaryExecutor: true,
    })
  })

  it('rehydrates only the native session supplied by verified executor-lease recovery', () => {
    const session = restoreNativeExecutorLease()

    expect(session).toMatchObject({
      id: 'native-session',
      status: 'active',
      appName: 'Notes',
      appBundleId: 'com.apple.Notes',
      originalModel: { id: 'text-model', displayName: 'Text Model' },
      executorModel: { id: 'vision-model', displayName: 'Vision Model' },
      temporaryExecutor: true,
      startedAt: 1_700_000_000_000,
    })
    expect(computerUseStore.getSnapshot().session).toEqual(session)
  })

  it('re-synchronizes the verified action sequence after executor-lease recovery', () => {
    restoreNativeExecutorLease()
    const firstEventAfterReload = {
      sessionId: 'native-session',
      verb: 'click' as const,
      targetLabel: 'approved app',
      appName: 'Notes',
      elapsedMs: 10,
      actionIndex: 6,
    }

    computerUseStore.handleNativeAction(firstEventAfterReload)
    expect(computerUseStore.getSnapshot().session).toMatchObject({
      actionCount: 7,
      lastAction: firstEventAfterReload,
    })

    computerUseStore.handleNativeAction({ ...firstEventAfterReload, actionIndex: 8 })
    expect(computerUseStore.getSnapshot().session?.actionCount).toBe(7)

    computerUseStore.handleNativeAction({ ...firstEventAfterReload, actionIndex: 7 })
    expect(computerUseStore.getSnapshot().session?.actionCount).toBe(8)
  })

  it('accepts only the next verified action and preserves progress across pause', async () => {
    computerUseStore.__mockRequestConsent({ goal: 'G', appName: 'Notes' })
    await computerUseStore.grant({ type: 'session' })
    const event = {
      sessionId: computerUseStore.getSnapshot().session!.id,
      verb: 'click' as const,
      targetLabel: 'approved app',
      appName: 'Notes',
      elapsedMs: 10,
      actionIndex: 0,
    }
    computerUseStore.handleNativeAction(event)
    computerUseStore.handleNativeAction(event)
    computerUseStore.handleNativeAction({ ...event, actionIndex: 2 })
    expect(computerUseStore.getSnapshot().session?.actionCount).toBe(1)

    await computerUseStore.pause()
    expect(computerUseStore.getSnapshot().session).toMatchObject({
      status: 'paused',
      actionCount: 1,
      lastAction: event,
    })
  })

  it('tracks only the matching in-progress native action without counting it as verified', async () => {
    computerUseStore.__mockRequestConsent({ goal: 'G', appName: 'Notes' })
    await computerUseStore.grant({ type: 'session' })
    const sessionId = computerUseStore.getSnapshot().session!.id
    const pending = {
      sessionId,
      actionId: 'tool-use-1',
      verb: 'type' as const,
      targetLabel: 'approved text field',
      appName: 'Notes',
      elapsedMs: 10,
    }

    computerUseStore.handleNativeActionPending(pending)
    expect(computerUseStore.getSnapshot().session).toMatchObject({
      currentAction: pending,
      actionCount: 0,
    })

    computerUseStore.handleNativeActionSettled({ sessionId, actionId: 'another-tool-use' })
    expect(computerUseStore.getSnapshot().session?.currentAction).toEqual(pending)

    computerUseStore.handleNativeActionSettled({ sessionId, actionId: pending.actionId })
    expect(computerUseStore.getSnapshot().session?.currentAction).toBeUndefined()
    expect(computerUseStore.getSnapshot().session?.actionCount).toBe(0)
  })

  describe('native bridge', () => {
    const originalVerboo = (window as unknown as { verboo?: unknown }).verboo
    const nativeBinding = {
      conversationId: 'conversation-1',
      executorModelId: 'vision-model',
    }

    function mockNativeBridge(overrides: {
      request?: (goal: string, app: string | null, scope: string) => Promise<unknown>
      grant?: (
        id: string,
        screenshot: boolean,
        appDisplayName?: string,
        requestedTier?: string,
        sentinelConfirmed?: boolean,
      ) => Promise<unknown>
      deny?: (id: string) => Promise<void>
      stop?: (id: string, reason: string) => Promise<void>
      pause?: (id: string) => Promise<unknown>
      resume?: (id: string) => Promise<unknown>
      approveApp?: (
        id: string,
        bundleId: string,
        displayName: string,
        tier: string,
        sentinelConfirmed: boolean,
      ) => Promise<unknown>
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
        pauseComputerUseSession: overrides.pause,
        resumeComputerUseSession: overrides.resume,
        approveComputerUseApp: overrides.approveApp ?? vi.fn().mockImplementation(async (
          _id: string,
          bundleId: string,
          displayName: string,
          tier: string,
          sentinelConfirmed: boolean,
        ) => ({
          id: 'rust-sess-1',
          state: 'active',
          goal: 'Native goal',
          target_app: 'com.apple.Safari',
          active_app: bundleId,
          approved_apps: [{
            bundle_id: bundleId,
            display_name: displayName,
            tier,
            approved_at_wall: Date.now(),
            sentinel_confirmed: sentinelConfirmed,
          }],
          scope: 'full',
          allowlist_version: 1,
          self_test_enabled: false,
          screenshot_attach_to_llm: true,
          pid_lock: 12345,
          started_at_mono: 1000,
          started_at_wall: Date.now(),
          last_activity_mono: 1000,
          idle_timeout_secs: 900,
        })),
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
        ...nativeBinding,
        goal: 'Click save',
        appName: 'Safari',
        appBundleId: 'com.apple.Safari',
        scope: 'input',
        hiddenAppCount: 3,
      })
      expect(bridge.requestComputerUseSession).toHaveBeenCalledWith(
        'Click save',
        'com.apple.Safari',
        'input',
        'conversation-1',
        'vision-model',
      )
      expect(computerUseStore.getSnapshot().status).toBe('consent')
      expect(computerUseStore.getSnapshot().pendingRequest?.id).toBe('rust-req-1')
      expect(computerUseStore.getSnapshot().pendingRequest).toMatchObject(nativeBinding)
      expect(computerUseStore.getSnapshot().pendingRequest?.appName).toBe('Safari')
      expect(computerUseStore.getSnapshot().pendingRequest?.hiddenAppCount).toBe(3)
    })

    it('grant calls native grant_computer_use_session and translates session', async () => {
      const bridge = mockNativeBridge({})
      await computerUseStore.requestConsent({
        ...nativeBinding,
        goal: 'Click save',
        appName: 'Safari',
        appBundleId: 'com.apple.Safari',
        scope: 'input',
        requestedTier: 'view_only',
      })
      await computerUseStore.grant({ type: 'once' })
      expect(bridge.grantComputerUseSession).toHaveBeenCalledWith(
        'rust-req-1',
        true,
        'Safari',
        'view_only',
        false,
      )
      expect(computerUseStore.getSnapshot().status).toBe('active')
      expect(computerUseStore.getSnapshot().session?.id).toBe('rust-sess-1')
      expect(computerUseStore.getSnapshot().session).toMatchObject(nativeBinding)
      expect(computerUseStore.getSnapshot().session?.appName).toBe('Safari')
      expect(computerUseStore.getSnapshot().session?.isSelfTest).toBe(false)
    })

    it('passes a user-selected narrower tier to native grant and the renderer session', async () => {
      const bridge = mockNativeBridge({})
      await computerUseStore.requestConsent({
        ...nativeBinding,
        goal: 'Click save',
        appName: 'Notes',
        appBundleId: 'com.apple.Notes',
        scope: 'full',
        requestedTier: 'full_control',
      })

      await computerUseStore.grant({ type: 'session' }, 'click_only')

      expect(bridge.grantComputerUseSession).toHaveBeenCalledWith(
        'rust-req-1',
        true,
        'Notes',
        'click_only',
        false,
      )
      expect(computerUseStore.getSnapshot().session?.requestedTier).toBe('click_only')
    })

    it('deny calls native deny_computer_use_session', async () => {
      const bridge = mockNativeBridge({})
      await computerUseStore.requestConsent({ ...nativeBinding, goal: 'G', appName: 'App', scope: 'ask' })
      await computerUseStore.deny('user_denied')
      expect(bridge.denyComputerUseSession).toHaveBeenCalledWith('rust-req-1')
      expect(computerUseStore.getSnapshot().status).toBe('denied')
    })

    it('stop calls native stop_computer_use_session with reason', async () => {
      const bridge = mockNativeBridge({})
      await computerUseStore.requestConsent({ ...nativeBinding, goal: 'G', appName: 'App', scope: 'ask' })
      await computerUseStore.grant({ type: 'once' })
      await computerUseStore.stop('user_cancelled')
      expect(bridge.stopComputerUseSession).toHaveBeenCalledWith('rust-sess-1', 'user_cancelled')
      expect(computerUseStore.getSnapshot().status).toBe('stopped')
    })

    it('keeps the safe state and rejects when native pause, resume, or stop cannot be confirmed', async () => {
      const pauseError = new Error('native pause failed')
      const resumeError = new Error('native resume failed')
      const stopError = new Error('native stop failed')
      mockNativeBridge({
        pause: vi.fn().mockRejectedValue(pauseError),
        resume: vi.fn().mockRejectedValue(resumeError),
        stop: vi.fn().mockRejectedValue(stopError),
      })
      await computerUseStore.requestConsent({ ...nativeBinding, goal: 'G', appName: 'App', scope: 'ask' })
      await computerUseStore.grant({ type: 'session' })

      await expect(computerUseStore.pause()).rejects.toBe(pauseError)
      expect(computerUseStore.getSnapshot().status).toBe('active')

      ;(window as unknown as { verboo: { pauseComputerUseSession?: unknown } }).verboo.pauseComputerUseSession = undefined
      await computerUseStore.pause()
      expect(computerUseStore.getSnapshot().status).toBe('paused')

      await expect(computerUseStore.resume()).rejects.toBe(resumeError)
      expect(computerUseStore.getSnapshot().status).toBe('paused')

      await expect(computerUseStore.stop('user_cancelled')).rejects.toBe(stopError)
      expect(computerUseStore.getSnapshot().status).toBe('paused')
      expect(computerUseStore.getSnapshot().lastStop).toBeUndefined()
    })

    it('rejects an emergency stop failure and keeps the banner state active', async () => {
      const stopError = new Error('native emergency stop failed')
      mockNativeBridge({ stop: vi.fn().mockRejectedValue(stopError) })
      await computerUseStore.requestConsent({ ...nativeBinding, goal: 'G', appName: 'App', scope: 'ask' })
      await computerUseStore.grant({ type: 'session' })

      await expect(computerUseStore.emergencyStop()).rejects.toBe(stopError)
      expect(computerUseStore.getSnapshot().status).toBe('active')
      expect(computerUseStore.getSnapshot().isEmergencyFlashing).toBe(false)
    })

    it('emergencyStop calls native stop with emergency reason', async () => {
      vi.useFakeTimers()
      const bridge = mockNativeBridge({})
      await computerUseStore.requestConsent({ ...nativeBinding, goal: 'G', appName: 'App', scope: 'ask' })
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

    it('explicitly approves and activates an additional app in the same session', async () => {
      const bridge = mockNativeBridge({})
      await computerUseStore.requestConsent({
        ...nativeBinding,
        goal: 'Copy into Notes',
        appName: 'Safari',
        appBundleId: 'com.apple.Safari',
        scope: 'full',
        requestedTier: 'view_only',
      })
      await computerUseStore.grant({ type: 'session' })

      await computerUseStore.approveApp({
        bundleId: 'com.apple.Notes',
        displayName: 'Notes',
        tier: 'full_control',
        sentinelConfirmed: false,
      })

      expect(bridge.approveComputerUseApp).toHaveBeenCalledWith(
        'rust-sess-1',
        'com.apple.Notes',
        'Notes',
        'full_control',
        false,
      )
      expect(computerUseStore.getSnapshot().session).toMatchObject({
        appName: 'Notes',
        appBundleId: 'com.apple.Notes',
        approvedApps: [{ bundleId: 'com.apple.Notes', tier: 'full_control' }],
      })
    })

    it('request failure surfaces as denied', async () => {
      mockNativeBridge({
        request: vi.fn().mockRejectedValue(new Error('policy block')),
      })
      await computerUseStore.requestConsent({ ...nativeBinding, goal: 'G', appName: 'App', scope: 'ask' })
      expect(computerUseStore.getSnapshot().status).toBe('denied')
      expect(computerUseStore.getSnapshot().lastDeny?.reason).toBe('app_hard_blocked')
      expect(computerUseStore.getSnapshot().lastDeny).not.toHaveProperty('detail')
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
        ...nativeBinding,
        goal: 'Teste a feature que acabei de adicionar',
        scope: 'input',
      })
      expect(bridge.requestComputerUseSession).toHaveBeenCalledWith(
        'Teste a feature que acabei de adicionar',
        null,
        'input',
        'conversation-1',
        'vision-model',
      )
      expect(computerUseStore.getSnapshot().status).toBe('consent')
      expect(computerUseStore.getSnapshot().pendingRequest?.appBundleId).toBeUndefined()
      expect(computerUseStore.getSnapshot().pendingRequest?.appName).toBe('Teste a feature que acabei de adicionar')
    })

    it('normalizes Rust consent timestamps from seconds before timeout math', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000)
      mockNativeBridge({
        request: vi.fn().mockResolvedValue({
          id: 'rust-req-seconds',
          goal: 'Native goal',
          app: 'Safari',
          scope: 'input',
          created_at_mono: nowSeconds,
          created_at_wall: nowSeconds,
        }),
      })

      await computerUseStore.requestConsent({ ...nativeBinding, goal: 'G', appName: 'Safari', scope: 'input' })

      const createdAt = computerUseStore.getSnapshot().pendingRequest?.createdAt
      expect(createdAt).toBe(nowSeconds * 1000)
      expect(Date.now() - (createdAt ?? 0)).toBeLessThan(2_000)
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
        ...nativeBinding,
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

  it('creates a stop receipt when a native stopped state arrives directly', () => {
    restoreNativeExecutorLease()

    computerUseStore.handleNativeStateChange({
      id: 'native-session',
      state: 'stopped',
      conversation_id: 'conversation-1',
      executor_model_id: 'vision-model',
      goal: 'Write a note',
      target_app: 'com.apple.Notes',
      active_app: 'com.apple.Notes',
      scope: 'full',
      allowlist_version: 1,
      self_test_enabled: false,
      screenshot_attach_to_llm: true,
      isolate_other_apps: true,
      pid_lock: 42,
      started_at_mono: 1,
      started_at_wall: 1_700_000_000,
      last_activity_mono: 1,
      idle_timeout_secs: 900,
    })

    expect(computerUseStore.getSnapshot()).toMatchObject({
      status: 'stopped',
      lastStop: {
        reason: 'error',
        actionCount: 0,
      },
    })
    expect(computerUseStore.getSnapshot().session?.currentAction).toBeUndefined()
  })
})
