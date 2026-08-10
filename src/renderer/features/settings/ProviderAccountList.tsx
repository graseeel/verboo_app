import { useState, type MouseEvent } from 'react'
import { Check, MoreVertical, Pencil } from 'lucide-react'
import type { ExternalProviderId, ProviderAccountSummary } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { ConfirmDialog, type ConfirmRequest } from '../../components/ConfirmDialog'
import { ContextMenu, type ContextMenuState } from '../../components/ContextMenu'
import { providerDisplayName, providerToneStyle } from '../models/providerCatalog'
import { ProviderIcon } from '../models/ProviderIcon'
import { ProviderUsageWindows } from './ProviderUsageWindows'
import type { ProviderUsageRowState } from './useProviderAccounts'
import {
  getProviderAccountNickname,
  setProviderAccountNickname,
} from './providerAccountNicknames'

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
  const [menu, setMenu] = useState<ContextMenuState>()
  const [editingNickname, setEditingNickname] = useState<string>()
  const [nicknameDraft, setNicknameDraft] = useState('')
  const groups = (['codex', 'claude'] as ExternalProviderId[]).map(provider => ({
    provider,
    rows: rows.filter(row => row.account.provider === provider),
  }))

  function openAccountMenu(event: MouseEvent<HTMLButtonElement>, provider: ExternalProviderId, account: ProviderAccountSummary) {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({
      x: rect.left,
      y: rect.bottom + 4,
      items: [
        ...(!account.isDefault ? [{
          key: 'make-default',
          label: t('settings.provider.makeDefault'),
          disabled: switchLocked,
          onSelect: () => onSetDefault(provider, account.accountId),
        }] : []),
        { key: 'reconnect', label: t('settings.provider.reconnect'), disabled: switchLocked, onSelect: () => onReconnect(provider, account.accountId) },
        // P1 — Refresh stays reachable during an active turn (read-only).
        { key: 'refresh', label: t('common.refresh'), onSelect: () => onRefresh(provider, account.accountId) },
        {
          key: 'remove',
          label: t('settings.provider.remove'),
          danger: true,
          disabled: switchLocked,
          onSelect: () => requestRemove(provider, account.accountId),
        },
      ],
    })
  }

  function startNicknameEdit(provider: ExternalProviderId, accountId: string) {
    setEditingNickname(accountId)
    setNicknameDraft(getProviderAccountNickname(provider, accountId) ?? '')
  }

  function commitNickname(provider: ExternalProviderId, accountId: string) {
    setProviderAccountNickname(provider, accountId, nicknameDraft)
    setEditingNickname(undefined)
  }

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
              const nickname = getProviderAccountNickname(provider, account.accountId)
              const displayName = nickname ?? account.displayLabel
              const editing = editingNickname === account.accountId
              return (
                <article className="provider-account-row" key={account.accountId}>
                  <div className="provider-account-row-head">
                    <div>
                      {editing ? (
                        <span className="provider-nickname-edit">
                          <input
                            type="text"
                            value={nicknameDraft}
                            aria-label={t('settings.provider.nickname')}
                            onChange={event => setNicknameDraft(event.target.value)}
                            onKeyDown={event => {
                              if (event.key === 'Enter') commitNickname(provider, account.accountId)
                              if (event.key === 'Escape') setEditingNickname(undefined)
                            }}
                            onBlur={() => commitNickname(provider, account.accountId)}
                            autoFocus
                          />
                        </span>
                      ) : (
                        <strong>{displayName}</strong>
                      )}
                      {account.planDisplayName && <span className="provider-account-plan">{account.planDisplayName}</span>}
                    </div>
                    <div className="provider-account-badges">
                      {account.isDefault && <span className="provider-account-badge">{t('settings.provider.default')}</span>}
                      {usedHere && <span className="provider-account-badge is-current">{t('settings.provider.usedInConversation')}</span>}
                    </div>
                  </div>
                  <ProviderUsageWindows state={row} />
                  <div className="provider-account-actions">
                    {usedHere ? (
                      <span className="provider-card-action is-current" aria-label={t('settings.provider.inUse')}>
                        <Check size={13} /> {t('settings.provider.inUse')}
                      </span>
                    ) : (
                      <button type="button" className="provider-card-action" onClick={() => requestUse(provider, account.accountId, displayName)} disabled={switchLocked}>
                        {t('settings.provider.useHere')}
                      </button>
                    )}
                    <button type="button" className="provider-card-action" aria-label={t('settings.provider.editNickname')} onClick={() => startNicknameEdit(provider, account.accountId)} disabled={switchLocked}>
                      <Pencil size={13} />
                    </button>
                    <button type="button" className="provider-card-action" aria-label={t('settings.provider.accountMenu')} onClick={event => openAccountMenu(event, provider, account)} disabled={false}>
                      <MoreVertical size={14} />
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        ))}
        {switchLocked && <p className="provider-switch-locked">{t('settings.provider.switchLocked')}</p>}
      </section>
      <ContextMenu menu={menu} onClose={() => setMenu(undefined)} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(undefined)} />
    </>
  )
}
