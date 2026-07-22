import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { TopBar } from './TopBar'

describe('TopBar workspace panel controls', () => {
  it('keeps all three controls visible but disabled in fullscreen views', () => {
    render(
      <I18nProvider language="pt-BR">
        <TopBar
          sidebarVisible
          onToggleSidebar={vi.fn()}
          terminalOpen={false}
          onToggleTerminal={vi.fn()}
          reviewOpen={false}
          onToggleReview={vi.fn()}
          browserOpen={false}
          onToggleBrowser={vi.fn()}
          workspacePanelsEnabled={false}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('button', { name: 'Abrir terminal local' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Abrir revisão de arquivos' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Abrir navegador' })).toBeDisabled()
  })

  it('keeps all three controls enabled in Chat', () => {
    render(
      <I18nProvider language="pt-BR">
        <TopBar
          sidebarVisible
          onToggleSidebar={vi.fn()}
          terminalOpen={false}
          onToggleTerminal={vi.fn()}
          reviewOpen={false}
          onToggleReview={vi.fn()}
          browserOpen={false}
          onToggleBrowser={vi.fn()}
          workspacePanelsEnabled
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('button', { name: 'Abrir terminal local' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Abrir revisão de arquivos' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Abrir navegador' })).toBeEnabled()
  })
})
