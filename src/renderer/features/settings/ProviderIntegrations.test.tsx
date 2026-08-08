import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import type { ProviderAuthStatus } from '../../../shared/types'
import { ProviderIntegrations } from './ProviderIntegrations'

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
})
