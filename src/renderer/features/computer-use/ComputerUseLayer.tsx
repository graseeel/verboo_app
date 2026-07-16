/**
 * ComputerUseLayer — top-level orchestrator that mounts the right surface
 * for the current Computer Use state.
 *
 *   idle                  → nothing
 *   consent              → explicit per-session authorization dialog
 *   active / paused      → ControlBanner
 *   stopped              → StoppedToast (4s)
 *   denied               → DeniedToast (4s)
 *   emergency-stopping   → EmergencyStopOverlay (600ms)
 *
 * Mounted once in App.tsx, above the workspace. Uses useComputerUseSession
 * for state + actions + native event wiring + Esc handler.
 *
 * Per docs/computer-use-maestro-go.md M3:
 *   - Plain Esc is the primary stop (helper, OS-wide).
 *   - FloatingHUD is P1 — not mounted here yet.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ComputerUseAppTier,
  ComputerUsePendingConfirmation,
  ComputerUseSession,
  ComputerUseTurnCompleteEvent,
} from '../../../shared/types'
import type { ComputerUseApp } from '../../verboo-bridge'
import { useToast } from '../../components/Toast'
import { useI18n } from '../../i18n'
import { ComputerUseAppApprovalDialog } from './ComputerUseAppApprovalDialog'
import type { ComputerUseAppPolicy } from './appControlTier'
import { ComputerUseConfirmationDialog } from './ComputerUseConfirmationDialog'
import { ComputerUseConfirmationCard } from './ComputerUseConfirmationCard'
import { ComputerUseCompactHeader } from './ComputerUseCompactHeader'
import { ComputerUseConsentDialog } from './ComputerUseConsentDialog'
import { reportComputerUseError } from './computerUseError'
import { computerUseStore, isComputerUseCompactState } from './computerUseStore'
import { ControlBanner } from './ControlBanner'
import { DeniedToast, EmergencyStopOverlay, StoppedToast } from './EmergencyStopOverlay'
import { useComputerUseSession } from './useComputerUseSession'

type ComputerUseLayerProps = {
  onSessionStarted?: (session: ComputerUseSession) => void
  onConsentDismissed?: () => void
  onEmergencyStop?: () => void
  onTurnComplete?: (event: ComputerUseTurnCompleteEvent) => void
}

export function ComputerUseLayer({ onSessionStarted, onConsentDismissed, onEmergencyStop, onTurnComplete }: ComputerUseLayerProps = {}) {
  const { state, actions } = useComputerUseSession(onEmergencyStop, onTurnComplete)
  const { toast } = useToast()
  const { t } = useI18n()
  const [granting, setGranting] = useState(false)
  const [appPickerApps, setAppPickerApps] = useState<ComputerUseApp[] | undefined>()
  const [appApprovalBusy, setAppApprovalBusy] = useState(false)
  const [pendingConfirmation, setPendingConfirmation] = useState<ComputerUsePendingConfirmation>()
  const [confirmationBusy, setConfirmationBusy] = useState(false)
  const resumeAfterAppPicker = useRef(false)

  useEffect(() => {
    if ((state.status !== 'active' && state.status !== 'paused') || !state.session) {
      setPendingConfirmation(undefined)
      setAppPickerApps(undefined)
      setAppApprovalBusy(false)
      resumeAfterAppPicker.current = false
      return
    }
    const getPending = window.verboo?.getPendingComputerUseConfirmation
    if (typeof getPending !== 'function') return

    let cancelled = false
    let inFlight = false
    const sessionId = state.session.id
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const confirmation = await getPending(sessionId)
        if (!cancelled) setPendingConfirmation(confirmation ?? undefined)
      } catch {
        // Session transitions can race with an in-flight poll. The next active
        // session starts a fresh polling loop; no action is authorized here.
      } finally {
        inFlight = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 300)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [state.status, state.session?.id])

  async function approveConsent(tier: ComputerUseAppTier) {
    if (granting) return
    setGranting(true)
    try {
      await actions.grant({ type: 'session' }, tier)
      const snapshot = computerUseStore.getSnapshot()
      if (snapshot.status === 'active' && snapshot.session) {
        onSessionStarted?.(snapshot.session)
      }
    } finally {
      setGranting(false)
    }
  }

  async function denyConsent() {
    if (granting) return
    await actions.deny('user_denied')
    onConsentDismissed?.()
  }

  async function pauseSession(): Promise<boolean> {
    try {
      await actions.pause()
      return true
    } catch (error) {
      toast(reportComputerUseError('pause session', error, t('computerUse.pauseFailed')), 'error')
      return false
    }
  }

  async function resumeSession(): Promise<boolean> {
    try {
      await actions.resume()
      return true
    } catch (error) {
      toast(reportComputerUseError('resume session', error, t('computerUse.resumeFailed')), 'error')
      return false
    }
  }

  async function stopSession(): Promise<void> {
    try {
      await actions.emergencyStop()
    } catch (error) {
      toast(reportComputerUseError('stop session', error, t('computerUse.stopFailed')), 'error')
    }
  }

  async function openAppManager() {
    if (!state.session || (state.status !== 'active' && state.status !== 'paused')) return
    resumeAfterAppPicker.current = state.status === 'active'
    if (resumeAfterAppPicker.current && !(await pauseSession())) {
      resumeAfterAppPicker.current = false
      return
    }
    try {
      const apps = await window.verboo.listComputerUseApps()
      if (!apps.length) {
        toast(t('computerUse.apps.none'), 'error')
        if (resumeAfterAppPicker.current) await resumeSession()
        resumeAfterAppPicker.current = false
        return
      }
      setAppPickerApps(apps)
    } catch (error) {
      if (resumeAfterAppPicker.current) await resumeSession()
      resumeAfterAppPicker.current = false
      toast(reportComputerUseError(
        'list running apps',
        error,
        t('computerUse.apps.listError'),
      ), 'error')
    }
  }

  async function closeAppManager() {
    setAppPickerApps(undefined)
    if (resumeAfterAppPicker.current) await resumeSession()
    resumeAfterAppPicker.current = false
  }

  async function approveApp(app: ComputerUseApp, policy: ComputerUseAppPolicy) {
    setAppApprovalBusy(true)
    try {
      await computerUseStore.approveApp({
        bundleId: app.bundleId,
        displayName: app.name,
        tier: policy.tier,
        sentinelConfirmed: policy.sentinelConfirmationRequired,
      })
      setAppPickerApps(undefined)
    } catch (error) {
      toast(reportComputerUseError(
        'approve app',
        error,
        t('computerUse.apps.approveError'),
      ), 'error')
      return
    } finally {
      setAppApprovalBusy(false)
    }
    if (resumeAfterAppPicker.current) await resumeSession()
    resumeAfterAppPicker.current = false
  }

  async function decideConfirmation(allow: boolean) {
    if (!state.session || !pendingConfirmation || confirmationBusy) return
    setConfirmationBusy(true)
    try {
      await window.verboo.decideComputerUseConfirmation(
        state.session.id,
        pendingConfirmation.id,
        allow,
      )
      setPendingConfirmation(undefined)
    } catch {
      toast(t('computerUse.confirmation.error'), 'error')
    } finally {
      setConfirmationBusy(false)
    }
  }

  // Emergency-stop overlay takes precedence over everything (600ms flash).
  if (state.isEmergencyFlashing) {
    return <EmergencyStopOverlay visible />
  }

  if (state.status === 'consent' && state.pendingRequest) {
    return (
      <ComputerUseConsentDialog
        request={state.pendingRequest}
        busy={granting}
        onApprove={tier => void approveConsent(tier)}
        onDeny={() => void denyConsent()}
      />
    )
  }

  if (pendingConfirmation && state.session) {
    const approvedApp = state.session.approvedApps?.find(
      app => app.bundleId.toLowerCase() === pendingConfirmation.appBundleId.toLowerCase(),
    )
    const appName = approvedApp?.displayName ?? state.session.appName ?? pendingConfirmation.appBundleId
    if (isComputerUseCompactState(state)) {
      const confirmationCard = (
        <ComputerUseConfirmationCard
          variant="inline"
          confirmation={pendingConfirmation}
          appName={appName}
          busy={confirmationBusy}
          onAllowOnce={() => void decideConfirmation(true)}
          onDeny={() => void decideConfirmation(false)}
        />
      )
      const dock = document.querySelector<HTMLElement>('.bottom-dock')
      return (
        <>
          <ComputerUseCompactHeader
            session={state.session}
            onPause={() => void pauseSession()}
            onResume={() => void resumeSession()}
            onStop={() => void stopSession()}
            onManageApps={() => void openAppManager()}
          />
          {dock ? createPortal(confirmationCard, dock) : confirmationCard}
        </>
      )
    }
    return (
      <ComputerUseConfirmationDialog
        confirmation={pendingConfirmation}
        appName={appName}
        busy={confirmationBusy}
        onAllowOnce={() => void decideConfirmation(true)}
        onDeny={() => void decideConfirmation(false)}
      />
    )
  }

  if (appPickerApps && state.session && (state.status === 'active' || state.status === 'paused')) {
    return (
      <ComputerUseAppApprovalDialog
        apps={appPickerApps}
        approvedBundleIds={(state.session.approvedApps ?? []).map(app => app.bundleId)}
        busy={appApprovalBusy}
        onApprove={(app, policy) => void approveApp(app, policy)}
        onCancel={() => void closeAppManager()}
      />
    )
  }

  // Active or paused — banner is non-negotiable.
  if ((state.status === 'active' || state.status === 'paused') && state.session) {
    if (isComputerUseCompactState(state)) {
      return (
        <ComputerUseCompactHeader
          session={state.session}
          onPause={() => void pauseSession()}
          onResume={() => void resumeSession()}
          onStop={() => void stopSession()}
          onManageApps={() => void openAppManager()}
        />
      )
    }
    return (
      <ControlBanner
        session={state.session}
        onPause={() => void pauseSession()}
        onResume={() => void resumeSession()}
        onCancel={() => void stopSession()}
        onManageApps={() => void openAppManager()}
      />
    )
  }

  // Stopped toast — 4s auto-clear (store handles the timer).
  if (state.status === 'stopped' && state.lastStop) {
    return (
      <StoppedToast
        actionCount={state.lastStop.actionCount}
        durationMs={state.lastStop.durationMs}
        isEmergency={state.lastStop.reason === 'emergency_stop'}
        stopReason={state.lastStop.reason}
        turnReason={state.lastStop.turnReason}
      />
    )
  }

  // Denied toast — 4s auto-clear.
  if (state.status === 'denied') {
    return <DeniedToast reason={state.lastDeny?.reason} />
  }

  return null
}
