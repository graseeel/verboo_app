import { useRef, useState, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'
import { Check, LayoutGrid, LayoutList, LoaderCircle, MoreVertical, Pencil } from 'lucide-react'
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
import {
  getProviderAccountViewMode,
  setProviderAccountViewMode,
  type ProviderAccountViewMode,
} from './providerAccountViewMode'

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
  /** L1 — provider whose login flow is active (its group head shows live
   *  progress + Cancel, and the Add account button is disabled to prevent
   *  two simultaneous provider_login_start for the same provider). */
  connectingProvider?: string
  /** L1 — flow stage driven by provider-login:event. 'starting' until the
   *  CLI reports awaiting_browser, then 'awaiting_browser' until connected. */
  loginStage?: 'starting' | 'awaiting_browser'
  /** L1 — Aborts the active login flow (provider_login_cancel). The invoke
   *  is the SAME one used by the legacy Connect/Disconnect card flow. */
  onCancelLogin?: () => void
}

function detectedPlanDisplayName(row: ProviderUsageRowState): string | undefined {
  const explicit = row.account.planDisplayName ?? row.snapshot?.plan?.displayName
  if (explicit || row.account.provider !== 'claude' || !row.snapshot) return explicit

  // Claude's usage endpoint is authoritative about which quota windows exist,
  // but CLI accounts connected before plan metadata was added can have no
  // planId/planDisplayName. The approved Pro/Max distinction is encoded by
  // those provider-reported windows: Fable is Max-only; otherwise the normal
  // 5-hour + weekly pair is Pro. Never infer from labels or percentages.
  const hasFableWindow = row.snapshot.windows.some(window => (
    window.kind === 'model-scoped-weekly'
    && window.modelScope?.trim().toLowerCase() === 'fable'
  ))
  if (hasFableWindow) return 'Max'

  const hasSessionWindow = row.snapshot.windows.some(window => window.kind === 'session')
  const hasWeeklyWindow = row.snapshot.windows.some(window => window.kind === 'weekly')
  return hasSessionWindow && hasWeeklyWindow ? 'Pro' : undefined
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
  connectingProvider,
  loginStage,
  onCancelLogin,
}: ProviderAccountListProps) {
  const { t } = useI18n()
  const [confirm, setConfirm] = useState<ConfirmRequest>()
  const [menu, setMenu] = useState<ContextMenuState>()
  const [editingNickname, setEditingNickname] = useState<string>()
  const [nicknameDraft, setNicknameDraft] = useState('')
  const [viewMode, setViewMode] = useState<ProviderAccountViewMode>(getProviderAccountViewMode)
  const listRef = useRef<HTMLElement>(null)
  const groups = (['codex', 'claude'] as ExternalProviderId[]).map(provider => ({
    provider,
    rows: rows.filter(row => row.account.provider === provider),
  }))

  /** VIEW — alterna entre cards compactos (simple) e lista vertical
   *  (expanded), persistindo a escolha em localStorage (padrão
   *  providerAccountNicknames — nunca no protocolo CLI). */
  function toggleViewMode() {
    const next: ProviderAccountViewMode = viewMode === 'simple' ? 'expanded' : 'simple'
    setProviderAccountViewMode(next)
    const commit = () => flushSync(() => setViewMode(next))
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (reducedMotion) {
      commit()
      return
    }

    const transitionDocument = document as Document & {
      startViewTransition?: (callback: () => void) => unknown
    }
    if (transitionDocument.startViewTransition) {
      transitionDocument.startViewTransition(commit)
      return
    }

    const list = listRef.current
    commit()
    list?.animate?.(
      [
        { opacity: 0.86, transform: 'translateY(2px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    )
  }

  /** VIEW — corpo da conta COMPARTILHADO pelos dois modos: só o wrapper muda
   *  (provider-account-card/-card-head no simple; provider-account-row/
   *  -row-head no expanded). Todo o estado de interação (kebab, nickname,
   *  use/in-use, ícone, badges) vive aqui e vale identicamente nos dois modos. */
  function renderAccount(provider: ExternalProviderId, row: ProviderUsageRowState) {
    const account = row.account
    const usedHere = conversationBindings[provider] === account.accountId
    const nickname = getProviderAccountNickname(provider, account.accountId)
    const displayName = nickname ?? account.displayLabel
    const planDisplayName = detectedPlanDisplayName(row)
    const editing = editingNickname === account.accountId
    const expanded = viewMode === 'expanded'
    const articleClass = expanded ? 'provider-account-row' : 'provider-account-card'
    const headClass = expanded ? 'provider-account-row-head' : 'provider-account-card-head'
    return (
      <article className={articleClass} key={account.accountId}>
        <div className={headClass}>
          <div>
            <span className="provider-account-name">
              {/* L2 — o símbolo do provedor fica na conta (card ou row)
                  SEMPRE (renomeada ou não): renomear substitui o
                  displayLabel do CLI ("Codex 2") pelo apelido, e sem
                  o ícone a conta perde a identidade do provedor
                  (relato do usuário com screenshot). */}
              <ProviderIcon providerId={provider} size={16} style={providerToneStyle(provider)} />
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
                <>
                  <strong>{displayName}</strong>
                  {/* UI — the nickname pencil sits inline, right of
                      the account name (approved annotated print). */}
                  <button
                    type="button"
                    className="provider-name-edit-button"
                    aria-label={t('settings.provider.editNickname')}
                    onClick={() => startNicknameEdit(provider, account.accountId)}
                    disabled={switchLocked}
                  >
                    <Pencil size={12} />
                  </button>
                </>
              )}
            </span>
            {planDisplayName && <span className="provider-account-plan">{planDisplayName}</span>}
          </div>
          <div className="provider-account-badges">
            {account.isDefault && <span className="provider-account-badge">{t('settings.provider.default')}</span>}
            {usedHere && <span className="provider-account-badge is-current">{t('settings.provider.usedInConversation')}</span>}
          </div>
        </div>
        <ProviderUsageWindows state={row} />
        {/* L2 + A2 — UMA linha de ações: ação primária (Usar aqui / Em uso)
            abaixo das janelas de uso (simple: alinhada à esquerda com o
            bloco; expanded: centralizada — CSS recuperado de a4ba525), kebab
            à direita na MESMA linha. Em uso é ESTADO SELECIONADO (check +
            acento), não um botão desabilitado; Usar aqui é botão secundário
            padrão. */}
        <div className="provider-account-actions">
          {usedHere ? (
            <span className="provider-card-action is-current" role="status" aria-label={t('settings.provider.inUse')}>
              <Check size={13} aria-hidden="true" /> {t('settings.provider.inUse')}
            </span>
          ) : (
            <button type="button" className="provider-card-action" onClick={() => requestUse(provider, account.accountId, displayName)} disabled={switchLocked}>
              {t('settings.provider.useHere')}
            </button>
          )}
          <button type="button" className="provider-card-action provider-account-kebab" aria-label={t('settings.provider.accountMenu')} onClick={event => openAccountMenu(event, provider, account)}>
            <MoreVertical size={14} />
          </button>
        </div>
      </article>
    )
  }

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
      <section ref={listRef} className={`provider-account-list${viewMode === 'expanded' ? ' is-expanded' : ''}`}>
        {/* VIEW — alternância simples/expandida no topo da aba, persistida
            em localStorage. O controle nomeia e ilustra a AÇÃO seguinte,
            em vez de exigir que o usuário deduza o modo atual pelo ícone. */}
        <div className="provider-account-list-toolbar">
          <button
            type="button"
            className="provider-view-toggle ui-tooltip"
            aria-label={
              viewMode === 'simple'
                ? t('settings.provider.viewModeToExpanded')
                : t('settings.provider.viewModeToSimple')
            }
            data-tooltip={
              viewMode === 'simple'
                ? t('settings.provider.viewModeToExpanded')
                : t('settings.provider.viewModeToSimple')
            }
            data-tooltip-align="end"
            onClick={toggleViewMode}
            data-view-mode={viewMode}
          >
            <span className="provider-view-toggle-icons" aria-hidden="true">
              <LayoutGrid className="provider-view-icon is-grid" size={14} />
              <LayoutList className="provider-view-icon is-list" size={14} />
            </span>
            <span className="provider-view-toggle-label">
              {viewMode === 'simple'
                ? t('settings.provider.viewModeExpand')
                : t('settings.provider.viewModeSimplify')}
            </span>
          </button>
        </div>
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
              {/* L1 — enquanto um login deste provedor está em andamento, o
                  card mostra o estágio como STATUS QUIETO (spinner pequeno +
                  rótulo, NÃO um botão desabilitado) e o botão Cancelar —
                  mesma linha, alinhados. O Adicionar conta fica travado para
                  evitar dois provider_login_start simultâneos. Mesmo invoke
                  provider_login_cancel do caminho legacy. */}
              {connectingProvider === provider && (
                <span className="provider-card-actions">
                  <span className="provider-login-stage" role="status">
                    <LoaderCircle size={12} className="spin-icon" aria-hidden="true" />
                    {loginStage === 'awaiting_browser'
                      ? t('settings.provider.waitingBrowser')
                      : t('settings.provider.connecting')}
                  </span>
                  <button
                    type="button"
                    className="provider-card-action"
                    onClick={() => onCancelLogin?.()}
                  >
                    {t('common.cancel')}
                  </button>
                </span>
              )}
              <button
                type="button"
                className="provider-card-action"
                onClick={() => onAdd(provider)}
                disabled={switchLocked || connectingProvider === provider}
                title={connectingProvider === provider ? t('settings.provider.addAccountInProgressTitle') : undefined}
              >
                {t('settings.provider.addAccount')}
              </button>
            </div>
            {providerRows.length === 0 ? (
              <p className="provider-usage-state">{t('settings.provider.notConnectedAccounts')}</p>
            ) : (
              <div className="provider-account-cards">
                {providerRows.map(row => renderAccount(provider, row))}
              </div>
            )}
          </div>
        ))}
        {switchLocked && <p className="provider-switch-locked">{t('settings.provider.switchLocked')}</p>}
      </section>
      <ContextMenu menu={menu} onClose={() => setMenu(undefined)} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(undefined)} />
    </>
  )
}
