import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { SidebarUpdateControl } from './SidebarUpdateControl'

describe('SidebarUpdateControl', () => {
  it('exposes an accessible download action for an available update', () => {
    const onAction = vi.fn()

    render(
      <I18nProvider language="en-US">
        <SidebarUpdateControl
          presentation={{
            phase: 'available',
            version: '0.6.0',
            actionEnabled: true,
          }}
          onAction={onAction}
        />
      </I18nProvider>,
    )

    const action = screen.getByRole('button', { name: 'Download Verboo Code 0.6.0' })
    expect(action).toBeEnabled()
    expect(screen.getByText('Update available')).toBeVisible()

    fireEvent.click(action)
    expect(onAction).toHaveBeenCalledOnce()
  })

  it('shows determinate progress and blocks duplicate actions while downloading', () => {
    const onAction = vi.fn()

    render(
      <I18nProvider language="en-US">
        <SidebarUpdateControl
          presentation={{
            phase: 'downloading',
            version: '0.6.0',
            percent: 42.4,
            actionEnabled: false,
          }}
          onAction={onAction}
        />
      </I18nProvider>,
    )

    const action = screen.getByRole('button', { name: 'Downloading Verboo Code 0.6.0' })
    const progress = screen.getByRole('progressbar', { name: 'Update download progress' })

    expect(action).toBeDisabled()
    expect(progress).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByText('42%')).toBeVisible()

    fireEvent.click(action)
    expect(onAction).not.toHaveBeenCalled()
  })

  it('presents simultaneous app and CLI releases as one action', () => {
    render(
      <I18nProvider language="pt-BR">
        <SidebarUpdateControl
          presentation={{
            phase: 'available',
            target: 'both',
            appVersion: '0.8.0',
            cliVersion: '0.15.6',
            actionEnabled: true,
          }}
          onAction={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText('Atualizações do app e do CLI disponíveis')).toBeVisible()
    expect(screen.getByText('O app 0.8.0 e o CLI 0.15.6 estão disponíveis.')).toBeVisible()
  })
})
