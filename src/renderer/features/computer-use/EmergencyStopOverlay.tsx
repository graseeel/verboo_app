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
}: {
  actionCount: number
  durationMs: number
  isEmergency: boolean
}) {
  const { t } = useI18n()
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  return (
    <div className="computer-use-toast computer-use-toast-stopped" role="status" aria-live="polite">
      <ShieldCheck size={15} aria-hidden="true" />
      <div className="computer-use-toast-text">
        <strong>{t('computerUse.stopped.title')}</strong>
        <span>
          {isEmergency
            ? t('computerUse.stopped.emergencyBody')
            : t('computerUse.stopped.body')
                .replace('{count}', String(actionCount))
                .replace('{seconds}', String(seconds))}
        </span>
      </div>
    </div>
  )
}

export function DeniedToast() {
  const { t } = useI18n()
  return (
    <div className="computer-use-toast computer-use-toast-denied" role="status" aria-live="polite">
      <XCircle size={15} aria-hidden="true" />
      <div className="computer-use-toast-text">
        <strong>{t('computerUse.denied.title')}</strong>
        <span>{t('computerUse.denied.body')}</span>
      </div>
    </div>
  )
}
