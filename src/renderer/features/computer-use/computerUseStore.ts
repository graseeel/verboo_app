/**
 * computerUseStore.ts — module-level store for Computer Use session state.
 *
 * State machine per docs/computer-use-architecture-v1.md §2.1:
 *   idle → consent → active ⇄ paused → stopped
 *                  → denied
 *                  → emergency-stopping → stopped
 *
 * Two execution paths:
 *   1. NATIVE (P0.6): when window.verboo.requestComputerUseSession exists,
 *      all actions call Tauri invoke. State is driven by invoke responses.
 *      Event listeners (onComputerUseStateChange/Action/EmergencyStop) are
 *      wired by useComputerUseSession — they fire when Geralt adds emit().
 *   2. MOCK (fallback): when native bridge absent, store simulates the
 *      session lifecycle locally so UX is testable in isolation.
 *
 * The renderer shape (ComputerUseSession) is richer than the Rust shape
 * (RustSession) — we add convenience fields like appName, isSelfTest,
 * lastAction, actionCount that the banner needs. Translation happens here.
 */

import type {
  ComputerUseActionEvent,
  ComputerUsePendingActionEvent,
  ComputerUseSettledActionEvent,
  ComputerUseConsentGrant,
  ComputerUseConsentRequest,
  ComputerUseDenyReason,
  ComputerUseExecutorLease,
  ComputerUseLayoutState,
  ComputerUseScope,
  ComputerUseSession,
  ComputerUseSettings,
  ComputerUseStopReason,
  ComputerUseTurnCompleteEvent,
} from '../../../shared/types'
import {
  isComputerUseTierAtMost,
  scopeForComputerUseTier,
} from './appControlTier'

// ── Native bridge detection ─────────────────────────────────────
type NativeBridge = {
  requestComputerUseSession?: (
    goal: string,
    app: string | null,
    scope: ComputerUseScope,
    conversationId: string,
    executorModelId: string,
  ) => Promise<import('../../../renderer/verboo-bridge').RustConsentRequest>
  grantComputerUseSession?: (
    requestId: string,
    screenshotAttachToLlm: boolean,
    appDisplayName?: string,
    requestedTier?: ComputerUseConsentRequest['requestedTier'],
    sentinelConfirmed?: boolean,
  ) => Promise<import('../../../renderer/verboo-bridge').RustSession>
  denyComputerUseSession?: (requestId: string) => Promise<void>
  stopComputerUseSession?: (sessionId: string, reason: 'user_cancelled' | 'emergency') => Promise<void>
  pauseComputerUseSession?: (sessionId: string) => Promise<import('../../../renderer/verboo-bridge').RustSession>
  resumeComputerUseSession?: (sessionId: string) => Promise<import('../../../renderer/verboo-bridge').RustSession>
  approveComputerUseApp?: (
    sessionId: string,
    bundleId: string,
    displayName: string,
    tier: import('../../../shared/types').ComputerUseAppTier,
    sentinelConfirmed: boolean,
  ) => Promise<import('../../../renderer/verboo-bridge').RustSession>
}

function getNativeBridge(): NativeBridge {
  if (typeof window === 'undefined') return {}
  return (window as unknown as { verboo?: NativeBridge }).verboo ?? {}
}

function isNativeReady(): boolean {
  const b = getNativeBridge()
  return typeof b.requestComputerUseSession === 'function'
}

// ── Rust → renderer translation ─────────────────────────────────
// Rust Session has `state` not `status`, `started_at_wall` not `startedAt`,
// no `appName`/`isSelfTest`/`lastAction`/`actionCount`/`stopReason`.
// We synthesize the renderer shape, preserving any fields we already had
// from the consent request (goal, appName, isSelfTest).

function rustWallTimeToMillis(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function rustSessionToRenderer(
  rust: import('../../../renderer/verboo-bridge').RustSession,
  fallback: {
    conversationId?: string
    executorModelId?: string
    goal?: string
    appName?: string
    appBundleId?: string
    isSelfTest?: boolean
    requestedTier?: ComputerUseConsentRequest['requestedTier']
    originalModel?: ComputerUseConsentRequest['originalModel']
    executorModel?: ComputerUseConsentRequest['executorModel']
    temporaryExecutor?: boolean
    lastAction?: ComputerUseSession['lastAction']
    currentAction?: ComputerUseSession['currentAction']
    actionCount?: number
  },
): ComputerUseSession {
  const stateMap: Record<string, ComputerUseSession['status']> = {
    idle: 'idle',
    consent: 'consent',
    active: 'active',
    paused: 'paused',
    stopped: 'stopped',
  }
  return {
    id: rust.id,
    status: stateMap[rust.state] ?? 'idle',
    conversationId: rust.conversation_id || fallback.conversationId,
    executorModelId: rust.executor_model_id || fallback.executorModelId,
    goal: rust.goal ?? fallback.goal ?? '',
    appName: fallback.appName ?? rust.goal ?? '',
    appBundleId: fallback.appBundleId ?? rust.active_app ?? rust.target_app ?? undefined,
    scope: rust.scope,
    requestedTier: fallback.requestedTier,
    approvedApps: rust.approved_apps?.map(app => ({
      bundleId: app.bundle_id,
      displayName: app.display_name,
      tier: app.tier,
      sentinelConfirmed: app.sentinel_confirmed,
    })),
    originalModel: fallback.originalModel,
    executorModel: fallback.executorModel,
    temporaryExecutor: fallback.temporaryExecutor,
    isSelfTest: rust.self_test_enabled || fallback.isSelfTest === true,
    startedAt: rustWallTimeToMillis(rust.started_at_wall),
    lastAction: fallback.lastAction,
    currentAction: fallback.currentAction,
    actionCount: fallback.actionCount ?? 0,
  }
}

// ── Store state ─────────────────────────────────────────────────

type Listener = () => void

export type ComputerUseState = {
  status: ComputerUseSession['status']
  /** Native main-window lease. Compact UI is derived from this state only. */
  layout: ComputerUseLayoutState
  /** Present when status === 'consent'. */
  pendingRequest?: ComputerUseConsentRequest
  /** Present when status === 'active' | 'paused' | 'emergency-stopping' | 'stopped'. */
  session?: ComputerUseSession
  /** Set when status === 'stopped' — drives StoppedToast (4s auto-clear). */
  lastStop?: {
    reason: ComputerUseStopReason
    turnReason?: ComputerUseTurnCompleteEvent['stoppedReason']
    actionCount: number
    durationMs: number
    at: number
  }
  /** Set when status === 'denied' — drives inline toast (4s auto-clear). */
  lastDeny?: { reason: ComputerUseDenyReason; at: number }
  /** Whether the emergency-stop overlay is mid-animation (600ms). */
  isEmergencyFlashing: boolean
}

const INITIAL: ComputerUseState = {
  status: 'idle',
  layout: { mode: 'idle' },
  isEmergencyFlashing: false,
}

let state: ComputerUseState = INITIAL
const listeners = new Set<Listener>()
let recoveredActionSequenceSessionId: string | undefined

function setState(next: Partial<ComputerUseState>): void {
  const merged = { ...state, ...next }
  state = (merged.status === 'active' || merged.status === 'paused')
    ? merged
    : { ...merged, layout: { mode: 'idle' } }
  for (const l of listeners) l()
}

function subscribe(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function getSnapshot(): ComputerUseState {
  return state
}

export function isComputerUseCompactState(candidate: ComputerUseState): boolean {
  return candidate.layout.mode === 'compact'
    && candidate.layout.sessionId === candidate.session?.id
    && (candidate.status === 'active' || candidate.status === 'paused')
}

// ── Mock session lifecycle (fallback only) ──────────────────────
let mockActionTimer: ReturnType<typeof setInterval> | undefined
let emergencyFlashTimer: ReturnType<typeof setTimeout> | undefined
let terminalClearTimer: ReturnType<typeof setTimeout> | undefined
let mockActionIndex = 0
const MOCK_VERBS = ['click', 'type', 'read', 'scroll'] as const
const MOCK_TARGETS = ['"Save" button', 'email field', 'window list', 'scroll area']

function clearMockTimer(): void {
  if (mockActionTimer) {
    clearInterval(mockActionTimer)
    mockActionTimer = undefined
  }
}

function clearLifecycleTimers(): void {
  if (emergencyFlashTimer) {
    clearTimeout(emergencyFlashTimer)
    emergencyFlashTimer = undefined
  }
  if (terminalClearTimer) {
    clearTimeout(terminalClearTimer)
    terminalClearTimer = undefined
  }
}

function scheduleTerminalClear(): void {
  if (terminalClearTimer) clearTimeout(terminalClearTimer)
  terminalClearTimer = setTimeout(() => {
    terminalClearTimer = undefined
    if (state.status === 'stopped') {
      setState({ status: 'idle', session: undefined, lastStop: undefined })
    }
  }, 4000)
}

function startMockActions(session: ComputerUseSession): void {
  clearMockTimer()
  mockActionIndex = 0
  mockActionTimer = setInterval(() => {
    if (state.session?.id !== session.id || state.status !== 'active') {
      clearMockTimer()
      return
    }
    mockActionIndex += 1
    const verb = MOCK_VERBS[mockActionIndex % MOCK_VERBS.length]!
    const target = MOCK_TARGETS[mockActionIndex % MOCK_TARGETS.length]!
    const evt: ComputerUseActionEvent = {
      sessionId: session.id,
      verb,
      targetLabel: target,
      appName: session.appName,
      elapsedMs: Date.now() - session.startedAt,
      actionIndex: mockActionIndex,
    }
    const updated: ComputerUseSession = {
      ...session,
      lastAction: evt,
      actionCount: mockActionIndex,
    }
    setState({ session: updated })
  }, 2200)
}

// ── Public actions ──────────────────────────────────────────────

export const computerUseStore = {
  subscribe,
  getSnapshot,

  isCompact(): boolean {
    return isComputerUseCompactState(state)
  },

  /** Step 1: agent or user invokes a consent request. In native mode this
   *  calls request_computer_use_session and translates the Rust response.
   *  In mock mode, synthesizes a request locally. */
  async requestConsent(params: {
    goal: string
    appName?: string
    appBundleId?: string
    appIconBase64?: string
    scope: ComputerUseScope
    isSelfTest?: boolean
    timeoutMs?: number
    requestedTier?: ComputerUseConsentRequest['requestedTier']
    originalModel?: ComputerUseConsentRequest['originalModel']
    executorModel?: ComputerUseConsentRequest['executorModel']
    temporaryExecutor?: boolean
    sentinelConfirmationRequired?: boolean
    hiddenAppCount?: number
    conversationId: string
    executorModelId: string
  }): Promise<void> {
    clearMockTimer()
    const native = getNativeBridge()
    if (isNativeReady() && native.requestComputerUseSession) {
      try {
        const rust = await native.requestComputerUseSession(
          params.goal,
          params.appBundleId ?? null,
          params.scope,
          params.conversationId,
          params.executorModelId,
        )
        const req: ComputerUseConsentRequest = {
          id: rust.id,
          conversationId: rust.conversation_id || params.conversationId,
          executorModelId: rust.executor_model_id || params.executorModelId,
          goal: rust.goal,
          appName: params.appName ?? rust.app ?? params.goal,
          appBundleId: params.appBundleId ?? rust.app ?? undefined,
          appIconBase64: params.appIconBase64,
          scope: rust.scope,
          requestedTier: params.requestedTier,
          originalModel: params.originalModel,
          executorModel: params.executorModel,
          temporaryExecutor: params.temporaryExecutor,
          sentinelConfirmationRequired: params.sentinelConfirmationRequired,
          isSelfTest: params.isSelfTest,
          hiddenAppCount: normalizeHiddenAppCount(params.hiddenAppCount),
          createdAt: rustWallTimeToMillis(rust.created_at_wall),
          timeoutMs: params.timeoutMs ?? 30000,
        }
        setState({
          status: 'consent',
          pendingRequest: req,
          session: undefined,
          lastStop: undefined,
          lastDeny: undefined,
          isEmergencyFlashing: false,
        })
        return
      } catch (err) {
        // Native request failed (e.g. policy block, OS perm missing). Keep
        // backend/provider text out of renderer state and show only a
        // controlled, localized reason.
        console.error('[computer-use] session request denied', err)
        const reason = nativeDenyReason(err)
        setState({
          status: 'denied',
          lastDeny: { reason, at: Date.now() },
        })
        setTimeout(() => {
          if (state.status === 'denied') setState({ status: 'idle', lastDeny: undefined })
        }, 4000)
        return
      }
    }

    // Mock fallback
    const req: ComputerUseConsentRequest = {
      id: `cu-req:${crypto.randomUUID()}`,
      conversationId: params.conversationId,
      executorModelId: params.executorModelId,
      goal: params.goal,
      appName: params.appName ?? 'Verboo Settings',
      appBundleId: params.appBundleId ?? 'ai.verboo.code.desktop',
      appIconBase64: params.appIconBase64,
      scope: params.scope,
      requestedTier: params.requestedTier,
      originalModel: params.originalModel,
      executorModel: params.executorModel,
      temporaryExecutor: params.temporaryExecutor,
      sentinelConfirmationRequired: params.sentinelConfirmationRequired,
      isSelfTest: params.isSelfTest ?? false,
      hiddenAppCount: normalizeHiddenAppCount(params.hiddenAppCount),
      createdAt: Date.now(),
      timeoutMs: params.timeoutMs ?? 30000,
    }
    setState({
      status: 'consent',
      pendingRequest: req,
      session: undefined,
      lastStop: undefined,
      lastDeny: undefined,
      isEmergencyFlashing: false,
    })
  },

  /** Renderer-only: receive a consent request from an external trigger
   *  (e.g. native event). Kept for backward compat with the hook. */
  receiveConsentRequest(req: ComputerUseConsentRequest): void {
    clearMockTimer()
    setState({
      status: 'consent',
      pendingRequest: {
        ...req,
        hiddenAppCount: normalizeHiddenAppCount(req.hiddenAppCount),
      },
      session: undefined,
      lastStop: undefined,
      lastDeny: undefined,
      isEmergencyFlashing: false,
    })
  },

  /** Step 2: user grants consent. Calls grant_computer_use_session in native
   *  mode. The `type` ('once' | 'session') and `rememberApp` are renderer
   *  concerns — Rust doesn't know about them. `rememberApp` routes to
   *  allowlist via a separate updateComputerUseAllowlist call (Settings). */
  async grant(
    grant: ComputerUseConsentGrant,
    requestedTierOverride?: ComputerUseConsentRequest['requestedTier'],
  ): Promise<void> {
    const req = state.pendingRequest
    if (!req) return
    const maximumTier = req.requestedTier
      ?? (req.scope === 'view' || req.scope === 'ask' ? 'view_only' : 'full_control')
    const selectedTier = requestedTierOverride
      && isComputerUseTierAtMost(requestedTierOverride, maximumTier)
      ? requestedTierOverride
      : maximumTier
    const native = getNativeBridge()
    if (isNativeReady() && native.grantComputerUseSession) {
      try {
        // The consent modal explicitly discloses that the authorized app
        // window is captured and sent to the selected model provider.
        const rustSession = await native.grantComputerUseSession(
          req.id,
          true,
          req.appName,
          selectedTier,
          Boolean(req.sentinelConfirmationRequired),
        )
        const session = rustSessionToRenderer(rustSession, {
          conversationId: req.conversationId,
          executorModelId: req.executorModelId,
          goal: req.goal,
          appName: req.appName,
          appBundleId: req.appBundleId,
          isSelfTest: req.isSelfTest,
          requestedTier: selectedTier,
          originalModel: req.originalModel,
          executorModel: req.executorModel,
          temporaryExecutor: req.temporaryExecutor,
        })
        setState({
          status: 'active',
          pendingRequest: undefined,
          session: { ...session, status: 'active' },
        })
        return
      } catch (err) {
        // Grant failed (e.g. consent expired, OS perm revoked). Deny.
        console.error('[computer-use] session grant denied', err)
        setState({
          status: 'denied',
          pendingRequest: undefined,
          lastDeny: { reason: nativeDenyReason(err), at: Date.now() },
        })
        setTimeout(() => {
          if (state.status === 'denied') setState({ status: 'idle', lastDeny: undefined })
        }, 4000)
        return
      }
    }

    // Mock fallback
    const session: ComputerUseSession = {
      id: `cu:${crypto.randomUUID()}`,
      status: 'active',
      conversationId: req.conversationId,
      executorModelId: req.executorModelId,
      goal: req.goal,
      appName: req.appName,
      appBundleId: req.appBundleId,
      scope: scopeForComputerUseTier(selectedTier),
      requestedTier: selectedTier,
      approvedApps: req.appBundleId ? [{
        bundleId: req.appBundleId,
        displayName: req.appName,
        tier: selectedTier,
        sentinelConfirmed: Boolean(req.sentinelConfirmationRequired),
      }] : undefined,
      originalModel: req.originalModel,
      executorModel: req.executorModel,
      temporaryExecutor: req.temporaryExecutor,
      isSelfTest: req.isSelfTest ?? false,
      startedAt: Date.now(),
      actionCount: 0,
    }
    setState({ status: 'active', pendingRequest: undefined, session })
    startMockActions(session)
  },

  async deny(reason: ComputerUseDenyReason = 'user_denied'): Promise<void> {
    const req = state.pendingRequest
    if (!req) return
    const native = getNativeBridge()
    if (isNativeReady() && native.denyComputerUseSession) {
      try {
        await native.denyComputerUseSession(req.id)
      } catch (error) {
        // Deny failed — still transition locally so UI doesn't hang.
      }
    }
    setState({
      status: 'denied',
      pendingRequest: undefined,
      lastDeny: { reason, at: Date.now() },
    })
    setTimeout(() => {
      if (state.status === 'denied') setState({ status: 'idle', lastDeny: undefined })
    }, 4000)
  },

  async approveApp(params: {
    bundleId: string
    displayName: string
    tier: import('../../../shared/types').ComputerUseAppTier
    sentinelConfirmed: boolean
  }): Promise<void> {
    const current = state.session
    if (!current || (state.status !== 'active' && state.status !== 'paused')) return
    const native = getNativeBridge()
    if (isNativeReady() && native.approveComputerUseApp) {
      const rust = await native.approveComputerUseApp(
        current.id,
        params.bundleId,
        params.displayName,
        params.tier,
        params.sentinelConfirmed,
      )
      const session = rustSessionToRenderer(rust, {
        conversationId: current.conversationId,
        executorModelId: current.executorModelId,
        goal: current.goal,
        appName: params.displayName,
        appBundleId: params.bundleId,
        isSelfTest: current.isSelfTest,
        requestedTier: params.tier,
        originalModel: current.originalModel,
        executorModel: current.executorModel,
        temporaryExecutor: current.temporaryExecutor,
        lastAction: current.lastAction,
        currentAction: current.currentAction,
        actionCount: current.actionCount,
      })
      setState({ status: session.status, session })
      return
    }

    const approvedApps = [
      ...(current.approvedApps ?? []).filter(app => app.bundleId !== params.bundleId),
      {
        bundleId: params.bundleId,
        displayName: params.displayName,
        tier: params.tier,
        sentinelConfirmed: params.sentinelConfirmed,
      },
    ]
    setState({
      session: {
        ...current,
        appName: params.displayName,
        appBundleId: params.bundleId,
        requestedTier: params.tier,
        approvedApps,
      },
    })
  },

  async pause(): Promise<void> {
    const s = state.session
    if (!s || state.status !== 'active') return
    const native = getNativeBridge()
    if (native.pauseComputerUseSession) await native.pauseComputerUseSession(s.id)
    clearMockTimer()
    setState({ status: 'paused', session: { ...s, status: 'paused' } })
  },

  async resume(): Promise<void> {
    const s = state.session
    if (!s || state.status !== 'paused') return
    const native = getNativeBridge()
    if (native.resumeComputerUseSession) await native.resumeComputerUseSession(s.id)
    const active: ComputerUseSession = { ...s, status: 'active' }
    setState({ status: 'active', session: active })
    if (!isNativeReady()) {
      startMockActions(active)
    }
  },

  async stop(reason: ComputerUseStopReason = 'user_cancelled'): Promise<void> {
    const s = state.session
    if (!s) return
    const native = getNativeBridge()
    if (isNativeReady() && native.stopComputerUseSession) {
      const rustReason: 'user_cancelled' | 'emergency' =
        reason === 'emergency_stop' ? 'emergency' : 'user_cancelled'
      try {
        await native.stopComputerUseSession(s.id, rustReason)
      } catch (error) {
        // When Rust already stopped the session (TCC revoke, idle, etc.),
        // still clear the banner for those reasons. For user-initiated
        // stop failures, keep the banner visible — control may still be active.
        if (reason !== 'os_permission_revoked' && reason !== 'session_expired') {
          throw error
        }
      }
    }
    clearMockTimer()
    const durationMs = Date.now() - s.startedAt
    setState({
      status: 'stopped',
      session: { ...s, status: 'stopped', stopReason: reason, currentAction: undefined },
      lastStop: { reason, actionCount: s.actionCount, durationMs, at: Date.now() },
    })
    scheduleTerminalClear()
  },

  /** Emergency stop — fires immediately, no confirmation. Triggers the
   *  600ms overlay flash, then transitions to stopped. Called from:
   *  - Esc key when Verboo has focus (useComputerUseSession keybind)
   *  - ControlBanner Cancel button
   *  - Native event onComputerUseEmergencyStop (when Geralt wires it) */
  async emergencyStop(alreadyRevoked = false): Promise<void> {
    if (state.status !== 'active' && state.status !== 'paused') return
    const s = state.session
    const native = getNativeBridge()
    if (!alreadyRevoked && isNativeReady() && native.stopComputerUseSession && s) {
      try {
        await native.stopComputerUseSession(s.id, 'emergency')
      } catch (error) {
        // Keep the banner visible: control may still be active.
        throw error
      }
    }
    clearMockTimer()
    setState({ isEmergencyFlashing: true })
    if (emergencyFlashTimer) clearTimeout(emergencyFlashTimer)
    emergencyFlashTimer = setTimeout(() => {
      emergencyFlashTimer = undefined
      const durationMs = s ? Date.now() - s.startedAt : 0
      const actionCount = s?.actionCount ?? 0
      setState({
        status: 'stopped',
        isEmergencyFlashing: false,
        session: s ? { ...s, status: 'stopped', stopReason: 'emergency_stop', currentAction: undefined } : undefined,
        lastStop: { reason: 'emergency_stop', actionCount, durationMs, at: Date.now() },
      })
      scheduleTerminalClear()
    }, 600)
  },

  /** Native event: helper consumed plain Esc. Same path as emergencyStop. */
  handleNativeEmergencyStop(): void {
    void this.emergencyStop(true)
  },

  /** Native event: authority was already removed by a live settings change. */
  handleNativeRevocation(
    reason: ComputerUseStopReason,
    turnReason?: ComputerUseTurnCompleteEvent['stoppedReason'],
  ): void {
    const s = state.session
    clearMockTimer()
    const durationMs = s ? Date.now() - s.startedAt : 0
    const actionCount = s?.actionCount ?? 0
    setState({
      status: 'stopped',
      session: s ? { ...s, status: 'stopped', stopReason: reason, currentAction: undefined } : undefined,
      lastStop: { reason, turnReason, actionCount, durationMs, at: Date.now() },
    })
    scheduleTerminalClear()
  },

  /** Native event: SessionManager state changed (e.g. OS permission revoked,
   *  target gone, idle expired). Renderer mirrors the new state. */
  handleNativeStateChange(rust: import('../../../renderer/verboo-bridge').RustSession): void {
    const existing = state.session
    const session = rustSessionToRenderer(rust, {
      conversationId: existing?.conversationId,
      executorModelId: existing?.executorModelId,
      goal: existing?.goal,
      appName: existing?.appName,
      appBundleId: existing?.appBundleId,
      isSelfTest: existing?.isSelfTest,
      requestedTier: existing?.requestedTier,
      originalModel: existing?.originalModel,
      executorModel: existing?.executorModel,
      temporaryExecutor: existing?.temporaryExecutor,
      lastAction: existing?.lastAction,
      currentAction: existing?.currentAction,
      actionCount: existing?.actionCount,
    })
    if (session.status === 'stopped') {
      clearMockTimer()
      const reason = nativeStopReason(rust.stop_reason)
      const durationMs = Math.max(0, Date.now() - session.startedAt)
      setState({
        status: 'stopped',
        session: { ...session, currentAction: undefined, stopReason: reason },
        lastStop: state.lastStop ?? {
          reason,
          actionCount: session.actionCount,
          durationMs,
          at: Date.now(),
        },
      })
      scheduleTerminalClear()
      return
    }
    setState({ status: session.status, session })
    if (session.status === 'idle') {
      clearMockTimer()
    }
  },

  /** Reconnect renderer state after a webview reload only when the backend has
   *  proven that both the exact conversation turn and native CU session are
   *  still alive. A full app restart cannot manufacture a resumable session. */
  restoreNativeExecutorLease(
    rust: import('../../../renderer/verboo-bridge').RustSession,
    lease: ComputerUseExecutorLease,
    originalModelName: string,
    executorModelName: string,
  ): ComputerUseSession {
    clearMockTimer()
    const activeApp = rust.approved_apps?.find(app =>
      app.bundle_id.toLowerCase() === (rust.active_app ?? rust.target_app ?? '').toLowerCase(),
    ) ?? rust.approved_apps?.[0]
    const session = rustSessionToRenderer(rust, {
      conversationId: lease.conversationId,
      executorModelId: lease.executorModelId,
      goal: rust.goal,
      appName: activeApp?.display_name ?? rust.active_app ?? rust.target_app ?? '',
      appBundleId: activeApp?.bundle_id ?? rust.active_app ?? rust.target_app ?? undefined,
      requestedTier: activeApp?.tier,
      originalModel: { id: lease.originalModelId, displayName: originalModelName },
      executorModel: { id: lease.executorModelId, displayName: executorModelName },
      temporaryExecutor: true,
      isSelfTest: rust.self_test_enabled,
    })
    recoveredActionSequenceSessionId = session.id
    setState({
      status: session.status,
      pendingRequest: undefined,
      session,
      lastStop: undefined,
      lastDeny: undefined,
      isEmergencyFlashing: false,
    })
    return session
  },

  /** Native event: helper emitted an action. Update banner subtext. */
  handleNativeAction(evt: ComputerUseActionEvent): void {
    const s = state.session
    if (!s || s.id !== evt.sessionId || (state.status !== 'active' && state.status !== 'paused')) return
    const nextCount = evt.actionIndex + 1
    const canResynchronize = recoveredActionSequenceSessionId === s.id
    if (!Number.isSafeInteger(nextCount)
      || nextCount <= s.actionCount
      || (!canResynchronize && nextCount !== s.actionCount + 1)) return
    recoveredActionSequenceSessionId = undefined
    setState({
      session: { ...s, lastAction: evt, actionCount: nextCount },
    })
  },

  handleNativeActionPending(evt: ComputerUsePendingActionEvent): void {
    const s = state.session
    if (!s || s.id !== evt.sessionId || (state.status !== 'active' && state.status !== 'paused')) return
    setState({ session: { ...s, currentAction: evt } })
  },

  handleNativeActionSettled(evt: ComputerUseSettledActionEvent): void {
    const s = state.session
    if (!s || s.id !== evt.sessionId || s.currentAction?.actionId !== evt.actionId) return
    setState({ session: { ...s, currentAction: undefined } })
  },

  /** Native event/hydration: accept a layout lease only for the exact live
   * session. Idle is global and is always safe to mirror. */
  handleNativeLayoutState(layout: ComputerUseLayoutState): void {
    if (layout.mode === 'idle') {
      setState({ layout: { mode: 'idle' } })
      return
    }
    const session = state.session
    if (!session
      || layout.sessionId !== session.id
      || (state.status !== 'active' && state.status !== 'paused')) return
    setState({ layout })
  },

  /** Dev/test hook: simulate a consent request without the native bridge.
   *  Used by the Settings "Test consent flow" button + vitest. */
  __mockRequestConsent(partial: Partial<ComputerUseConsentRequest>): void {
    const req: ComputerUseConsentRequest = {
      id: `cu-req:${crypto.randomUUID()}`,
      goal: partial.goal ?? 'Toggle the third toggle in Settings',
      appName: partial.appName ?? 'Verboo Settings',
      appBundleId: partial.appBundleId ?? 'ai.verboo.code.desktop',
      appIconBase64: partial.appIconBase64,
      scope: partial.scope ?? 'ask',
      isSelfTest: partial.isSelfTest ?? true,
      createdAt: Date.now(),
      timeoutMs: partial.timeoutMs ?? 30000,
      requestedTier: partial.requestedTier,
      originalModel: partial.originalModel,
      executorModel: partial.executorModel,
      temporaryExecutor: partial.temporaryExecutor,
      sentinelConfirmationRequired: partial.sentinelConfirmationRequired,
      hiddenAppCount: normalizeHiddenAppCount(partial.hiddenAppCount),
    }
    this.receiveConsentRequest(req)
  },

  /** Test hook: clear all state. */
  __reset(): void {
    clearMockTimer()
    clearLifecycleTimers()
    recoveredActionSequenceSessionId = undefined
    setState({ ...INITIAL })
  },
}

function nativeErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message.trim() || undefined
  if (typeof error === 'string') return error.trim() || undefined
  return undefined
}

function nativeDenyReason(error: unknown): ComputerUseDenyReason {
  const message = nativeErrorMessage(error)?.toLowerCase() ?? ''
  if (/tcc|accessibility|screen recording|os.?permission/.test(message)) {
    return 'os_permission_missing'
  }
  if (/self.?test/.test(message)) return 'self_test_disabled'
  if (/scope.?denied/.test(message)) return 'scope_denied'
  if (/app.?hard.?blocked|policy block/.test(message)) return 'app_hard_blocked'
  if (/consent.?expired|timeout/.test(message)) return 'timeout'
  return 'safety_check_failed'
}

function nativeStopReason(reason: string | null | undefined): ComputerUseStopReason {
  const knownReasons: ComputerUseStopReason[] = [
    'completed',
    'user_cancelled',
    'emergency_stop',
    'session_expired',
    'os_permission_revoked',
    'target_gone',
    'audit_storage_full',
    'app_quit',
    'idle_expired',
    'self_test_scope_violation',
    'error',
  ]
  return knownReasons.includes(reason as ComputerUseStopReason)
    ? reason as ComputerUseStopReason
    : 'error'
}

function normalizeHiddenAppCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

// ── Settings helpers ────────────────────────────────────────────
export const DEFAULT_COMPUTER_USE_SETTINGS: ComputerUseSettings = {
  enabled: false,
  selfTestEnabled: false,
  allowlist: [],
  denylist: [],
  preferredVisualExecutorId: undefined,
  restoreHiddenApps: true,
  auditRetentionDays: 90,
  auditStorageCapMb: 200,
  idleTimeoutSeconds: 900,
  telemetryOptOut: false,
  showInMenuBar: false,
}

// ── React binding ───────────────────────────────────────────────
export { computerUseStore as store }
