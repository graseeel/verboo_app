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
  ComputerUseConsentGrant,
  ComputerUseConsentRequest,
  ComputerUseDenyReason,
  ComputerUseScope,
  ComputerUseSession,
  ComputerUseSettings,
  ComputerUseStopReason,
} from '../../../shared/types'

// ── Native bridge detection ─────────────────────────────────────
type NativeBridge = {
  requestComputerUseSession?: (goal: string, app: string | null, scope: ComputerUseScope) => Promise<import('../../../renderer/verboo-bridge').RustConsentRequest>
  grantComputerUseSession?: (requestId: string, screenshotAttachToLlm: boolean) => Promise<import('../../../renderer/verboo-bridge').RustSession>
  denyComputerUseSession?: (requestId: string) => Promise<void>
  stopComputerUseSession?: (sessionId: string, reason: 'user_cancelled' | 'emergency') => Promise<void>
  pauseComputerUseSession?: (sessionId: string) => Promise<import('../../../renderer/verboo-bridge').RustSession>
  resumeComputerUseSession?: (sessionId: string) => Promise<import('../../../renderer/verboo-bridge').RustSession>
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

function rustSessionToRenderer(
  rust: import('../../../renderer/verboo-bridge').RustSession,
  fallback: { goal?: string; appName?: string; isSelfTest?: boolean },
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
    goal: rust.goal ?? fallback.goal ?? '',
    appName: fallback.appName ?? rust.goal ?? '',
    scope: rust.scope,
    isSelfTest: rust.self_test_enabled || fallback.isSelfTest === true,
    startedAt: rust.started_at_wall,
    actionCount: 0,
  }
}

// ── Store state ─────────────────────────────────────────────────

type Listener = () => void

export type ComputerUseState = {
  status: ComputerUseSession['status']
  /** Present when status === 'consent'. */
  pendingRequest?: ComputerUseConsentRequest
  /** Present when status === 'active' | 'paused' | 'emergency-stopping' | 'stopped'. */
  session?: ComputerUseSession
  /** Set when status === 'stopped' — drives StoppedToast (4s auto-clear). */
  lastStop?: { reason: ComputerUseStopReason; actionCount: number; durationMs: number; at: number }
  /** Set when status === 'denied' — drives inline toast (4s auto-clear). */
  lastDeny?: { reason: ComputerUseDenyReason; at: number; detail?: string }
  /** Whether the emergency-stop overlay is mid-animation (600ms). */
  isEmergencyFlashing: boolean
}

const INITIAL: ComputerUseState = {
  status: 'idle',
  isEmergencyFlashing: false,
}

let state: ComputerUseState = INITIAL
const listeners = new Set<Listener>()

function setState(next: Partial<ComputerUseState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

function subscribe(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function getSnapshot(): ComputerUseState {
  return state
}

// ── Mock session lifecycle (fallback only) ──────────────────────
let mockActionTimer: ReturnType<typeof setInterval> | undefined
let mockActionIndex = 0
const MOCK_VERBS = ['click', 'type', 'read', 'scroll'] as const
const MOCK_TARGETS = ['"Save" button', 'email field', 'window list', 'scroll area']

function clearMockTimer(): void {
  if (mockActionTimer) {
    clearInterval(mockActionTimer)
    mockActionTimer = undefined
  }
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

  /** Step 1: agent or user invokes a consent request. In native mode this
   *  calls request_computer_use_session and translates the Rust response.
   *  In mock mode, synthesizes a request locally. */
  async requestConsent(params: {
    goal: string
    appName?: string
    appBundleId?: string
    scope: ComputerUseScope
    isSelfTest?: boolean
    timeoutMs?: number
  }): Promise<void> {
    clearMockTimer()
    const native = getNativeBridge()
    if (isNativeReady() && native.requestComputerUseSession) {
      try {
        const rust = await native.requestComputerUseSession(
          params.goal,
          params.appBundleId ?? null,
          params.scope,
        )
        const req: ComputerUseConsentRequest = {
          id: rust.id,
          goal: rust.goal,
          appName: params.appName ?? rust.app ?? params.goal,
          appBundleId: params.appBundleId ?? rust.app ?? undefined,
          scope: rust.scope,
          isSelfTest: params.isSelfTest,
          createdAt: rust.created_at_wall,
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
        // Native request failed (e.g. policy block, OS perm missing).
        // Surface as denied so the user sees feedback.
        const reason: ComputerUseDenyReason = 'app_hard_blocked'
        setState({
          status: 'denied',
          lastDeny: { reason, at: Date.now(), detail: nativeErrorMessage(err) },
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
      goal: params.goal,
      appName: params.appName ?? 'Verboo Settings',
      appBundleId: params.appBundleId ?? 'ai.verboo.code.desktop',
      scope: params.scope,
      isSelfTest: params.isSelfTest ?? false,
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
      pendingRequest: req,
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
  async grant(grant: ComputerUseConsentGrant): Promise<void> {
    const req = state.pendingRequest
    if (!req) return
    const native = getNativeBridge()
    if (isNativeReady() && native.grantComputerUseSession) {
      try {
        // The consent modal explicitly discloses that the authorized app
        // window is captured and sent to the selected model provider.
        const rustSession = await native.grantComputerUseSession(req.id, true)
        const session = rustSessionToRenderer(rustSession, {
          goal: req.goal,
          appName: req.appName,
          isSelfTest: req.isSelfTest,
        })
        setState({
          status: 'active',
          pendingRequest: undefined,
          session: { ...session, status: 'active' },
        })
        return
      } catch (err) {
        // Grant failed (e.g. consent expired, OS perm revoked). Deny.
        setState({
          status: 'denied',
          pendingRequest: undefined,
          lastDeny: { reason: 'os_permission_missing', at: Date.now(), detail: nativeErrorMessage(err) },
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
      goal: req.goal,
      appName: req.appName,
      appBundleId: req.appBundleId,
      scope: req.scope,
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
      } catch {
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
      } catch {
        // When Rust already stopped the session (TCC revoke, idle, etc.),
        // still clear the banner for those reasons. For user-initiated
        // stop failures, keep the banner visible — control may still be active.
        if (reason !== 'os_permission_revoked' && reason !== 'session_expired') {
          return
        }
      }
    }
    clearMockTimer()
    const durationMs = Date.now() - s.startedAt
    setState({
      status: 'stopped',
      session: { ...s, status: 'stopped', stopReason: reason },
      lastStop: { reason, actionCount: s.actionCount, durationMs, at: Date.now() },
    })
    setTimeout(() => {
      if (state.status === 'stopped') {
        setState({ status: 'idle', session: undefined, lastStop: undefined })
      }
    }, 4000)
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
      } catch {
        // Keep the banner visible: control may still be active.
        return
      }
    }
    clearMockTimer()
    setState({ isEmergencyFlashing: true })
    setTimeout(() => {
      const durationMs = s ? Date.now() - s.startedAt : 0
      const actionCount = s?.actionCount ?? 0
      setState({
        status: 'stopped',
        isEmergencyFlashing: false,
        session: s ? { ...s, status: 'stopped', stopReason: 'emergency_stop' } : undefined,
        lastStop: { reason: 'emergency_stop', actionCount, durationMs, at: Date.now() },
      })
      setTimeout(() => {
        if (state.status === 'stopped') {
          setState({ status: 'idle', session: undefined, lastStop: undefined })
        }
      }, 4000)
    }, 600)
  },

  /** Native event: helper fired ⌘⇧Esc. Same path as emergencyStop. */
  handleNativeEmergencyStop(): void {
    void this.emergencyStop(true)
  },

  /** Native event: SessionManager state changed (e.g. OS permission revoked,
   *  target gone, idle expired). Renderer mirrors the new state. */
  handleNativeStateChange(rust: import('../../../renderer/verboo-bridge').RustSession): void {
    const existing = state.session
    const session = rustSessionToRenderer(rust, {
      goal: existing?.goal,
      appName: existing?.appName,
      isSelfTest: existing?.isSelfTest,
    })
    setState({ status: session.status, session })
    if (session.status === 'stopped' || session.status === 'idle') {
      clearMockTimer()
    }
  },

  /** Native event: helper emitted an action. Update banner subtext. */
  handleNativeAction(evt: ComputerUseActionEvent): void {
    const s = state.session
    if (!s || s.id !== evt.sessionId) return
    setState({
      session: { ...s, lastAction: evt, actionCount: evt.actionIndex + 1 },
    })
  },

  /** Dev/test hook: simulate a consent request without the native bridge.
   *  Used by the Settings "Test consent flow" button + vitest. */
  __mockRequestConsent(partial: Partial<ComputerUseConsentRequest>): void {
    const req: ComputerUseConsentRequest = {
      id: `cu-req:${crypto.randomUUID()}`,
      goal: partial.goal ?? 'Toggle the third toggle in Settings',
      appName: partial.appName ?? 'Verboo Settings',
      appBundleId: partial.appBundleId ?? 'ai.verboo.code.desktop',
      scope: partial.scope ?? 'ask',
      isSelfTest: partial.isSelfTest ?? true,
      createdAt: Date.now(),
      timeoutMs: partial.timeoutMs ?? 30000,
    }
    this.receiveConsentRequest(req)
  },

  /** Test hook: clear all state. */
  __reset(): void {
    clearMockTimer()
    setState({ ...INITIAL })
  },
}

function nativeErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message.trim() || undefined
  if (typeof error === 'string') return error.trim() || undefined
  return undefined
}

// ── Settings helpers ────────────────────────────────────────────
export const DEFAULT_COMPUTER_USE_SETTINGS: ComputerUseSettings = {
  enabled: false,
  selfTestEnabled: false,
  allowlist: [],
  denylist: [],
  auditRetentionDays: 90,
  auditStorageCapMb: 200,
  idleTimeoutSeconds: 900,
  telemetryOptOut: false,
  showInMenuBar: false,
}

// ── React binding ───────────────────────────────────────────────
export { computerUseStore as store }
