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
          onRetry={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Verboo CLI installed')
    expect(screen.getByText('Everything is ready. You can start a chat now.')).toBeVisible()
  })
})
