import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { CliBootstrapGate } from './CliBootstrapGate'

describe('CliBootstrapGate', () => {
  it('blocks the chat with real progress while keeping Settings reachable in pt-BR', () => {
    const onOpenSettings = vi.fn()

    render(
      <I18nProvider language="pt-BR">
        <CliBootstrapGate
          phase="installing"
          stage="cli"
          percent={42}
          onRetry={vi.fn()}
          onOpenSettings={onOpenSettings}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('Instalando o CLI do Verboo')).toBeVisible()
    expect(screen.getByText('42%')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Configurar o app' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('shows a retryable error without hiding the technical cause', () => {
    const onRetry = vi.fn()

    render(
      <I18nProvider language="en-US">
        <CliBootstrapGate
          phase="error"
          stage="cli"
          error="CLI: offline"
          onRetry={onRetry}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't install the Verboo CLI")
    expect(screen.getByText('CLI: offline')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('confirms that the CLI is ready before the gate disappears', () => {
    render(
      <I18nProvider language="en-US">
        <CliBootstrapGate
          phase="success"
          stage="cli"
          onRetry={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Verboo is ready')
    expect(screen.getByText('Everything is ready. You can start a chat now.')).toBeVisible()
  })

  it('names runtime preparation separately from CLI installation', () => {
    const { rerender } = render(
      <I18nProvider language="en-US">
        <CliBootstrapGate
          phase="installing"
          stage="runtime"
          percent={20}
          onRetry={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('Preparing Verboo')).toBeVisible()
    expect(screen.getByText(/secure runtime/i)).toBeVisible()

    rerender(
      <I18nProvider language="en-US">
        <CliBootstrapGate
          phase="installing"
          stage="cli"
          percent={70}
          onRetry={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    )
    expect(screen.getByText('Installing the Verboo CLI')).toBeVisible()
  })

  it('checking phase: honest neutral copy with a spinner, never download claims', () => {
    render(
      <I18nProvider language="en-US">
        <CliBootstrapGate
          phase="checking"
          stage="runtime"
          onRetry={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('Checking Verboo')).toBeVisible()
    expect(
      screen.getByText('Verboo is checking the local setup. CLI sign-in stays paused until preparation is complete.'),
    ).toBeVisible()
    // No download/runtime claims before the first authoritative snapshot.
    expect(screen.queryByText('Installing the Verboo CLI')).toBeNull()
    expect(screen.queryByText('The runtime is ready. Verboo is now installing and validating the CLI.')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
    // The checking icon carries the phase class and a spinning svg element;
    // jsdom cannot prove real movement, only the wiring.
    const card = document.querySelector('.cli-bootstrap-card--checking')
    expect(card).toBeTruthy()
    expect(card!.querySelector('.cli-bootstrap-state-icon svg')).toBeTruthy()
  })

  it('actions live INSIDE the card in both presentations (containment)', () => {
    const { container } = render(
      <I18nProvider language="en-US">
        <CliBootstrapGate
          phase="error"
          stage="cli"
          error="CLI: offline"
          onRetry={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    )

    const retry = screen.getByRole('button', { name: 'Try again' })
    const configure = screen.getByRole('button', { name: 'Configure the app' })
    expect(retry.closest('.cli-bootstrap-card')).toBeTruthy()
    expect(configure.closest('.cli-bootstrap-card')).toBeTruthy()
    expect(container.querySelector('.cli-bootstrap-gate')).toBeTruthy()
  })

  it.each(['success', 'error'] as const)('aria-busy is false in %s', phase => {
    render(
      <I18nProvider language="en-US">
        <CliBootstrapGate
          phase={phase}
          stage="cli"
          error={phase === 'error' ? 'boom' : undefined}
          onRetry={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole(phase === 'error' ? 'alert' : 'status')).toHaveAttribute('aria-busy', 'false')
  })
})
