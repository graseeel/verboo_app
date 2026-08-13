import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'

import type { ProviderAuthStatus } from '../../../shared/types'
import type { ProviderUsageRowState } from './useProviderAccounts'
import { ProviderIntegrations } from './ProviderIntegrations'

const connectedCodexRow: ProviderUsageRowState = {
  account: {
    schemaVersion: 1,
    provider: 'codex',
    accountId: 'local-a',
    displayLabel: 'Codex 1',
    isDefault: true,
    connectionState: 'connected',
  },
  status: 'idle',
}

/**
 * F3 retrabalho — Ajustes → Integrações: um cartão por provedor, com o
 * universo vindo da PONTE DE LOGIN (decisão do Maestro).
 *
 * Fixtures use the REAL shape registered in Rust (provider_login_pty.rs:74-79,
 * command provider_auth_status in lib.rs:1583): one entry PER PROVIDER the
 * bridge supports — { provider, connected, account? } — connected=false
 * included; `account` absent when None (skip_serializing_if). The bridge's
 * supported universe today: codex, claude (SUPPORTED_PROVIDERS).
 */

const codexDisconnected: ProviderAuthStatus = { provider: 'codex', connected: false }
const claudeConnected: ProviderAuthStatus = { provider: 'claude', connected: true, account: 'user@example.com' }
const acmeConnected: ProviderAuthStatus = { provider: 'acme', connected: true }

beforeEach(() => cleanup())

describe('ProviderIntegrations — cartões por provedor (universo da ponte)', () => {
  it('does not flash the legacy provider cards while account discovery is still loading', () => {
    render(
      <ProviderIntegrations
        statuses={[claudeConnected]}
        onConnect={() => {}}
        onCancelLogin={() => {}}
        accountsLoaded={false}
      />,
    )

    expect(screen.getByRole('status', { name: /loading provider accounts|carregando contas de provedores/i })).toBeInTheDocument()
    expect(document.querySelector('.provider-card')).toBeNull()
    expect(screen.queryByRole('button', { name: /Disconnect|Desconectar/i })).toBeNull()
  })

  it('real empty state: EMPTY status list → renders nothing (tab identical to today)', () => {
    const { container } = render(
      <ProviderIntegrations statuses={[]} onConnect={() => {}} onCancelLogin={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('connected card: name, "Conectado", account line, cost note, Disconnect DISABLED with honest tooltip', () => {
    render(
      <ProviderIntegrations statuses={[claudeConnected]} onConnect={() => {}} onCancelLogin={() => {}} />,
    )
    expect(screen.getByText('Claude')).toBeTruthy()
    expect(screen.getByText(/^Connected$|^Conectado$/i)).toBeTruthy()
    // Official brand icon replaces the old colored dot on the card.
    expect(document.querySelector('.provider-card-head [data-testid="provider-icon-claude"]')).toBeTruthy()
    // Account comes from the bridge entry (not the global CLI auth method).
    expect(screen.getByText(/user@example\.com/)).toBeTruthy()
    expect(screen.getByText(/billed on the provider account|cobrado na conta do provedor/i)).toBeTruthy()
    // MAESTRO'S ORDER: the CLI logout is GLOBAL — it must NOT sit behind a
    // per-provider "Disconnect". The button exists but is DISABLED, with a
    // tooltip explaining when it becomes available.
    const button = screen.getByRole('button', { name: /Disconnect|Desconectar/i })
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toMatch(/per-provider logout|logout por provedor/i)
  })

  it('disconnected card: "Não conectado" state and an ENABLED Conectar that fires onConnect with the provider id', () => {
    const onConnect = vi.fn()
    render(
      <ProviderIntegrations statuses={[codexDisconnected]} onConnect={onConnect} onCancelLogin={() => {}} />,
    )
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.getByText(/Not connected|Não conectado/i)).toBeTruthy()
    expect(document.querySelector('.provider-card-head [data-testid="provider-icon-codex"]')).toBeTruthy()
    const button = screen.getByRole('button', { name: /Connect|Conectar/i })
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
    expect(onConnect).toHaveBeenCalledWith('codex')
  })

  it('unknown provider gets a generic title-case name (nothing hardcoded)', () => {
    render(
      <ProviderIntegrations statuses={[acmeConnected]} onConnect={() => {}} onCancelLogin={() => {}} />,
    )
    expect(screen.getByText('Acme')).toBeTruthy()
  })

  it('hides the account line when the entry has no account', () => {
    const { container } = render(
      <ProviderIntegrations statuses={[acmeConnected]} onConnect={() => {}} onCancelLogin={() => {}} />,
    )
    expect(container.querySelector('.provider-card-account')).toBeNull()
  })

  it('flow STARTING (click, no event yet): disabled "Conectando…" + an enabled Cancelar that fires onCancelLogin', () => {
    const onCancelLogin = vi.fn()
    render(
      <ProviderIntegrations
        statuses={[codexDisconnected, claudeConnected]}
        onConnect={() => {}}
        onCancelLogin={onCancelLogin}
        connectingProvider="codex"
        loginStage="starting"
      />,
    )
    const codexCard = screen.getByText('Codex').closest('.provider-card')!
    const progress = screen.getByRole('button', { name: /Connecting…|Conectando…/i })
    expect(progress).toHaveProperty('disabled', true)
    expect(codexCard.contains(progress)).toBe(true)
    const cancel = screen.getByRole('button', { name: /^Cancel$|^Cancelar$/i })
    expect(cancel).toHaveProperty('disabled', false)
    fireEvent.click(cancel)
    expect(onCancelLogin).toHaveBeenCalledTimes(1)
    // The OTHER provider's card is untouched by the flow.
    expect(screen.getByRole('button', { name: /Disconnect|Desconectar/i })).toHaveProperty('disabled', true)
  })

  it('flow AWAITING BROWSER (event arrived): disabled "Aguardando navegador…" + Cancelar', () => {
    render(
      <ProviderIntegrations
        statuses={[codexDisconnected]}
        onConnect={() => {}}
        onCancelLogin={() => {}}
        connectingProvider="codex"
        loginStage="awaiting_browser"
      />,
    )
    expect(screen.getByRole('button', { name: /Waiting for browser…|Aguardando navegador…/i })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: /^Cancel$|^Cancelar$/i })).toHaveProperty('disabled', false)
    // The old static Conectar must NOT linger next to the progress state.
    expect(screen.queryByRole('button', { name: /^Connect$|^Conectar$/i })).toBeNull()
  })

  // M5 — a CLI with provider_accounts_v1 but WITHOUT provider_usage_v1 is an
  // old-CLI gap, not an app failure: the accounts list renders, but the usage
  // windows are replaced by the "update the CLI" message (i18n key
  // settings.provider.updateCliForUsage already exists in both locales).
  it('M5: accounts v1 without usage v1 shows the update-the-CLI message instead of usage windows', () => {
    render(
      <ProviderIntegrations
        statuses={[codexDisconnected]}
        onConnect={() => {}}
        onCancelLogin={() => {}}
        capabilities={{ providerAccountsV1: true, providerUsageV1: false }}
        accountRows={[connectedCodexRow]}
        conversationBindings={{}}
        switchLocked={false}
      />,
    )
    expect(screen.getByText(/Update the CLI to see usage windows|Atualize o CLI para ver as janelas de uso/i)).toBeInTheDocument()
  })

  it('M5: usage v1 active does not show the update-the-CLI message', () => {
    render(
      <ProviderIntegrations
        statuses={[codexDisconnected]}
        onConnect={() => {}}
        onCancelLogin={() => {}}
        capabilities={{ providerAccountsV1: true, providerUsageV1: true }}
        accountRows={[connectedCodexRow]}
        conversationBindings={{}}
        switchLocked={false}
      />,
    )
    expect(screen.queryByText(/Update the CLI to see usage windows|Atualize o CLI para ver as janelas de uso/i)).toBeNull()
  })

  // L1 — Wire-up: o ramo providerAccountsV1 (caminho novo) precisa receber
  // connectingProvider/loginStage/onCancelLogin do App, igual ao ramo legacy.
  // Hoje ProviderIntegrations.tsx:58-72 renderiza o ProviderAccountList sem
  // essas props — durante o login não há indicador de progresso nem Cancelar
  // no card, e o botão "Adicionar conta" segue clicável.
  it('L1: passes the connecting state + cancel handler down to ProviderAccountList', () => {
    const onCancelLogin = vi.fn()
    render(
      <ProviderIntegrations
        statuses={[codexDisconnected]}
        onConnect={() => {}}
        onCancelLogin={onCancelLogin}
        capabilities={{ providerAccountsV1: true, providerUsageV1: true }}
        accountRows={[connectedCodexRow]}
        conversationBindings={{}}
        switchLocked={false}
        connectingProvider="codex"
        loginStage="starting"
      />,
    )
    const codexGroup = screen.getByRole('heading', { name: 'Codex' }).closest('.provider-account-group') as HTMLElement
    // Add account DESLIGADO durante o login daquele provedor.
    expect(within(codexGroup).getByRole('button', { name: /add account|adicionar conta/i })).toHaveProperty('disabled', true)
    // Cancelar visível + clicável + dispara o invoke cancel.
    fireEvent.click(within(codexGroup).getByRole('button', { name: /^cancel$|^cancelar$/i }))
    expect(onCancelLogin).toHaveBeenCalledTimes(1)
  })
})
