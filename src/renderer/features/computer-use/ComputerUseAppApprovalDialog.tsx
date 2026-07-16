import { AppWindow, Check, Eye } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ComputerUseAppTier } from '../../../shared/types'
import type { ComputerUseApp } from '../../verboo-bridge'
import { useI18n } from '../../i18n'
import {
  availableComputerUseTiers,
  computerUsePolicyForApp,
  computerUseSentinelWarningKey,
  scopeForComputerUseTier,
  type ComputerUseAppPolicy,
} from './appControlTier'
import { countHiddenComputerUseApps } from './computerUseIntent'
import { useDialogFocusTrap } from './useDialogFocusTrap'
import { computerUseIconDataUrl } from './computerUseIcon'

type ComputerUseAppApprovalDialogProps = {
  apps: ComputerUseApp[]
  approvedBundleIds: string[]
  busy?: boolean
  onApprove: (app: ComputerUseApp, policy: ComputerUseAppPolicy) => void
  onCancel: () => void
}

export function ComputerUseAppApprovalDialog({
  apps,
  approvedBundleIds,
  busy = false,
  onApprove,
  onCancel,
}: ComputerUseAppApprovalDialogProps) {
  const { t } = useI18n()
  const titleId = useId()
  const descriptionId = useId()
  const tierSelectId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useDialogFocusTrap<HTMLElement>({
    initialFocusRef: cancelRef,
    onEscape: () => {
      if (!busy) onCancel()
    },
  })
  const [selectedBundleId, setSelectedBundleId] = useState(
    () => apps.find(app => app.isFrontmost)?.bundleId ?? apps[0]?.bundleId,
  )
  const selectedApp = apps.find(app => app.bundleId === selectedBundleId)
  const policy = useMemo(
    () => selectedApp ? computerUsePolicyForApp(selectedApp.bundleId, selectedApp.name) : undefined,
    [selectedApp],
  )
  const [selectedTier, setSelectedTier] = useState<ComputerUseAppTier>(() => policy?.tier ?? 'view_only')
  useEffect(() => {
    if (policy) setSelectedTier(policy.tier)
  }, [policy])
  const approved = new Set(approvedBundleIds.map(bundle => bundle.toLowerCase()))
  const hiddenAppCount = selectedApp
    ? countHiddenComputerUseApps(apps, selectedApp.bundleId, approvedBundleIds)
    : 0
  const hiddenAppsDisclosure = hiddenAppCount === 0
    ? t('computerUse.consent.hiddenApps.none')
    : hiddenAppCount === 1
      ? t('computerUse.consent.hiddenApps.one')
      : t('computerUse.consent.hiddenApps.many', { count: hiddenAppCount })

  return (
    <div className="modal-backdrop computer-use-consent-backdrop">
      <section
        ref={dialogRef}
        className="confirm-modal computer-use-app-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className="computer-use-consent-header">
          <span className="computer-use-consent-icon" aria-hidden="true"><AppWindow size={18} /></span>
          <div>
            <h2 id={titleId}>{t('computerUse.apps.title')}</h2>
            <p id={descriptionId}>{t('computerUse.apps.description')}</p>
          </div>
        </header>

        <ul className="computer-use-app-list">
          {apps.map(app => {
            const isApproved = approved.has(app.bundleId.toLowerCase())
            const appIconUrl = computerUseIconDataUrl(app.iconBase64)
            return (
              <li key={app.bundleId}>
                <button
                  type="button"
                  className={app.bundleId === selectedBundleId ? 'is-selected' : ''}
                  aria-label={app.name}
                  aria-pressed={app.bundleId === selectedBundleId}
                  onClick={() => setSelectedBundleId(app.bundleId)}
                >
                  <span className="computer-use-app-identity">
                    {appIconUrl
                      ? <img className="computer-use-app-icon" src={appIconUrl} alt="" />
                      : <AppWindow size={16} aria-hidden="true" />}
                    <span>{app.name}</span>
                  </span>
                  {isApproved && <small><Check size={12} aria-hidden="true" /> {t('computerUse.apps.approved')}</small>}
                </button>
              </li>
            )
          })}
        </ul>

        {selectedApp && policy && (
          <div className="computer-use-app-policy">
            <strong>{selectedApp.name}</strong>
            <label htmlFor={tierSelectId}>{t('computerUse.consent.control')}</label>
            <select
              id={tierSelectId}
              className="computer-use-tier-select"
              value={selectedTier}
              disabled={busy}
              onChange={event => setSelectedTier(event.target.value as ComputerUseAppTier)}
            >
              {availableComputerUseTiers(policy.tier).map(tier => (
                <option key={tier} value={tier}>{t(`computerUse.tier.${tier}`)}</option>
              ))}
            </select>
            <small>{t('computerUse.tier.maximum', { tier: t(`computerUse.tier.${policy.tier}`) })}</small>
            {policy.sentinelConfirmationRequired && (
              <p>{t(computerUseSentinelWarningKey(selectedApp.bundleId))}</p>
            )}
            {policy.tier === 'click_only' && <p>{t('computerUse.tier.clickOnlyWarning')}</p>}
          </div>
        )}

        {selectedApp && policy && (
          <div className="computer-use-consent-disclosures">
            <p><Eye size={14} aria-hidden="true" /> {t('computerUse.consent.screenshots')}</p>
            <p><AppWindow size={14} aria-hidden="true" /> {hiddenAppsDisclosure}</p>
            <p>{t('computerUse.consent.clipboard')}</p>
            <p>{t('computerUse.consent.stop')}</p>
          </div>
        )}

        <div className="modal-actions">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
          <button
            className="confirm-primary"
            type="button"
            disabled={busy || !selectedApp || !policy}
            onClick={() => selectedApp && policy && onApprove(selectedApp, {
              ...policy,
              tier: selectedTier,
              scope: scopeForComputerUseTier(selectedTier),
            })}
          >
            {busy ? t('computerUse.consent.starting') : t('computerUse.apps.approve')}
          </button>
        </div>
      </section>
    </div>
  )
}
