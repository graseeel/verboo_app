import { AppWindow, Eye, ShieldCheck } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { ComputerUseAppTier, ComputerUseConsentRequest } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { useDialogFocusTrap } from './useDialogFocusTrap'
import { computerUseIconDataUrl } from './computerUseIcon'
import {
  availableComputerUseTiers,
  computerUseSentinelWarningKey,
} from './appControlTier'

type ComputerUseConsentDialogProps = {
  request: ComputerUseConsentRequest
  busy?: boolean
  onApprove: (tier: ComputerUseAppTier) => void
  onDeny: () => void
}

export function ComputerUseConsentDialog({
  request,
  busy = false,
  onApprove,
  onDeny,
}: ComputerUseConsentDialogProps) {
  const { t } = useI18n()
  const titleId = useId()
  const descriptionId = useId()
  const tierSelectId = useId()
  const denyRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useDialogFocusTrap<HTMLElement>({ initialFocusRef: denyRef, onEscape: onDeny })
  const maximumTier = request.requestedTier ?? tierFromScope(request.scope)
  const [selectedTier, setSelectedTier] = useState(maximumTier)
  useEffect(() => setSelectedTier(maximumTier), [maximumTier, request.id])
  const appIconUrl = computerUseIconDataUrl(request.appIconBase64)
  const hiddenAppsDisclosure = request.hiddenAppCount === 0
    ? t('computerUse.consent.hiddenApps.none')
    : request.hiddenAppCount === 1
      ? t('computerUse.consent.hiddenApps.one')
      : t('computerUse.consent.hiddenApps.many', { count: request.hiddenAppCount })

  return (
    <div className="modal-backdrop computer-use-consent-backdrop">
      <section
        ref={dialogRef}
        className="confirm-modal computer-use-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className="computer-use-consent-header">
          <span className="computer-use-consent-icon" aria-hidden="true">
            <ShieldCheck size={18} />
          </span>
          <div>
            <h2 id={titleId}>{t('computerUse.consent.title')}</h2>
            <p id={descriptionId}>{t('computerUse.consent.description')}</p>
          </div>
        </header>

        <dl className="computer-use-consent-details">
          <div>
            <dt>{t('computerUse.consent.goal')}</dt>
            <dd>{request.goal}</dd>
          </div>
          <div>
            <dt>{t('computerUse.consent.app')}</dt>
            <dd>
              {appIconUrl
                ? <img className="computer-use-app-icon" src={appIconUrl} alt="" />
                : <AppWindow size={14} aria-hidden="true" />}
              {request.appName}
            </dd>
          </div>
          <div>
            <dt><label htmlFor={tierSelectId}>{t('computerUse.consent.control')}</label></dt>
            <dd className="computer-use-tier-choice">
              <select
                id={tierSelectId}
                className="computer-use-tier-select"
                value={selectedTier}
                disabled={busy}
                onChange={event => setSelectedTier(event.target.value as ComputerUseAppTier)}
              >
                {availableComputerUseTiers(maximumTier).map(tier => (
                  <option key={tier} value={tier}>{t(`computerUse.tier.${tier}`)}</option>
                ))}
              </select>
              <small>{t('computerUse.tier.maximum', { tier: t(`computerUse.tier.${maximumTier}`) })}</small>
            </dd>
          </div>
        </dl>

        <div className="computer-use-consent-disclosures">
          <p><Eye size={14} aria-hidden="true" /> {t('computerUse.consent.screenshots')}</p>
          <p><AppWindow size={14} aria-hidden="true" /> {hiddenAppsDisclosure}</p>
          {request.sentinelConfirmationRequired && (
            <p className="computer-use-consent-sensitive">
              {t(computerUseSentinelWarningKey(request.appBundleId ?? ''))}
            </p>
          )}
          {maximumTier === 'click_only' && (
            <p className="computer-use-consent-sensitive">{t('computerUse.tier.clickOnlyWarning')}</p>
          )}
          <p>{t('computerUse.consent.clipboard')}</p>
          <p>{t('computerUse.consent.stop')}</p>
        </div>

        <div className="modal-actions">
          <button ref={denyRef} type="button" disabled={busy} onClick={onDeny}>
            {t('computerUse.consent.deny')}
          </button>
          <button className="confirm-primary" type="button" disabled={busy} onClick={() => onApprove(selectedTier)}>
            {busy ? t('computerUse.consent.starting') : t('computerUse.consent.approve')}
          </button>
        </div>
      </section>
    </div>
  )
}

function tierFromScope(scope: ComputerUseConsentRequest['scope']): ComputerUseAppTier {
  if (scope === 'view' || scope === 'ask') return 'view_only'
  return 'full_control'
}
