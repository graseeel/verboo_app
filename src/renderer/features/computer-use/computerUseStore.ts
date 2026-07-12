/**
 * computerUseStore.ts — module-level store for Computer Use session state.
 *
 * Pattern mirrors chatStore.ts (no external dep; useSyncExternalStore for
 * React binding). State machine per docs/computer-use-architecture-v1.md §2.1:
 *
 *   idle → consent → active ⇄ paused → stopped
 *                  → denied
 *                  → emergency-stopping → stopped
 *
 * Mock fallback: when `window.verboo.requestComputerUseSession` is absent
 * (Geralt's Tauri commands not yet wired), the store simulates the session
 * lifecycle locally so Ciri's UX can ship and be tested in isolation. The
 * instant the real IPC lands, the mock branch is dead code — every public
 * action checks `IS_NATIVE_READY` first.
 */

import type {
  ComputerUseActionEvent,
  ComputerUseConsentGrant,
  ComputerUseConsentRequest,
  ComputerUseDenyReason,
  ComputerUseSession,
  ComputerUseSettings,
  ComputerUseStopReason,
} from '../../../shared/types'

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
  lastDeny?: { reason: ComputerUseDenyReason; at: number }
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

// ── Native IPC detection ────────────────────────────────────────
// window.verboo is the Tauri bridge. Computer Use commands are added by
// Geralt in P0.3/P0.6. Until they exist, we fall back to a mock so the UX
// is fully testable in isolation.
type ComputerUseBridge = {
  requestComputerUseSession?: (req: ComputerUseConsentRequest) => Promise<string>
  grantComputerUseSession?: (id: string, grant: ComputerUseConsentGrant) => Promise<ComputerUseSession>
  denyComputerUseSession?: (id: string, reason: ComputerUseDenyReason) => Promise<void>
  pauseComputerUseSession?: (id: string) => Promise<void>
  resumeComputerUseSession?: (id: string) => Promise<ComputerUseSession>
  stopComputerUseSession?: (id: string, reason: ComputerUseStopReason) => Promise<void>
  emergencyStopComputerUse?: () => Promise<void>
  getComputerUseState?: () => Promise<ComputerUseSession | null>
  onComputerUseStateChange?: (cb: (s: ComputerUseSession) => void) => () => void
  onComputerUseAction?: (cb: (a: ComputerUseActionEvent) => void) => () => void
  onComputerUseEmergencyStop?: (cb: () => void) => Promise<() => void> | (() => void)
}

function bridge(): ComputerUseBridge {
  if (typeof window === 'undefined') return {}
  return (window as unknown as { verboo?: ComputerUseBridge }).verboo ?? {}
}

function isNativeReady(): boolean {
  const b = bridge()
  return typeof b.requestComputerUseSession === 'function'
}

// ── Mock session lifecycle ──────────────────────────────────────
// Used only when native IPC is absent. Simulates action events so the
// banner has live subtext to render. Cancellable via stop().
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

  /** Renderer calls this when an agent requests control. In native mode
   *  this is triggered by the `onComputerUseStateChange` event; in mock
   *  mode the caller (e.g. a dev button or skill stub) invokes it. */
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

  async grant(grant: ComputerUseConsentGrant): Promise<void> {
    const req = state.pendingRequest
    if (!req) return
    const b = bridge()
    if (isNativeReady() && b.grantComputerUseSession) {
      const session = await b.grantComputerUseSession(req.id, grant)
      const active: ComputerUseSession = { ...session, status: 'active' }
      setState({ status: 'active', pendingRequest: undefined, session: active })
      return
    }
    // Mock: synthesize a session and start emitting fake actions.
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
    const b = bridge()
    if (isNativeReady() && b.denyComputerUseSession) {
      await b.denyComputerUseSession(req.id, reason)
    }
    setState({
      status: 'denied',
      pendingRequest: undefined,
      lastDeny: { reason, at: Date.now() },
    })
    // Auto-clear the deny toast after 4s; return to idle.
    setTimeout(() => {
      if (state.status === 'denied') setState({ status: 'idle', lastDeny: undefined })
    }, 4000)
  },

  async pause(): Promise<void> {
    const s = state.session
    if (!s || state.status !== 'active') return
    const b = bridge()
    if (isNativeReady() && b.pauseComputerUseSession) {
      await b.pauseComputerUseSession(s.id)
    }
    clearMockTimer()
    setState({ status: 'paused', session: { ...s, status: 'paused' } })
  },

  async resume(): Promise<void> {
    const s = state.session
    if (!s || state.status !== 'paused') return
    const b = bridge()
    if (isNativeReady() && b.resumeComputerUseSession) {
      const next = await b.resumeComputerUseSession(s.id)
      setState({ status: 'active', session: { ...next, status: 'active' } })
      return
    }
    const active: ComputerUseSession = { ...s, status: 'active' }
    setState({ status: 'active', session: active })
    startMockActions(active)
  },

  async stop(reason: ComputerUseStopReason = 'user_cancelled'): Promise<void> {
    const s = state.session
    if (!s) return
    const b = bridge()
    if (isNativeReady() && b.stopComputerUseSession) {
      await b.stopComputerUseSession(s.id, reason)
    }
    clearMockTimer()
    const durationMs = Date.now() - s.startedAt
    setState({
      status: 'stopped',
      session: { ...s, status: 'stopped', stopReason: reason },
      lastStop: { reason, actionCount: s.actionCount, durationMs, at: Date.now() },
    })
    // Auto-clear the stopped toast after 4s; return to idle.
    setTimeout(() => {
      if (state.status === 'stopped') {
        setState({ status: 'idle', session: undefined, lastStop: undefined })
      }
    }, 4000)
  },

  /** Emergency stop — fires immediately, no confirmation. Triggers the
   *  600ms overlay flash, then transitions to stopped. Called from:
   *  - Esc key when Verboo has focus (this file's keybind)
   *  - ControlBanner Cancel button
   *  - Native helper Cmd+Shift+Esc (via onComputerUseEmergencyStop event) */
  async emergencyStop(): Promise<void> {
    if (state.status !== 'active' && state.status !== 'paused') return
    const s = state.session
    const b = bridge()
    if (isNativeReady() && b.emergencyStopComputerUse) {
      await b.emergencyStopComputerUse()
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

  /** Native event: helper fired Cmd+Shift+Esc. Same path as emergencyStop. */
  handleNativeEmergencyStop(): void {
    void this.emergencyStop()
  },

  /** Native event: SessionManager state changed (e.g. OS permission revoked,
   *  target gone, idle expired). Renderer mirrors the new state. */
  handleNativeStateChange(next: ComputerUseSession): void {
    setState({ status: next.status, session: next })
    if (next.status === 'stopped' || next.status === 'idle') {
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
   *  Used by the Settings "Test consent flow" button. */
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

// ── Settings helpers ────────────────────────────────────────────
// Default settings mirror Rust `ComputerUseSettings::default()` (src-tauri/src/models/types.rs).
// Exported for the settings UI to import + for tests.
// Emergency-stop hotkey display string is renderer-derived (M3 binding):
//   primary ⌘⇧Esc (helper OS-wide), secondary Esc (Verboo focused).
export const COMPUTER_USE_EMERGENCY_STOP_HOTKEY_PRIMARY = '⌘⇧Esc'
export const COMPUTER_USE_EMERGENCY_STOP_HOTKEY_SECONDARY = 'Esc'

export const DEFAULT_COMPUTER_USE_SETTINGS: ComputerUseSettings = {
  enabled: false,
  selfTestEnabled: false,
  allowlist: [],
  denylist: [
    'com.apple.Mail',
    'com.agilebits.onepassword-osx',
    'com.agilebits.onepassword8',
    'com.bitwarden.desktop',
  ],
  auditRetentionDays: 90,
  auditStorageCapMb: 200,
  idleTimeoutSeconds: 900,
  telemetryOptOut: false,
  showInMenuBar: false,
}

// ── React binding ───────────────────────────────────────────────
// Re-exported as a hook from useComputerUseSession.ts.
export { computerUseStore as store }
