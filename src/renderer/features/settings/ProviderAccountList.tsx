import { useState } from 'react'
import type { ExternalProviderId } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { ConfirmDialog, type ConfirmRequest } from '../../components/ConfirmDialog'
import { providerDisplayName, providerToneStyle } from '../models/providerCatalog'
import { ProviderIcon } from '../models/ProviderIcon'
import { ProviderUsageWindows } from './ProviderUsageWindows'
import type { ProviderUsageRowState } from './useProviderAccounts'

export type ProviderAccountListProps = {
  rows: ProviderUsageRowState[]
  conversationBindings: Partial<Record<ExternalProviderId, string>>
  switchLocked: boolean
  /** M5 — false when the CLI exposes accounts but not usage (old CLI): the
   *  list renders without usage bars and shows the "update the CLI" message. */
  usageCapable?: boolean
  onAdd: (provider: ExternalProviderId) => void
  onSetDefault: (provider: ExternalProviderId, accountId: string) => void
  onUse: (provider: ExternalProviderId, accountId: string) => void
  onReconnect: (provider: ExternalProviderId, accountId: string) => void
  onRemove: (provider: ExternalProviderId, accountId: string) => void
  onRefresh: (provider: ExternalProviderId, accountId: string) => void
}

export function ProviderAccountList({
  rows,
  conversationBindings,
  switchLocked,
  usageCapable = true,
  onAdd,
  onSetDefault,
  onUse,
  onReconnect,
  onRemove,
  onRefresh,
}: ProviderAccountListProps) {
  const { t } = useI18n()
  const [confirm, setConfirm] = useState<ConfirmRequest>()
  const groups = (['codex', 'claude'] as ExternalProviderId[]).map(provider => ({
    provider,
    rows: rows.filter(row => row.account.provider === provider),
  }))

  function requestRemove(provider: ExternalProviderId, accountId: string) {
    setConfirm({
      title: t('settings.provider.removeTitle'),
      description: t('settings.provider.removeBody'),
      confirmLabel: t('settings.provider.remove'),
      danger: true,
      onConfirm: () => onRemove(provider, accountId),
    })
  }

  function requestUse(provider: ExternalProviderId, accountId: string, label: string) {
    setConfirm({
      title: t('settings.provider.useThisAccount'),
      description: t('settings.provider.accountChangedActivity', { account: label }),
      confirmLabel: t('settings.provider.useThisAccount'),
      onConfirm: () => onUse(provider, accountId),
    })
  }

  return (
    <>
      <section className="provider-account-list">
        {!usageCapable && rows.length > 0 && (
          <p className="provider-usage-state">{t('settings.provider.updateCliForUsage')}</p>
        )}
        {groups.map(({ provider, rows: providerRows }) => (
          <div className="provider-account-group" key={provider}>
            <div className="provider-account-group-head">
              <div className="provider-account-provider">
                <ProviderIcon providerId={provider} size={20} style={providerToneStyle(provider)} />
                <h2>{providerDisplayName(provider, t)}</h2>
              </div>
              <button type="button" className="provider-card-action" onClick={() => onAdd(provider)} disabled={switchLocked}>
                {t('settings.provider.addAccount')}
              </button>
            </div>
            {providerRows.length === 0 ? (
              <p className="provider-usage-state">{t('settings.provider.notConnectedAccounts')}</p>
            ) : providerRows.map(row => {
              const account = row.account
              const usedHere = conversationBindings[provider] === account.accountId
              return (
                <article className="provider-account-row" key={account.accountId}>
                  <div className="provider-account-row-head">
                    <div>
                      <strong>{account.displayLabel}</strong>
                      {account.planDisplayName && <span className="provider-account-plan">{account.planDisplayName}</span>}
                    </div>
                    <div className="provider-account-badges">
                      {account.isDefault && <span className="provider-account-badge">{t('settings.provider.default')}</span>}
                      {usedHere && <span className="provider-account-badge is-current">{t('settings.provider.usedInConversation')}</span>}
                    </div>
                  </div>
                  <ProviderUsageWindows state={row} />
                  <div className="provider-account-actions">
                    <button type="button" className="provider-card-action" onClick={() => requestUse(provider, account.accountId, account.displayLabel)} disabled={switchLocked}>
                      {t('settings.provider.useHere')}
                    </button>
                    {!account.isDefault && <button type="button" className="provider-card-action" onClick={() => onSetDefault(provider, account.accountId)} disabled={switchLocked}>{t('settings.provider.makeDefault')}</button>}
                    <button type="button" className="provider-card-action" onClick={() => onReconnect(provider, account.accountId)} disabled={switchLocked}>{t('settings.provider.reconnect')}</button>
                    <button type="button" className="provider-card-action" onClick={() => onRefresh(provider, account.accountId)} disabled={switchLocked}>{t('common.refresh')}</button>
                    <button type="button" className="provider-card-action danger" onClick={() => requestRemove(provider, account.accountId)} disabled={switchLocked}>{t('settings.provider.remove')}</button>
                  </div>
                </article>
              )
            })}
          </div>
        ))}
        {switchLocked && <p className="provider-switch-locked">{t('settings.provider.switchLocked')}</p>}
      </section>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(undefined)} />
    </>
  )
}
