/**
 * EmergencyStopOverlay — 600ms full-screen subtle overlay shown during
 * emergency stop transition. Pairs with the store's isEmergencyFlashing
 * flag. Non-blocking (pointer-events: none) so the user can still interact
 * if needed; purely visual feedback that "something is happening".
 *
 * Per Ciri proposal §1.5: overlay morphs into StoppedToast for 4s.
 *
 * Also exports StoppedToast and DeniedToast — small inline toasts that
 * appear in the workspace area (not the global toast system, because
 * these are session-specific and should appear near the banner location).
 */

import { ShieldCheck, XCircle } from 'lucide-react'
import type {
  ComputerUseDenyReason,
  ComputerUseStopReason,
  ComputerUseTurnCompleteEvent,
} from '../../../shared/types'
import { useI18n } from '../../i18n'

export function EmergencyStopOverlay({ visible }: { visible: boolean }) {
  const { t } = useI18n()
  if (!visible) return null
  return (
    <div className="emergency-stop-overlay" role="alert" aria-live="assertive">
      <div className="emergency-stop-overlay-content">
        <ShieldCheck size={28} aria-hidden="true" />
        <strong>{t('computerUse.emergencyStopping')}</strong>
        <span>{t('computerUse.emergencyStop.body')}</span>
      </div>
    </div>
  )
}

export function StoppedToast({
  actionCount,
  durationMs,
  isEmergency,
  stopReason,
  turnReason,
}: {
  actionCount: number
  durationMs: number
  isEmergency: boolean
  stopReason?: ComputerUseStopReason
  turnReason?: ComputerUseTurnCompleteEvent['stoppedReason']
}) {
  const { t } = useI18n()
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  const failedStop = Boolean(stopReason && ![
    'completed',
    'user_cancelled',
    'emergency_stop',
  ].includes(stopReason))
  const failed = failedStop
    || turnReason === 'spawn_error'
    || turnReason === 'stdout_unavailable'
    || turnReason === 'executor_error'
    || turnReason === 'cleanup_error'
    || turnReason === 'app_approval_failed'
  const body = turnReason === 'cleanup_error'
    ? t('computerUse.stopped.cleanupErrorBody')
    : failed
      ? t('computerUse.stopped.errorBody')
      : isEmergency
        ? t('computerUse.stopped.emergencyBody')
        : t('computerUse.stopped.body')
            .replace('{count}', String(actionCount))
            .replace('{seconds}', String(seconds))
  return (
    <div className={`computer-use-toast computer-use-toast-stopped ${failed ? 'is-error' : ''}`} role="status" aria-live="polite">
      {failed
        ? <XCircle size={15} aria-hidden="true" />
        : <ShieldCheck size={15} aria-hidden="true" />}
      <div className="computer-use-toast-text">
        <strong>{t(failed ? 'computerUse.stopped.errorTitle' : 'computerUse.stopped.title')}</strong>
        <span>{body}</span>
      </div>
    </div>
  )
}

export function DeniedToast({ reason }: { reason?: ComputerUseDenyReason }) {
  const { t } = useI18n()
  const bodyKey: Record<ComputerUseDenyReason, string> = {
    user_denied: 'computerUse.denied.body',
    timeout: 'computerUse.denied.timeout',
    os_permission_missing: 'computerUse.denied.osPermission',
    self_test_disabled: 'computerUse.denied.selfTest',
    app_hard_blocked: 'computerUse.denied.blockedApp',
    scope_denied: 'computerUse.denied.scope',
    safety_check_failed: 'computerUse.denied.safetyCheck',
  }
  return (
    <div className="computer-use-toast computer-use-toast-denied" role="status" aria-live="polite">
      <XCircle size={15} aria-hidden="true" />
      <div className="computer-use-toast-text">
        <strong>{t('computerUse.denied.title')}</strong>
        <span>{t(reason ? bodyKey[reason] : 'computerUse.denied.body')}</span>
      </div>
    </div>
  )
}
