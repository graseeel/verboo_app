/**
 * ConsentModal — first-run + per-session consent dialog for Computer Use.
 *
 * Per docs/computer-use-maestro-go.md M3 + Ciri proposal §1.1:
 *   - Three options: Don't allow / Allow once / Allow for this session.
 *   - NO "Allow always" — persistent allow only via Settings (deliberate friction).
 *   - Self-test variant: reduced capabilities copy, no "Allow for session".
 *   - Esc hint shown so user learns the stop hotkey.
 *   - Auto-deny countdown (timeoutMs from request, default 30s).
 *
 * The modal is app-styled (reuses .modal-backdrop + .t-modal from existing
 * ConfirmDialog pattern). It is NOT dismissable by backdrop click — consent
 * deserves weight; user must pick a button or wait for timeout.
 */

import { MousePointerClick, Keyboard, Camera, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComputerUseConsentRequest } from '../../../shared/types'
import { useI18n } from '../../i18n'

type ConsentModalProps = {
  request: ComputerUseConsentRequest
  providerName?: string
  onGrant: (type: 'once' | 'session', rememberApp: boolean) => void
  onDeny: () => void
}

export function ConsentModal({ request, providerName, onGrant, onDeny }: ConsentModalProps) {
  const { t } = useI18n()
  const [rememberApp, setRememberApp] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState<number>(() => {
    const timeoutMs = request.timeoutMs ?? 30000
    const elapsed = Date.now() - request.createdAt
    return Math.max(0, Math.ceil((timeoutMs - elapsed) / 1000))
  })
  const denyRef = useRef<HTMLButtonElement>(null)

  // Countdown — when it hits 0, the hook's auto-deny fires. We just mirror
  // the remaining seconds for the user.
  useEffect(() => {
    if (secondsLeft <= 0) return
    const timer = setTimeout(() => setSecondsLeft(s => Math.max(0, s - 1)), 1000)
    return () => clearTimeout(timer)
  }, [secondsLeft])

  // Focus the deny button by default — safer default than "allow". User
  // must explicitly move focus to allow.
  useEffect(() => {
    denyRef.current?.focus()
  }, [])

  // Esc dismisses to deny (matches the "Esc = stop" mental model).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onDeny()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onDeny])

  const isSelfTest = request.isSelfTest === true
  const title = isSelfTest ? t('computerUse.consent.selfTestTitle') : t('computerUse.consent.title')

  const capabilities = useMemo(() => {
    if (isSelfTest) {
      return [
        { icon: MousePointerClick, label: t('computerUse.consent.capability.selfTestMouse') },
        { icon: Camera, label: t('computerUse.consent.capability.selfTestScreen') },
      ]
    }
    return [
      { icon: MousePointerClick, label: t('computerUse.consent.capability.mouse') },
      { icon: Keyboard, label: t('computerUse.consent.capability.keyboard') },
      { icon: Camera, label: t('computerUse.consent.capability.screen') },
    ]
  }, [isSelfTest, t])

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="consent-modal confirm-dialog t-modal is-open"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="confirm-dialog-head">
          <span className="confirm-dialog-icon" aria-hidden="true">
            <ShieldAlert size={17} />
          </span>
          <div>
            <h2>{title}</h2>
            {isSelfTest && <p>{t('computerUse.consent.selfTestBody')}</p>}
          </div>
        </div>

        <div className="consent-modal-body">
          <p className="consent-modal-goal">
            <strong>{t('computerUse.consent.capabilitiesTitle')}</strong>
          </p>
          <ul className="consent-capabilities" role="list">
            {capabilities.map(cap => (
              <li key={cap.label}>
                <cap.icon size={14} aria-hidden="true" />
                <span>{cap.label}</span>
              </li>
            ))}
          </ul>

          {providerName && (
            <p className="consent-modal-disclosure">
              {t('computerUse.consent.dataDisclosure').replace('{provider}', providerName)}
            </p>
          )}

          <p className="consent-modal-esc-hint">{t('computerUse.consent.escHint')}</p>

          {!isSelfTest && (
            <label className="consent-modal-remember">
              <input
                type="checkbox"
                checked={rememberApp}
                onChange={e => setRememberApp(e.target.checked)}
              />
              <span>{t('computerUse.consent.rememberApp').replace('{appName}', request.appName)}</span>
            </label>
          )}
        </div>

        <div className="modal-actions consent-modal-actions">
          <span className="consent-modal-countdown" aria-live="polite">
            {t('computerUse.consent.timeout').replace('{seconds}', String(secondsLeft))}
          </span>
          <button type="button" ref={denyRef} onClick={onDeny}>
            {t('computerUse.consent.deny')}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onGrant('once', rememberApp)}
          >
            {t('computerUse.consent.allowOnce')}
          </button>
          {!isSelfTest && (
            <button
              type="button"
              className="primary"
              onClick={() => onGrant('session', rememberApp)}
            >
              {t('computerUse.consent.allowSession')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
