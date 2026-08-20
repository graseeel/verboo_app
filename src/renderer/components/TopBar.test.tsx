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

  it.each([
    ['darwin', ['Simulador iOS', 'Emulador Android']],
    ['win32', ['Emulador Android']],
    ['linux', ['Emulador Android']],
  ] as const)('shows the platform-correct simulator menu on %s', (platform, options) => {
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
          platform={platform}
          onOpenSimulator={vi.fn()}
          workspacePanelsEnabled
        />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Simuladores' }))
    expect(screen.getAllByRole('menuitem').map(option => option.textContent)).toEqual(options)
  })

  it('does not advertise simulators before native configuration is loaded', () => {
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
          platform="linux"
          onOpenSimulator={vi.fn()}
          workspacePanelsEnabled
        />
      </I18nProvider>,
    )

    expect(screen.queryByRole('button', { name: 'Simuladores' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Gravação de tela em andamento')).not.toBeInTheDocument()
  })

  it('selects a simulator platform and closes the menu', () => {
    const onOpenSimulator = vi.fn()
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
          platform="darwin"
          onOpenSimulator={onOpenSimulator}
          workspacePanelsEnabled
        />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Simuladores' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Emulador Android' }))

    expect(onOpenSimulator).toHaveBeenCalledWith('android')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('supports keyboard entry, Escape with focus return, and outside dismissal', () => {
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
          platform="darwin"
          onOpenSimulator={vi.fn()}
          workspacePanelsEnabled
        />
      </I18nProvider>,
    )

    const trigger = screen.getByRole('button', { name: 'Simuladores' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Simulador iOS' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
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
          platform="darwin"
          onOpenSimulator={vi.fn()}
          workspacePanelsEnabled
        />
      </I18nProvider>,
    )

    const menuButton = screen.getByRole('button', { name: 'Simuladores' })
    expect(screen.getByLabelText('Gravação de tela em andamento')).toBe(menuButton.querySelector('.topbar-simulator-recording'))
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
