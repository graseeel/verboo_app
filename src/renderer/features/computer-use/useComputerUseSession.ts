/**
 * useComputerUseSession — React binding for computerUseStore.
 *
 * Returns the current state + action callbacks. Also wires:
 *  - Tauri event listeners (onComputerUseStateChange / onComputerUseAction /
 *    onComputerUseEmergencyStop) when the native bridge is present.
 *    Geralt hasn't added emit() calls yet (P0.6 ships invoke only), so
 *    these are no-ops until he does. The store drives state via invoke
 *    responses in the meantime.
 *  - Esc key handler when the Verboo window has focus. Esc only fires
 *    emergency stop if a session is active or paused — otherwise Esc
 *    passes through to whatever element had it (dialog close, etc.).
 *
 * Per docs/computer-use-maestro-go.md M3:
 *   - Primary stop: ⌘⇧Esc (helper, OS-wide) — wired by Geralt.
 *   - Secondary stop: Esc when Verboo focused — wired here.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type {
  ComputerUseConsentGrant,
  ComputerUseConsentRequest,
  ComputerUseDenyReason,
  ComputerUseScope,
  ComputerUseStopReason,
} from '../../../shared/types'
import type { RustSession } from '../../verboo-bridge'
import { computerUseStore } from './computerUseStore'
import { useToast } from '../../components/Toast'

type Bridge = {
  onComputerUseStateChange?: (cb: (s: RustSession) => void) => () => void
  onComputerUseAction?: (cb: (a: unknown) => void) => () => void
  onComputerUseEmergencyStop?: (cb: () => void) => () => void
  onComputerUseTurnComplete?: (cb: () => void) => () => void
  onComputerUseCleanupFailed?: (cb: (message: string) => void) => () => void
}

function getBridge(): Bridge {
  if (typeof window === 'undefined') return {}
  return (window as unknown as { verboo?: Bridge }).verboo ?? {}
}

export function useComputerUseSession() {
  const { toast } = useToast()
  const state = useSyncExternalStore(
    computerUseStore.subscribe,
    computerUseStore.getSnapshot,
    computerUseStore.getSnapshot,
  )

  // ── Wire native event listeners (no-op until Geralt adds emit) ──
  useEffect(() => {
    const b = getBridge()
    const unlisteners: Array<() => void> = []

    if (b.onComputerUseStateChange) {
      unlisteners.push(b.onComputerUseStateChange(s => computerUseStore.handleNativeStateChange(s)))
    }
    if (b.onComputerUseAction) {
      // Action event shape is unknown until Geralt defines it; pass through.
      unlisteners.push(b.onComputerUseAction(a => {
        if (a && typeof a === 'object' && 'sessionId' in a) {
          computerUseStore.handleNativeAction(a as never)
        }
      }))
    }
    if (b.onComputerUseEmergencyStop) {
      unlisteners.push(b.onComputerUseEmergencyStop(() => computerUseStore.handleNativeEmergencyStop()))
    }
    if (b.onComputerUseTurnComplete) {
      unlisteners.push(b.onComputerUseTurnComplete(() => void computerUseStore.stop('session_expired')))
    }
    if (b.onComputerUseCleanupFailed) {
      unlisteners.push(b.onComputerUseCleanupFailed(() => toast('Computer Use could not be revoked automatically. Use Stop and keep the app open.', 'error')))
    }

    return () => {
      for (const u of unlisteners) {
        try {
          u()
        } catch {
          // Listener cleanup races on hot-reload; ignore.
        }
      }
    }
  }, [toast])

  // ── Esc when Verboo focused ───────────────────────────────────
  // Only fires emergency stop if a session is active or paused. Otherwise
  // Esc passes through (dialog dismiss, composer clear, etc.). We attach on
  // capture phase so we see the key before any input field swallows it,
  // but we DON'T preventDefault — we let the event continue if we acted
  // OR if we didn't, so other handlers still work.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      const status = computerUseStore.getSnapshot().status
      if (status !== 'active' && status !== 'paused') return
      // Don't hijack Esc from an open modal/dialog — let those close first.
      const target = event.target as HTMLElement | null
      if (target?.closest('[role="dialog"]') || target?.closest('[role="alertdialog"]')) return
      // Don't hijack when user is typing in a text field — Esc there usually
      // means "cancel input" or "blur". The banner Cancel button is still
      // reachable; ⌘⇧Esc is the OS-wide fallback.
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      void computerUseStore.emergencyStop()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  // ── Auto-deny on consent timeout ───────────────────────────────
  useEffect(() => {
    if (state.status !== 'consent' || !state.pendingRequest) return
    const timeoutMs = state.pendingRequest.timeoutMs ?? 30000
    const elapsed = Date.now() - state.pendingRequest.createdAt
    const remaining = Math.max(0, timeoutMs - elapsed)
    const timer = setTimeout(() => {
      if (computerUseStore.getSnapshot().status === 'consent') {
        void computerUseStore.deny('timeout')
      }
    }, remaining)
    return () => clearTimeout(timer)
  }, [state.status, state.pendingRequest])

  // ── Action callbacks (stable identity) ─────────────────────────
  const requestConsent = useCallback(
    (params: {
      goal: string
      appName?: string
      appBundleId?: string
      scope: ComputerUseScope
      isSelfTest?: boolean
      timeoutMs?: number
    }) => computerUseStore.requestConsent(params),
    [],
  )
  const receiveConsentRequest = useCallback(
    (req: ComputerUseConsentRequest) => computerUseStore.receiveConsentRequest(req),
    [],
  )
  const grant = useCallback((g: ComputerUseConsentGrant) => computerUseStore.grant(g), [])
  const deny = useCallback((r?: ComputerUseDenyReason) => computerUseStore.deny(r ?? 'user_denied'), [])
  const pause = useCallback(() => computerUseStore.pause(), [])
  const resume = useCallback(() => computerUseStore.resume(), [])
  const stop = useCallback((r?: ComputerUseStopReason) => computerUseStore.stop(r ?? 'user_cancelled'), [])
  const emergencyStop = useCallback(() => computerUseStore.emergencyStop(), [])

  return {
    state,
    actions: {
      requestConsent,
      receiveConsentRequest,
      grant,
      deny,
      pause,
      resume,
      stop,
      emergencyStop,
    },
  }
}
