import { useEffect } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { I18nProvider } from '../../i18n'
import { BrowserPanel } from './BrowserPanel'
import { useBrowserPanel } from './useBrowserPanel'
import type { AnnotationMode, BrowserNavigationRequest, BrowserReloadRequest } from './useBrowserPanel'
import type { BrowserSessionSnapshot, BrowserTabSnapshot } from './browserTabs'
import type { AttachmentMeta } from '../../../shared/types'
import type { AnnotationCandidate, AnnotationCaptureReport } from './browserAnnotations'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ tabs: [], activeTabId: null, visible: false }),
  convertFileSrc: vi.fn((path: string) => path),
}))

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

function sessionWithTabs(activeTabId: string, ...ids: string[]): BrowserSessionSnapshot {
  return {
    tabs: ids.map(id => ({
      id, label: `label-${id}`,
      url: id === ids[0] ? 'https://example.com' : 'about:blank',
      title: '', canGoBack: false, canGoForward: false,
      loading: false, generation: 0, recoverableError: null, evicted: false,
    })),
    activeTabId,
    visible: true,
  }
}

function renderPanel({
  onSetWidth = vi.fn(),
  reloadRequest,
  onReloadSnapshot = vi.fn(),
  annotationMode = 'idle' as AnnotationMode,
  navigationRequest,
  onNavigationHandled = vi.fn(),
  session = sessionWithTabs('tab-a', 'tab-a'),
  activeTab = session.tabs.find(t => t.id === session.activeTabId),
  onCreateTab = vi.fn(() => invoke<BrowserSessionSnapshot>('browser_tab_create', { url: undefined })),
  onActivateTab = vi.fn(),
  onNavigateTab = vi.fn((id: string, url: string) => invoke<BrowserSessionSnapshot>('browser_tab_navigate', { tabId: id, url })),
  onCloseTab = vi.fn((id: string) => invoke('browser_tab_close', { tabId: id })),
  onReloadHandled = vi.fn(),
  onAddAnnotation = vi.fn(),
}: {
  onSetWidth?: (width: number) => void
  reloadRequest?: BrowserReloadRequest
  onReloadSnapshot?: (attachment: AttachmentMeta, request: BrowserReloadRequest) => void
  annotationMode?: AnnotationMode
  navigationRequest?: BrowserNavigationRequest
  onNavigationHandled?: (id: string) => void
  session?: BrowserSessionSnapshot
  activeTab?: BrowserTabSnapshot | undefined
  onCreateTab?: () => Promise<BrowserSessionSnapshot>
  onActivateTab?: (id: string) => void
  onNavigateTab?: (id: string, url: string) => Promise<BrowserSessionSnapshot>
  onCloseTab?: (id: string) => void
  onReloadHandled?: (id: string) => void
  onAddAnnotation?: (attachment: AttachmentMeta) => void
} = {}) {
  return render(
    <I18nProvider language="en-US">
      <div className="app-layout">
        <BrowserPanel
          browserOpen
          browserWidth={680}
          annotationMode={annotationMode}
          onSetWidth={onSetWidth}
          onClose={() => {}}
          onTogglePencil={() => {}}
          onToggleArrow={() => {}}
          onAddAnnotation={onAddAnnotation}
          navigationRequest={navigationRequest}
          onNavigationHandled={onNavigationHandled}
          reloadRequest={reloadRequest}
          onReloadSnapshot={onReloadSnapshot}
          onReloadHandled={onReloadHandled}
          minWidth={520}
          maxWidth={864}
          session={session}
          activeTab={activeTab}
          onCreateTab={onCreateTab}
          onActivateTab={onActivateTab}
          onNavigateTab={onNavigateTab}
          onCloseTab={onCloseTab}
        />
      </div>
    </I18nProvider>,
  )
}

function BrowserPanelHarness({ initialSession }: { initialSession?: BrowserSessionSnapshot } = {}) {
  const browser = useBrowserPanel()

  useEffect(() => {
    if (initialSession) browser.applySession(initialSession)
  }, [browser.applySession, initialSession])

  return (
    <I18nProvider language="en-US">
      <button type="button" onClick={browser.open}>Open browser harness</button>
      <output aria-label="Browser panel state">{browser.browserOpen ? 'open' : 'closed'}</output>
      <output aria-label="Active browser tab">{browser.activeTab?.id ?? 'none'}</output>
      <output aria-label="Active browser title">{browser.activeTab?.title ?? 'none'}</output>
      <output aria-label="Active browser URL">{browser.activeTab?.url ?? 'none'}</output>
      <div className="app-layout">
        <BrowserPanel
          browserOpen={browser.browserOpen}
          browserWidth={browser.browserWidth}
          annotationMode={browser.annotationMode}
          onSetWidth={browser.setWidth}
          onClose={browser.close}
          onTogglePencil={browser.togglePencil}
          onToggleArrow={browser.toggleArrow}
          onAddAnnotation={() => {}}
          navigationRequest={browser.navigationRequest}
          onNavigationHandled={browser.completeNavigation}
          reloadRequest={browser.reloadRequest}
          onReloadSnapshot={() => {}}
          onReloadHandled={browser.completeReload}
          minWidth={browser.MIN_WIDTH}
          maxWidth={864}
          session={browser.session}
          activeTab={browser.activeTab}
          onCreateTab={browser.createTab}
          onActivateTab={browser.activateTab}
          onNavigateTab={browser.navigateTab}
          onCloseTab={browser.closeTab}
        />
      </div>
    </I18nProvider>
  )
}

async function closeActiveTabScenario(hasRemainingTab: boolean) {
  const initial = sessionWithTabs('tab-a', 'tab-a', ...(hasRemainingTab ? ['tab-b'] : []))
  const navigated = {
    ...initial,
    tabs: initial.tabs.map(tab => tab.id === 'tab-a'
      ? { ...tab, url: 'https://www.youtube.com', generation: tab.generation + 1 }
      : tab),
  }
  const afterClose = hasRemainingTab
    ? sessionWithTabs('tab-b', 'tab-b')
    : { tabs: [], activeTabId: null, visible: true } satisfies BrowserSessionSnapshot
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === 'browser_tab_close') return Promise.resolve(afterClose)
    if (command === 'browser_tab_navigate') return Promise.resolve(navigated)
    if (command === 'browser_drain_messages') return Promise.resolve([])
    return Promise.resolve(initial)
  })
  render(<BrowserPanelHarness initialSession={initial} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))
  const input = screen.getByPlaceholderText('Enter a URL')
  fireEvent.change(input, { target: { value: 'https://www.youtube.com' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith('browser_tab_navigate', {
      tabId: 'tab-a',
      url: 'https://www.youtube.com',
    })
  })
  expect(input).toHaveValue('https://www.youtube.com')

  fireEvent.click(screen.getByRole('button', { name: 'Close tab www.youtube.com' }))
  await waitFor(() => {
    expect(screen.getByLabelText('Active browser tab')).toHaveTextContent(hasRemainingTab ? 'tab-b' : 'none')
  })
  await act(async () => { await Promise.resolve() })
  return input
}

async function switchActiveTabScenario(urlDraft?: string) {
  const initial = sessionWithTabs('tab-a', 'tab-a', 'tab-b')
  Object.assign(initial.tabs[0], { url: 'https://youtube.com/watch?v=one' })
  Object.assign(initial.tabs[1], { url: 'https://docs.example/guide' })
  const switched = { ...initial, activeTabId: 'tab-b' }
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === 'browser_tab_activate') return Promise.resolve(switched)
    if (command === 'browser_drain_messages') return Promise.resolve([])
    return Promise.resolve(initial)
  })
  render(<BrowserPanelHarness initialSession={initial} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))
  const input = screen.getByPlaceholderText('Enter a URL')
  await waitFor(() => expect(input).toHaveValue('https://youtube.com/watch?v=one'))
  if (urlDraft !== undefined) {
    fireEvent.change(input, { target: { value: urlDraft } })
    expect(input).toHaveValue(urlDraft)
  }

  fireEvent.click(screen.getByRole('tab', { name: 'docs.example' }))
  await waitFor(() => {
    expect(screen.getByLabelText('Active browser tab')).toHaveTextContent('tab-b')
    expect(input).toHaveValue('https://docs.example/guide')
  })
  return input
}

describe('BrowserPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the blank native webview hidden so the empty state remains visible', async () => {
    const blank = sessionWithTabs('tab-a', 'tab-a')
    Object.assign(blank.tabs[0], { url: 'about:blank' })
    renderPanel({ session: blank })

    expect(screen.getByText('Type a URL to get started')).toBeVisible()
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: false })
    })
  })

  it('F3 CONTRAFACTUAL: Enter with no retained tab creates one and navigates it to the typed URL', async () => {
    const createdSession = sessionWithTabs('tab-new', 'tab-new')
    const onCreateTab = vi.fn().mockResolvedValue(createdSession)
    renderPanel({
      session: { tabs: [], activeTabId: null, visible: false },
      activeTab: undefined,
      onCreateTab,
    })
    const input = screen.getByPlaceholderText('Enter a URL')

    fireEvent.change(input, { target: { value: 'www.youtube.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onCreateTab).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith('browser_tab_navigate', {
        tabId: 'tab-new',
        url: 'https://www.youtube.com',
      })
    })
  })

  it('CORRIDA: two rapid Enter presses share one new tab and the latest URL wins', async () => {
    let resolveCreate!: (session: BrowserSessionSnapshot) => void
    const onCreateTab = vi.fn(() => new Promise<BrowserSessionSnapshot>(resolve => {
      resolveCreate = resolve
    }))
    renderPanel({
      session: { tabs: [], activeTabId: null, visible: false },
      activeTab: undefined,
      onCreateTab,
    })
    const input = screen.getByPlaceholderText('Enter a URL')

    fireEvent.change(input, { target: { value: 'first.example' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'latest.example' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onCreateTab).toHaveBeenCalledTimes(1)
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'browser_tab_navigate')).toHaveLength(0)

    resolveCreate(sessionWithTabs('tab-new', 'tab-new'))

    await waitFor(() => {
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'browser_tab_navigate')).toEqual([
        ['browser_tab_navigate', { tabId: 'tab-new', url: 'https://latest.example' }],
      ])
    })
  })

  it('EFEITO: closing while the first tab is being created keeps it hidden and reusable', async () => {
    let resolveCreate!: (session: BrowserSessionSnapshot) => void
    const createdSession = sessionWithTabs('tab-new', 'tab-new')
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'browser_tab_create') {
        return new Promise<BrowserSessionSnapshot>(resolve => {
          resolveCreate = resolve
        })
      }
      if (command === 'browser_tab_navigate') {
        const url = (args as { url: string }).url
        return Promise.resolve({
          ...createdSession,
          tabs: createdSession.tabs.map(tab => ({ ...tab, url, generation: tab.generation + 1 })),
        })
      }
      return Promise.resolve({ tabs: [], activeTabId: null, visible: false })
    })
    render(<BrowserPanelHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))
    await waitFor(() => expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('open'))
    const input = screen.getByPlaceholderText('Enter a URL')
    fireEvent.change(input, { target: { value: 'first.example' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_tab_create', { url: undefined })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Minimize browser' }))
    expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('closed')
    resolveCreate(createdSession)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_tab_navigate', {
        tabId: 'tab-new',
        url: 'https://first.example',
      })
    })
    expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('closed')
    expect(invoke).not.toHaveBeenCalledWith('browser_session_set_visible', { visible: true })

    fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))
    fireEvent.change(input, { target: { value: 'second.example' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_tab_navigate', {
        tabId: 'tab-new',
        url: 'https://second.example',
      })
    })
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'browser_tab_create')).toHaveLength(1)
  })

  it('EFEITO: closing while an existing tab navigates cannot reshow the native view', async () => {
    let resolveNavigate!: (session: BrowserSessionSnapshot) => void
    const activeSession = sessionWithTabs('tab-a', 'tab-a')
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'browser_tab_navigate') {
        return new Promise<BrowserSessionSnapshot>(resolve => {
          resolveNavigate = resolve
        })
      }
      return Promise.resolve(activeSession)
    })
    render(<BrowserPanelHarness initialSession={activeSession} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))
    await waitFor(() => expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('open'))
    const input = screen.getByPlaceholderText('Enter a URL')
    fireEvent.change(input, { target: { value: 'next.example' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_tab_navigate', {
        tabId: 'tab-a',
        url: 'https://next.example',
      })
    })
    vi.mocked(invoke).mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Minimize browser' }))
    await act(async () => {
      resolveNavigate(activeSession)
      await Promise.resolve()
    })

    expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('closed')
    expect(invoke).not.toHaveBeenCalledWith('browser_session_set_visible', { visible: true })
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_create', expect.anything())
  })

  it('CONTRAFACTUAL: closing with no tab creation in flight stays closed and empty', async () => {
    vi.mocked(invoke).mockResolvedValue({ tabs: [], activeTabId: null, visible: false })
    render(<BrowserPanelHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))
    await waitFor(() => {
      expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('open')
      expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: false })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Minimize browser' }))

    expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('closed')
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_create', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('browser_session_set_visible', { visible: true })

    fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))
    expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('open')
    expect(screen.getByText('Type a URL to get started')).toBeVisible()
  })

  it('F3 EFEITO: reopening retains the same native tab without recreating or navigating it', async () => {
    const activeSession = sessionWithTabs('tab-a', 'tab-a')
    vi.mocked(invoke).mockResolvedValue(activeSession)
    render(<BrowserPanelHarness initialSession={activeSession} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'example.com' })).toBeVisible()
      expect(invoke).toHaveBeenCalledWith('browser_session_open', expect.anything())
    })
    expect(screen.getByLabelText('Active browser tab')).toHaveTextContent('tab-a')
    const input = screen.getByPlaceholderText('Enter a URL')
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_tab_navigate', {
        tabId: 'tab-a',
        url: 'https://example.com',
      })
    })
    vi.mocked(invoke).mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Minimize browser' }))

    expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('closed')
    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', {
      tabId: 'tab-a',
      suspended: true,
    })
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_close', expect.anything())
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: false })
    })
    expect(invoke).not.toHaveBeenCalledWith('browser_session_destroy')
    expect(screen.getByRole('tab', { hidden: true, name: 'example.com' })).toBeInTheDocument()

    vi.mocked(invoke).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('open')
      expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: true })
    })
    expect(screen.getByLabelText('Active browser tab')).toHaveTextContent('tab-a')
    expect(screen.getByRole('tab', { name: 'example.com' })).toBeVisible()
    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', { tabId: 'tab-a', suspended: false })
    expect(invoke).not.toHaveBeenCalledWith('browser_session_destroy')
    // browser_session_open may remeasure bounds; Rust does not allocate a tab
    // there. Identity is pinned by no destroy/create/navigation below.
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_create', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_navigate', expect.anything())
  })

  it('F3 TEMPO: a minimized tab is not collected while time passes', async () => {
    vi.useFakeTimers()
    const activeSession = sessionWithTabs('tab-a', 'tab-a')
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'browser_healthcheck') return Promise.reject(new Error('hidden webview did not answer'))
      if (command === 'browser_drain_messages') return Promise.resolve([])
      return Promise.resolve(activeSession)
    })
    render(<BrowserPanelHarness initialSession={activeSession} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))
    await act(async () => { await Promise.resolve() })
    const input = screen.getByPlaceholderText('Enter a URL')
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: 'Minimize browser' }))
    expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('closed')
    vi.mocked(invoke).mockClear()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })

    expect(screen.getByLabelText('Active browser tab')).toHaveTextContent('tab-a')
    expect(invoke).not.toHaveBeenCalledWith('browser_session_destroy')
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_close', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_create', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_navigate', expect.anything())

    fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))
    expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('open')
    expect(screen.getByLabelText('Active browser tab')).toHaveTextContent('tab-a')
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_create', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_navigate', expect.anything())
  })

  it('shows the native webview only after navigating to a URL', async () => {
    const onCreateTab = vi.fn().mockResolvedValue(sessionWithTabs('tab-new', 'tab-new'))
    renderPanel({ onCreateTab })
    const input = screen.getByPlaceholderText('Enter a URL')

    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_tab_navigate', { tabId: 'tab-a', url: 'https://example.com' })
      expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: true })
      expect(onCreateTab).not.toHaveBeenCalled()
    })
  })

  it('opens a detected local preview request without manual URL entry', async () => {
    const onNavigationHandled = vi.fn()
    const onActivateTab = vi.fn()
    const onCreateTab = vi.fn()
    // Active tab is blank → preview routes to navigate the active tab
    renderPanel({
      session: { tabs: [{ id: 'tab-a', label: 'label-a', url: 'about:blank', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 0, recoverableError: null, evicted: false }], activeTabId: 'tab-a', visible: true },
      navigationRequest: { id: 'auto-preview:1', url: 'http://127.0.0.1:8765/' },
      onNavigationHandled, onActivateTab, onCreateTab,
    })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_tab_navigate', { tabId: 'tab-a', url: 'http://127.0.0.1:8765/' })
      expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: true })
      expect(onNavigationHandled).toHaveBeenCalledWith('auto-preview:1')
    })
  })

  it('routes preview to activate an existing tab at the same URL', async () => {
    const onActivateTab = vi.fn()
    const onNavigationHandled = vi.fn()
    renderPanel({
      session: {
        tabs: [
          { id: 'tab-a', label: 'label-a', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 1, recoverableError: null, evicted: false },
          { id: 'tab-b', label: 'label-b', url: 'http://127.0.0.1:8765/', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 1, recoverableError: null, evicted: false },
        ],
        activeTabId: 'tab-a', visible: true,
      },
      navigationRequest: { id: 'auto-preview:2', url: 'http://127.0.0.1:8765/' },
      onNavigationHandled, onActivateTab,
    })

    await waitFor(() => {
      expect(onActivateTab).toHaveBeenCalledWith('tab-b')
      expect(onNavigationHandled).toHaveBeenCalledWith('auto-preview:2')
    })
  })

  it('routes preview to create a new tab when the active tab is occupied', async () => {
    const onCreateTab = vi.fn().mockResolvedValue(sessionWithTabs('tab-new', 'tab-new'))
    const onNavigationHandled = vi.fn()
    renderPanel({
      session: {
        tabs: [{ id: 'tab-a', label: 'label-a', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 1, recoverableError: null, evicted: false }],
        activeTabId: 'tab-a', visible: true,
      },
      navigationRequest: { id: 'auto-preview:3', url: 'http://127.0.0.1:9999/' },
      onNavigationHandled, onCreateTab,
    })

    await waitFor(() => {
      expect(onCreateTab).toHaveBeenCalled()
      expect(onNavigationHandled).toHaveBeenCalledWith('auto-preview:3')
    })
  })

  it('falls back to the recoverable error state when navigation fails', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'browser_tab_navigate') return Promise.reject(new Error('navigation failed'))
      return Promise.resolve({ label: 'test-browser' })
    })
    renderPanel()
    const input = screen.getByPlaceholderText('Enter a URL')

    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Webview unavailable')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Recreate' })).toBeVisible()
    expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: false })
  })

  it('shows recovery when creating the first tab fails', async () => {
    const onCreateTab = vi.fn().mockRejectedValue(new Error('tab creation failed'))
    renderPanel({
      session: { tabs: [], activeTabId: null, visible: false },
      activeTab: undefined,
      onCreateTab,
    })
    const input = screen.getByPlaceholderText('Enter a URL')

    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Webview unavailable')).toBeVisible()
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_navigate', expect.anything())
    expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: false })
  })

  it('shows recovery when navigation of the newly created tab fails', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'browser_tab_navigate') return Promise.reject(new Error('navigation failed'))
      return Promise.resolve({ tabs: [], activeTabId: null, visible: false })
    })
    const onCreateTab = vi.fn().mockResolvedValue(sessionWithTabs('tab-new', 'tab-new'))
    renderPanel({
      session: { tabs: [], activeTabId: null, visible: false },
      activeTab: undefined,
      onCreateTab,
    })
    const input = screen.getByPlaceholderText('Enter a URL')

    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Webview unavailable')).toBeVisible()
    expect(invoke).toHaveBeenCalledWith('browser_tab_navigate', {
      tabId: 'tab-new',
      url: 'https://example.com',
    })
    expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: false })
  })

  it('keeps an invalid URL inside the recoverable browser error state', async () => {
    renderPanel()
    const input = screen.getByPlaceholderText('Enter a URL')

    fireEvent.change(input, { target: { value: 'http://' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Invalid URL')).toBeVisible()
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_navigate', expect.anything())
  })

  it('captures a post-edit result only after the annotated URL reports page-loaded', async () => {
    const messages: string[] = []
    const onReloadSnapshot = vi.fn()
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'browser_drain_messages') return Promise.resolve(messages.splice(0))
      if (command === 'browser_snapshot') {
        return Promise.resolve({ ms: 12, bytes: 1024, path: '/tmp/verboo-browser/result.png' })
      }
      return Promise.resolve({ label: 'test-browser' })
    })
    const localSession = sessionWithTabs('tab-a', 'tab-a')
    Object.assign(localSession.tabs[0], { url: 'http://localhost:5173' })
    renderPanel({
      session: localSession,
      reloadRequest: {
        id: 'turn-1',
        conversationId: 'chat-1',
        url: 'http://localhost:5173',
        targetRect: { x: 10, y: 20, width: 40, height: 30 },
        autoVerify: false,
        verificationPrompt: 'verify',
        tabId: 'tab-a',
        generation: 0,
      },
      onReloadSnapshot,
    })

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_tab_reload', { tabId: 'tab-a' }))
    messages.push(JSON.stringify({
      type: 'page-ready', url: 'http://localhost:5173', historyLength: 1,
    }))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(onReloadSnapshot).not.toHaveBeenCalled()

    messages.push(JSON.stringify({ type: 'page-loaded', url: 'http://localhost:5173' }))
    await waitFor(() => expect(onReloadSnapshot).toHaveBeenCalledTimes(1))
  })

  it('includes tabId and generation in the annotation capture command', async () => {
    // Stale capture discard is tested at the unit level (annotationStillCurrent).
    // Here we verify the identity fields flow through the command.
    const messages: string[] = []
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'browser_drain_messages') {
        const msgs = messages.splice(0)
        return Promise.resolve(msgs.length ? msgs : [])
      }
      if (command === 'browser_capture_annotation') return Promise.resolve({
        cropPath: '/tmp/crop.png', viewportPath: '/tmp/viewport.png',
        cropWidth: 100, cropHeight: 100, viewportWidth: 800, viewportHeight: 600,
        cropBytes: 500, viewportBytes: 2000,
      })
      return Promise.resolve({ label: 'test-browser' })
    })
    renderPanel({ annotationMode: 'pencil' })

    // Push page-ready to set the URL, wait for drain cycle
    messages.push(JSON.stringify({ type: 'page-ready', url: 'https://example.com', historyLength: 1 }))
    await new Promise(resolve => setTimeout(resolve, 200))

    // Push annotation-candidate, wait for drain to pick it up
    messages.push(JSON.stringify({
      type: 'annotation-candidate', token: 'cap-1', kind: 'pen', url: 'https://example.com',
      rect: { x: 10, y: 20, width: 40, height: 30 }, viewport: { width: 800, height: 600 },
    }))
    await new Promise(resolve => setTimeout(resolve, 250))

    expect(invoke).toHaveBeenCalledWith('browser_capture_annotation', expect.objectContaining({
      tabId: 'tab-a',
      generation: 0,
    }))
  })

  it('does not reload a different tab when the post-edit reload targets the source tab', async () => {
    const onReloadHandled = vi.fn()
    const messages: string[] = [
      JSON.stringify({ type: 'page-ready', url: 'http://localhost:5173', historyLength: 1 }),
    ]
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'browser_drain_messages') return Promise.resolve(messages.splice(0))
      return Promise.resolve({ label: 'test-browser' })
    })
    // The page-ready message sets url='http://localhost:5173'.
    // Active tab is tab-b, but reloadRequest targets tab-a → no reload issued.
    renderPanel({
      session: {
        tabs: [
          { id: 'tab-a', label: 'label-a', url: 'http://localhost:5173', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 1, recoverableError: null, evicted: false },
          { id: 'tab-b', label: 'label-b', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 1, recoverableError: null, evicted: false },
        ],
        activeTabId: 'tab-b', visible: true,
      },
      reloadRequest: {
        id: 'turn-2', conversationId: 'chat-1', url: 'http://localhost:5173',
        targetRect: { x: 10, y: 20, width: 40, height: 30 }, autoVerify: false, verificationPrompt: 'verify',
        tabId: 'tab-a', generation: 1,
      },
      onReloadHandled,
    })

    await waitFor(() => expect(onReloadHandled).toHaveBeenCalledWith('turn-2'))
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_reload', expect.anything())
  })

  it('ignores annotation candidates that do not match an active user tool', async () => {
    const messages: string[] = []
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'browser_drain_messages') return Promise.resolve(messages.splice(0))
      return Promise.resolve({ label: 'test-browser' })
    })
    renderPanel()
    const input = screen.getByPlaceholderText('Enter a URL')
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_tab_navigate', { tabId: 'tab-a', url: 'https://example.com' }))

    messages.push(JSON.stringify({
      type: 'annotation-candidate', token: 'forged', kind: 'pen', url: 'https://example.com',
      rect: { x: 10, y: 20, width: 40, height: 30 }, viewport: { width: 800, height: 600 },
    }))
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(invoke).not.toHaveBeenCalledWith('browser_capture_annotation', expect.anything())
  })

  it('offers recovery after the live webview repeatedly fails its health check', async () => {
    vi.useFakeTimers()
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'browser_healthcheck') return Promise.reject(new Error('web content process terminated'))
      if (command === 'browser_drain_messages') return Promise.resolve([])
      return Promise.resolve({ label: 'test-browser' })
    })
    renderPanel()
    const input = screen.getByPlaceholderText('Enter a URL')
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_500)
    })

    expect(screen.getByText('Webview unavailable')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Recreate' })).toBeVisible()
    expect(invoke).toHaveBeenCalledWith('browser_session_destroy')
  })

  it('resynchronizes bounds when the grid transition changes position without resizing', async () => {
    let left = 900
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('browser-content')) {
        return { left, top: 112, width: 520, height: 640 } as DOMRect
      }
      return { left: 0, top: 0, width: 0, height: 0 } as DOMRect
    })

    const { container } = renderPanel()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_session_open', expect.anything()))

    left = 650
    fireEvent.transitionEnd(container.querySelector('.app-layout')!, {
      propertyName: 'grid-template-columns',
    })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_session_open', {
        bounds: { x: 650, y: 112, width: 520, height: 640 },
      })
    })
  })

  it('resizes from the exposed left-edge drag handle', () => {
    const onSetWidth = vi.fn()
    const { container } = renderPanel({ onSetWidth })

    fireEvent.pointerDown(container.querySelector('.browser-resizer')!, { clientX: 700 })
    fireEvent.pointerMove(window, { clientX: 620 })
    fireEvent.pointerUp(window)

    expect(onSetWidth).toHaveBeenCalledWith(760)
  })

  // ── Tab strip tests ──

  it('creates a real tab calling browserApi.createTab', async () => {
    const onCreateTab = vi.fn().mockResolvedValue(sessionWithTabs('tab-new', 'tab-new'))
    renderPanel({ onCreateTab })

    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))

    expect(onCreateTab).toHaveBeenCalled()
  })

  it('closes a tab individually', () => {
    renderPanel({ session: sessionWithTabs('tab-a', 'tab-a', 'tab-b') })
    const closeButton = screen.getByRole('button', { name: 'Close tab example.com' })

    expect(closeButton).toHaveAttribute('data-tooltip', 'Close tab')
    fireEvent.click(closeButton)

    expect(invoke).toHaveBeenCalledWith('browser_tab_close', { tabId: 'tab-a' })
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_set_media_suspended', expect.anything())
  })

  it('returns to the empty browser menu after closing the last tab', async () => {
    const input = await closeActiveTabScenario(false)

    await waitFor(() => {
      expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('open')
      expect(screen.getByLabelText('Active browser tab')).toHaveTextContent('none')
      expect(input).toHaveValue('')
      expect(screen.getByText('Type a URL to get started')).toBeVisible()
    })
  })

  it('keeps the browser populated and activates the remaining tab when closing one of several', async () => {
    const input = await closeActiveTabScenario(true)

    await waitFor(() => {
      expect(screen.getByLabelText('Browser panel state')).toHaveTextContent('open')
      expect(screen.getByLabelText('Active browser tab')).toHaveTextContent('tab-b')
      expect(screen.getByRole('tab', { name: 'example.com' })).toHaveAttribute('aria-selected', 'true')
      expect(input).toHaveValue('https://example.com')
      expect(screen.queryByText('Type a URL to get started')).not.toBeInTheDocument()
    })
  })

  it('shows the active tab URL when the user switches tabs', async () => {
    const input = await switchActiveTabScenario()

    expect(input).toHaveValue('https://docs.example/guide')
    expect(screen.queryByText('Type a URL to get started')).not.toBeInTheDocument()
  })

  it('discards the current URL draft instead of carrying it to another tab', async () => {
    const input = await switchActiveTabScenario('unfinished search')

    expect(input).toHaveValue('https://docs.example/guide')
    expect(input).not.toHaveValue('unfinished search')
  })

  it('discards the URL draft with Escape and restores the active tab URL', () => {
    const session = sessionWithTabs('tab-a', 'tab-a')
    Object.assign(session.tabs[0], { url: 'https://youtube.com/watch?v=one' })
    renderPanel({ session })
    const input = screen.getByPlaceholderText('Enter a URL')
    fireEvent.change(input, { target: { value: 'unfinished search' } })

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input).toHaveValue('https://youtube.com/watch?v=one')
  })

  it('renders the accessible tab strip with correct ARIA roles', () => {
    renderPanel({ session: sessionWithTabs('tab-a', 'tab-a', 'tab-b') })

    const tablist = screen.getByRole('tablist')
    expect(tablist).toBeInTheDocument()
    expect(tablist).toHaveAttribute('aria-label', 'Browser tabs')

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
  })

  it('declares an evicted tab before the user clicks it', () => {
    const session = sessionWithTabs('tab-a', 'tab-a', 'tab-b')
    Object.assign(session.tabs[1], {
      url: 'https://research.example/report',
      title: 'Research report',
      evicted: true,
    })
    const onActivateTab = vi.fn()
    const { container } = renderPanel({ session, onActivateTab })

    const evictedTab = screen.getByRole('tab', { name: /Research report/ })

    expect(evictedTab.closest('.browser-tab-shell')).toHaveClass('evicted')
    expect(container.querySelector('.browser-tab-evicted-marker')).toBeVisible()
    expect(evictedTab).toHaveAttribute(
      'data-tooltip',
      'Unloaded to free memory. Live tabs resume exactly where you left them; this tab reloads when opened.',
    )
    expect(onActivateTab).not.toHaveBeenCalled()
  })

  it('does not mark the same tab when the snapshot says it is still live', () => {
    const session = sessionWithTabs('tab-a', 'tab-a', 'tab-b')
    Object.assign(session.tabs[1], {
      url: 'https://research.example/report',
      title: 'Research report',
      evicted: false,
    })
    const { container } = renderPanel({ session })

    const liveTab = screen.getByRole('tab', { name: 'Research report' })

    expect(liveTab.closest('.browser-tab-shell')).not.toHaveClass('evicted')
    expect(container.querySelector('.browser-tab-evicted-marker')).not.toBeInTheDocument()
    expect(liveTab).not.toHaveAttribute('data-tooltip')
  })

  it('reactivates an evicted tab without losing its id, title, or URL entry', async () => {
    const initial = sessionWithTabs('tab-a', 'tab-a', 'tab-b')
    Object.assign(initial.tabs[1], {
      url: 'https://research.example/report',
      title: 'Research report',
      evicted: true,
    })
    const reactivated: BrowserSessionSnapshot = {
      ...initial,
      tabs: initial.tabs.map(tab => tab.id === 'tab-b' ? { ...tab, evicted: false } : tab),
      activeTabId: 'tab-b',
    }
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'browser_tab_reactivate') return Promise.resolve(reactivated)
      if (command === 'browser_drain_messages') return Promise.resolve([])
      return Promise.resolve(initial)
    })
    render(<BrowserPanelHarness initialSession={initial} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open browser harness' }))

    const evictedTab = await screen.findByRole('tab', { name: /Research report/ })
    expect(evictedTab.closest('.browser-tab-shell')).toHaveClass('evicted')
    fireEvent.click(evictedTab)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_tab_reactivate', { tabId: 'tab-b' })
      expect(screen.getByLabelText('Active browser tab')).toHaveTextContent('tab-b')
    })
    expect(screen.getByLabelText('Active browser title')).toHaveTextContent('Research report')
    expect(screen.getByLabelText('Active browser URL')).toHaveTextContent('https://research.example/report')
    expect(screen.getByRole('tab', { name: 'Research report' }).closest('.browser-tab-shell')).not.toHaveClass('evicted')
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_create', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_navigate', expect.anything())
  })
})

// T4 (field report: "I have no idea what that little cursor does") — the
// toolbar must be self-explaining: EVERY control carries a tooltip (title)
// and a non-empty aria-label. This is a SWEEP, not a per-item pin: a new
// button added without its labels fails here automatically.
describe('BrowserPanel toolbar — tooltip coverage sweep (T4)', () => {
  it('every tab-bar and toolbar control exposes a tooltip AND a non-empty aria-label', () => {
    renderPanel()
    const regions = [document.querySelector('.browser-tabs'), document.querySelector('.browser-toolbar')]
    const buttons = regions.flatMap(region => [...(region?.querySelectorAll('button') ?? [])])
    // tab, tab-close, new-tab, minimize + back, forward, reload, pencil, arrow.
    expect(buttons.length).toBeGreaterThanOrEqual(9)
    for (const button of buttons) {
      const label = button.getAttribute('aria-label')?.trim()
      expect(label, `a toolbar button (${button.className}) must expose an aria-label`).toBeTruthy()
      expect(button.getAttribute('title')?.trim(), `button "${label}" (${button.className}) must carry a tooltip`).toBeTruthy()
    }
    // The URL editor is a labelled field too — not a mystery box.
    const urlInput = document.querySelector('.browser-url-input')
    expect(urlInput?.getAttribute('aria-label')?.trim()).toBeTruthy()
    expect(urlInput?.getAttribute('title')?.trim()).toBeTruthy()
  })

  it('labels come from the dictionary in pt-BR as well (parity)', () => {
    render(
      <I18nProvider language="pt-BR">
        <div className="app-layout">
          <BrowserPanel
            browserOpen
            browserWidth={680}
            annotationMode="idle"
            onSetWidth={() => {}}
            onClose={() => {}}
            onTogglePencil={() => {}}
            onToggleArrow={() => {}}
            onAddAnnotation={() => {}}
            onNavigationHandled={() => {}}
            onReloadSnapshot={() => {}}
            onReloadHandled={() => {}}
            minWidth={520}
            maxWidth={864}
            session={sessionWithTabs('tab-a', 'tab-a')}
            activeTab={sessionWithTabs('tab-a', 'tab-a').tabs[0]}
            onCreateTab={() => Promise.resolve(sessionWithTabs('tab-a', 'tab-a'))}
            onActivateTab={() => {}}
            onNavigateTab={() => Promise.resolve(sessionWithTabs('tab-a', 'tab-a'))}
            onCloseTab={() => {}}
          />
        </div>
      </I18nProvider>,
    )
    const toolbar = document.querySelector('.browser-toolbar')!
    const arrow = [...toolbar.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Selecionar elemento')
    expect(arrow, 'element-picker button must carry the pt-BR label').toBeTruthy()
    expect(arrow?.getAttribute('title')).toBe('Selecionar elemento')
  })
})
