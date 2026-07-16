/**
 * useComputerUseSession — React binding for computerUseStore.
 *
 * Returns the current state + action callbacks. Also wires:
 *  - Tauri event listeners (onComputerUseStateChange / onComputerUseAction /
 *    onComputerUseEmergencyStop) when the native bridge is present.
 *    Geralt hasn't added emit() calls yet (P0.6 ships invoke only), so
 *    these are no-ops until he does. The store drives state via invoke
 *    responses in the meantime.
 *  - Plain Esc handler when the Verboo window has focus. During an active
 *    session the key is consumed and always emergency-stops control.
 *
 * Per docs/computer-use-maestro-go.md M3:
 *   - Primary stop: plain Esc (helper, OS-wide and consumed).
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type {
  ComputerUseActionEvent,
  ComputerUsePendingActionEvent,
  ComputerUseSettledActionEvent,
  ComputerUseConsentGrant,
  ComputerUseConsentRequest,
  ComputerUseDenyReason,
  ComputerUseLayoutState,
  ComputerUseScope,
  ComputerUseStopReason,
  ComputerUseTurnCompleteEvent,
} from '../../../shared/types'
import type { RustSession } from '../../verboo-bridge'
import { computerUseStore } from './computerUseStore'
import { reportComputerUseError } from './computerUseError'
import { useToast } from '../../components/Toast'
import { useI18n } from '../../i18n'

type Bridge = {
  onComputerUseStateChange?: (cb: (s: RustSession) => void) => () => void
  onComputerUseAction?: (cb: (a: ComputerUseActionEvent) => void) => () => void
  onComputerUseActionPending?: (cb: (a: ComputerUsePendingActionEvent) => void) => () => void
  onComputerUseActionSettled?: (cb: (a: ComputerUseSettledActionEvent) => void) => () => void
  onComputerUseEmergencyStop?: (cb: () => void) => () => void
  onComputerUseOsPermissionRevoked?: (cb: () => void) => () => void
  onComputerUseTurnComplete?: (cb: (event: ComputerUseTurnCompleteEvent) => void) => () => void
  onComputerUseCleanupFailed?: (cb: (message: string) => void) => () => void
  onComputerUseHandoffFailed?: (cb: (message: string) => void) => () => void
  onComputerUseSettingsRevoked?: (cb: (event: { sessionId: string; reason: 'feature_disabled' | 'app_denied' }) => void) => () => void
  getComputerUseLayoutState?: () => Promise<ComputerUseLayoutState>
  onComputerUseLayoutState?: (cb: (layout: ComputerUseLayoutState) => void) => () => void
}

function getBridge(): Bridge {
  if (typeof window === 'undefined') return {}
  return (window as unknown as { verboo?: Bridge }).verboo ?? {}
}

export function useComputerUseSession(
  onEmergencyStop?: () => void,
  onTurnComplete?: (event: ComputerUseTurnCompleteEvent) => void,
) {
  const { toast } = useToast()
  const { t } = useI18n()
  const state = useSyncExternalStore(
    computerUseStore.subscribe,
    computerUseStore.getSnapshot,
    computerUseStore.getSnapshot,
  )

  const emergencyStop = useCallback((alreadyRevoked = false) => {
    onEmergencyStop?.()
    return computerUseStore.emergencyStop(alreadyRevoked)
  }, [onEmergencyStop])

  // ── Wire native event listeners (no-op until Geralt adds emit) ──
  useEffect(() => {
    const b = getBridge()
    const unlisteners: Array<() => void> = []

    if (b.onComputerUseStateChange) {
      unlisteners.push(b.onComputerUseStateChange(s => computerUseStore.handleNativeStateChange(s)))
    }
    if (b.onComputerUseAction) {
      unlisteners.push(b.onComputerUseAction(a => computerUseStore.handleNativeAction(a)))
    }
    if (b.onComputerUseActionPending) {
      unlisteners.push(b.onComputerUseActionPending(a => computerUseStore.handleNativeActionPending(a)))
    }
    if (b.onComputerUseActionSettled) {
      unlisteners.push(b.onComputerUseActionSettled(a => computerUseStore.handleNativeActionSettled(a)))
    }
    if (b.onComputerUseLayoutState) {
      unlisteners.push(b.onComputerUseLayoutState(layout => computerUseStore.handleNativeLayoutState(layout)))
    }
    if (b.onComputerUseEmergencyStop) {
      unlisteners.push(b.onComputerUseEmergencyStop(() => {
        void emergencyStop(true).catch(error => toast(reportComputerUseError(
          'stop session',
          error,
          t('computerUse.stopFailed'),
        ), 'error'))
      }))
    }
    if (b.onComputerUseOsPermissionRevoked) {
      unlisteners.push(b.onComputerUseOsPermissionRevoked(() => {
        // Rust already stopped the session; align renderer + toast.
        void computerUseStore.stop('os_permission_revoked')
        toast(t('computerUse.osPermissionRevoked'), 'error')
      }))
    }
    if (b.onComputerUseTurnComplete) {
      unlisteners.push(b.onComputerUseTurnComplete(event => {
        const stopReason: ComputerUseStopReason = event.stoppedReason === 'completed'
          ? 'completed'
          : event.stoppedReason === 'cancelled'
            ? 'user_cancelled'
            : event.stoppedReason === 'emergency_stop'
              ? 'emergency_stop'
              : event.stoppedReason === 'os_permission_revoked'
                ? 'os_permission_revoked'
                : 'error'
        computerUseStore.handleNativeRevocation(
          stopReason,
          event.stoppedReason,
        )
        onTurnComplete?.(event)
      }))
    }
    if (b.onComputerUseCleanupFailed) {
      unlisteners.push(b.onComputerUseCleanupFailed(message => toast(reportComputerUseError(
        'cleanup failed',
        message,
        t('computerUse.cleanupFailed'),
      ), 'error')))
    }
    if (b.onComputerUseHandoffFailed) {
      unlisteners.push(b.onComputerUseHandoffFailed(() => {
        toast(t('computerUse.handoffFailed'), 'error')
      }))
    }
    if (b.onComputerUseSettingsRevoked) {
      unlisteners.push(b.onComputerUseSettingsRevoked(event => {
        computerUseStore.handleNativeRevocation('error')
        toast(
          event.reason === 'feature_disabled'
            ? t('computerUse.settingsRevokedDisabled')
            : t('computerUse.settingsRevokedDenied'),
          'error',
        )
      }))
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
  }, [emergencyStop, onTurnComplete, t, toast])

  // Hydrate once at mount and whenever the verified session identity changes.
  // The store rejects stale leases, so a delayed invoke cannot compact another
  // conversation or a terminal session.
  useEffect(() => {
    const getLayout = getBridge().getComputerUseLayoutState
    if (!getLayout) return
    let cancelled = false
    void getLayout()
      .then(layout => {
        if (!cancelled) computerUseStore.handleNativeLayoutState(layout)
      })
      .catch(() => {
        // Layout hydration is presentational. The full-window banner remains
        // the safe fallback when the native snapshot is unavailable.
      })
    return () => {
      cancelled = true
    }
  }, [state.session?.id])

  // ── Esc when Verboo focused ───────────────────────────────────
  // During an active session Esc is reserved exclusively for emergency stop,
  // matching the global helper behavior even inside inputs and dialogs.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      const status = computerUseStore.getSnapshot().status
      if (status !== 'active' && status !== 'paused') return
      event.preventDefault()
      event.stopImmediatePropagation()
      void emergencyStop().catch(error => toast(reportComputerUseError(
        'stop session',
        error,
        t('computerUse.stopFailed'),
      ), 'error'))
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [emergencyStop, t, toast])

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
    }) => computerUseStore.requestConsent(params),
    [],
  )
  const receiveConsentRequest = useCallback(
    (req: ComputerUseConsentRequest) => computerUseStore.receiveConsentRequest(req),
    [],
  )
  const grant = useCallback((
    g: ComputerUseConsentGrant,
    tier?: ComputerUseConsentRequest['requestedTier'],
  ) => computerUseStore.grant(g, tier), [])
  const deny = useCallback((r?: ComputerUseDenyReason) => computerUseStore.deny(r ?? 'user_denied'), [])
  const pause = useCallback(() => computerUseStore.pause(), [])
  const resume = useCallback(() => computerUseStore.resume(), [])
  const stop = useCallback((r?: ComputerUseStopReason) => computerUseStore.stop(r ?? 'user_cancelled'), [])
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
