/**
 * ComputerUseLayer — top-level orchestrator that mounts the right surface
 * for the current Computer Use state.
 *
 *   idle                  → nothing
 *   consent              → ConsentModal
 *   active / paused      → ControlBanner
 *   stopped              → StoppedToast (4s)
 *   denied               → DeniedToast (4s)
 *   emergency-stopping   → EmergencyStopOverlay (600ms)
 *
 * Mounted once in App.tsx, above the workspace. Uses useComputerUseSession
 * for state + actions + native event wiring + Esc handler.
 *
 * Per docs/computer-use-maestro-go.md M3:
 *   - Banner shows ⌘⇧Esc as primary stop (helper, OS-wide).
 *   - Esc when Verboo focused is wired in useComputerUseSession (secondary).
 *   - FloatingHUD is P1 — not mounted here yet.
 */

import { ConsentModal } from './ConsentModal'
import { ControlBanner } from './ControlBanner'
import { DeniedToast, EmergencyStopOverlay, StoppedToast } from './EmergencyStopOverlay'
import { useComputerUseSession } from './useComputerUseSession'

export function ComputerUseLayer({ providerName }: { providerName?: string }) {
  const { state, actions } = useComputerUseSession()

  // Emergency-stop overlay takes precedence over everything (600ms flash).
  if (state.isEmergencyFlashing) {
    return <EmergencyStopOverlay visible />
  }

  // Consent modal — full-screen overlay, blocks workspace interaction.
  if (state.status === 'consent' && state.pendingRequest) {
    return (
      <ConsentModal
        request={state.pendingRequest}
        providerName={providerName}
        onGrant={(type, rememberApp) => void actions.grant({ type, rememberApp })}
        onDeny={() => void actions.deny('user_denied')}
      />
    )
  }

  // Active or paused — banner is non-negotiable.
  if ((state.status === 'active' || state.status === 'paused') && state.session) {
    return (
      <ControlBanner
        session={state.session}
        onPause={() => void actions.pause()}
        onResume={() => void actions.resume()}
        onCancel={() => void actions.emergencyStop()}
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
      />
    )
  }

  // Denied toast — 4s auto-clear.
  if (state.status === 'denied') {
    return <DeniedToast />
  }

  return null
}
