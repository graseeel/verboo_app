import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { useEffect } from 'react'
import { I18nProvider } from '../i18n'
import { useBrowserPanel } from '../features/browser/useBrowserPanel'
import { TopBar } from './TopBar'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

function BrowserGlobeHarness() {
  const browser = useBrowserPanel()
  useEffect(() => {
    browser.applySession({
      tabs: [{
        id: 'tab-a', label: 'label-a', url: 'https://example.com', title: 'Example',
        canGoBack: false, canGoForward: false, loading: false, generation: 0, recoverableError: null, evicted: false,
      }],
      activeTabId: 'tab-a',
      visible: true,
    })
  }, [browser.applySession])

  return (
    <I18nProvider language="pt-BR">
      <TopBar
        sidebarVisible
        onToggleSidebar={() => {}}
        terminalOpen={false}
        onToggleTerminal={() => {}}
        reviewOpen={false}
        onToggleReview={() => {}}
        browserAvailable
        browserOpen={browser.browserOpen}
        onToggleBrowser={browser.toggle}
        workspacePanelsEnabled
      />
      <output aria-label="Estado do navegador">{browser.browserOpen ? 'aberto' : 'minimizado'}</output>
    </I18nProvider>
  )
}

describe('TopBar workspace panel controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

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
          browserAvailable
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
          browserAvailable
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

  it('hides only the embedded browser control outside macOS', () => {
    render(
      <I18nProvider language="pt-BR">
        <TopBar
          sidebarVisible
          onToggleSidebar={vi.fn()}
          terminalOpen={false}
          onToggleTerminal={vi.fn()}
          reviewOpen={false}
          onToggleReview={vi.fn()}
          browserAvailable={false}
          browserOpen={false}
          onToggleBrowser={vi.fn()}
          workspacePanelsEnabled
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('button', { name: 'Abrir terminal local' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Abrir revisão de arquivos' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Abrir navegador' })).not.toBeInTheDocument()
  })

  it('exposes the iOS simulator control when the native capability is available', () => {
    render(
      <I18nProvider language="pt-BR">
        <TopBar
          sidebarVisible
          onToggleSidebar={vi.fn()}
          terminalOpen={false}
          onToggleTerminal={vi.fn()}
          reviewOpen={false}
          onToggleReview={vi.fn()}
          browserAvailable={false}
          browserOpen={false}
          onToggleBrowser={vi.fn()}
          simulatorAvailable
          simulatorOpen={false}
          onToggleSimulator={vi.fn()}
          workspacePanelsEnabled
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('button', { name: 'Abrir simulador' })).toBeEnabled()
  })

  it('does not advertise the iOS simulator on unsupported platforms', () => {
    render(
      <I18nProvider language="pt-BR">
        <TopBar
          sidebarVisible
          onToggleSidebar={vi.fn()}
          terminalOpen={false}
          onToggleTerminal={vi.fn()}
          reviewOpen={false}
          onToggleReview={vi.fn()}
          browserAvailable={false}
          browserOpen={false}
          onToggleBrowser={vi.fn()}
          simulatorAvailable={false}
          simulatorOpen={false}
          onToggleSimulator={vi.fn()}
          workspacePanelsEnabled
        />
      </I18nProvider>,
    )

    expect(screen.queryByRole('button', { name: 'Abrir simulador' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Gravação de tela em andamento')).not.toBeInTheDocument()
  })

  it('keeps the simulator recording indicator in the top bar while the panel is hidden', () => {
    render(
      <I18nProvider language="pt-BR">
        <TopBar
          sidebarVisible
          onToggleSidebar={vi.fn()}
          terminalOpen={false}
          onToggleTerminal={vi.fn()}
          reviewOpen={false}
          onToggleReview={vi.fn()}
          browserAvailable={false}
          browserOpen={false}
          onToggleBrowser={vi.fn()}
          simulatorAvailable
          simulatorOpen={false}
          recordingActive
          onToggleSimulator={vi.fn()}
          workspacePanelsEnabled
        />
      </I18nProvider>,
    )

    expect(screen.getByLabelText('Gravação de tela em andamento')).toBeInTheDocument()
  })

  it('the globe suspends media when minimizing and returns control when reopening', () => {
    render(<BrowserGlobeHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'Abrir navegador' }))
    expect(screen.getByLabelText('Estado do navegador')).toHaveTextContent('aberto')
    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', {
      tabId: 'tab-a',
      suspended: false,
    })
    vi.mocked(invoke).mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Minimizar navegador' }))
    expect(screen.getByLabelText('Estado do navegador')).toHaveTextContent('minimizado')
    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', {
      tabId: 'tab-a',
      suspended: true,
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'browser_tab_set_media_suspended',
      expect.objectContaining({ suspended: false }),
    )
    vi.mocked(invoke).mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Abrir navegador' }))
    expect(screen.getByLabelText('Estado do navegador')).toHaveTextContent('aberto')
    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', {
      tabId: 'tab-a',
      suspended: false,
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'browser_tab_set_media_suspended',
      expect.objectContaining({ suspended: true }),
    )
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'browser_tab_set_media_suspended')).toHaveLength(1)
  })
})
