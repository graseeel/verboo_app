import type { ProviderAuthStatus } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { providerDisplayName, providerToneStyle } from '../models/providerCatalog'
import { ProviderIcon } from '../models/ProviderIcon'

export type ProviderIntegrationsProps = {
  /** The provider universe — one entry per provider the login bridge
   *  supports (`provider_auth_status`), connected=false included. A REAL
   *  empty list renders nothing, so the tab stays identical to today. */
  statuses: ProviderAuthStatus[]
  /** Starts the provider login flow (provider_login_start → browser). */
  onConnect: (providerId: string) => void
  /** Provider whose login flow is active (its card shows live progress). */
  connectingProvider?: string
  /** Flow stage driven by provider-login:event: 'starting' until the CLI
   *  reports awaiting_browser, then 'awaiting_browser' until connected/error. */
  loginStage?: 'starting' | 'awaiting_browser'
  /** Aborts the active login flow (provider_login_cancel). */
  onCancelLogin: () => void
}

/** T11 — Ajustes → Provedores: one card per provider from the login bridge.
 *  (Moved out of Integrações — the Chrome tab — by the owner's order: the
 *  cards were placed there by convenience and don't belong to that subject.)
 *  The TAB owns the page heading, same pattern as ChromeIntegrationSettings.
 *
 *  Disconnect is deliberately DISABLED: the only logout the CLI exposes is
 *  GLOBAL (it drops the whole Verboo session, lib.rs:1588-1591) — it must
 *  never sit behind a per-provider button. It unlocks when the CLI offers
 *  per-provider logout (already requested from the CLI team). */
export function ProviderIntegrations({ statuses, onConnect, connectingProvider, loginStage, onCancelLogin }: ProviderIntegrationsProps) {
  const { t } = useI18n()
  if (statuses.length === 0) return null

  return (
    <section className="settings-panel">
      {statuses.map(status => (
        <div className="provider-card" key={status.provider}>
          <div className="provider-card-head">
            <ProviderIcon providerId={status.provider} size={22} style={providerToneStyle(status.provider)} />
            <strong>{providerDisplayName(status.provider, t)}</strong>
            <span className={`provider-card-state${status.connected ? '' : ' is-dim'}`}>
              {status.connected ? t('settings.provider.connected') : t('settings.provider.notConnected')}
            </span>
            {status.connected ? (
              <button
                type="button"
                className="provider-card-action"
                disabled
                title={t('settings.provider.disconnectUnavailable')}
              >
                {t('settings.provider.disconnect')}
              </button>
            ) : connectingProvider === status.provider ? (
              /* Login flow ACTIVE: live progress on the card (field finding —
                 the card used to sit on "Not connected" saying nothing). */
              <span className="provider-card-actions">
                <button type="button" className="provider-card-action" disabled>
                  {loginStage === 'awaiting_browser'
                    ? t('settings.provider.waitingBrowser')
                    : t('settings.provider.connecting')}
                </button>
                <button type="button" className="provider-card-action" onClick={onCancelLogin}>
                  {t('common.cancel')}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="provider-card-action"
                onClick={() => onConnect(status.provider)}
              >
                {t('settings.provider.connect')}
              </button>
            )}
          </div>
          {status.account && (
            <p className="provider-card-account">{status.account}</p>
          )}
          <p className="provider-card-cost">{t('settings.provider.costNote')}</p>
        </div>
      ))}
    </section>
  )
}
