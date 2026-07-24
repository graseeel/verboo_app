import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { I18nProvider } from '../../i18n'
import { BrowserPanel } from './BrowserPanel'
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
      loading: false, generation: 0, recoverableError: null,
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
  onCreateTab = vi.fn(() => invoke('browser_tab_create', { url: undefined })),
  onActivateTab = vi.fn(),
  onCloseTab = vi.fn((id: string) => invoke('browser_tab_close', { tabId: id })),
  onReloadHandled = vi.fn(),
  onUrlChange = vi.fn(),
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
  onCreateTab?: () => void
  onActivateTab?: (id: string) => void
  onCloseTab?: (id: string) => void
  onReloadHandled?: (id: string) => void
  onUrlChange?: (url: string) => void
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
          onUrlChange={onUrlChange}
          onReloadSnapshot={onReloadSnapshot}
          onReloadHandled={onReloadHandled}
          minWidth={520}
          maxWidth={864}
          session={session}
          activeTab={activeTab}
          onCreateTab={onCreateTab}
          onActivateTab={onActivateTab}
          onCloseTab={onCloseTab}
        />
      </div>
    </I18nProvider>,
  )
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
    renderPanel()

    expect(screen.getByText('Type a URL to get started')).toBeVisible()
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: false })
    })
  })

  it('shows the native webview only after navigating to a URL', async () => {
    renderPanel()
    const input = screen.getByPlaceholderText('Enter a URL')

    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_tab_navigate', { tabId: 'tab-a', url: 'https://example.com' })
      expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: true })
    })
  })

  it('opens a detected local preview request without manual URL entry', async () => {
    const onNavigationHandled = vi.fn()
    const onActivateTab = vi.fn()
    const onCreateTab = vi.fn()
    // Active tab is blank → preview routes to navigate the active tab
    renderPanel({
      session: { tabs: [{ id: 'tab-a', label: 'label-a', url: 'about:blank', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 0, recoverableError: null }], activeTabId: 'tab-a', visible: true },
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
          { id: 'tab-a', label: 'label-a', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 1, recoverableError: null },
          { id: 'tab-b', label: 'label-b', url: 'http://127.0.0.1:8765/', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 1, recoverableError: null },
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
    const onCreateTab = vi.fn()
    const onNavigationHandled = vi.fn()
    renderPanel({
      session: {
        tabs: [{ id: 'tab-a', label: 'label-a', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 1, recoverableError: null }],
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
    renderPanel({
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
    const input = screen.getByPlaceholderText('Enter a URL')
    fireEvent.change(input, { target: { value: 'http://localhost:5173' } })
    fireEvent.keyDown(input, { key: 'Enter' })

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
          { id: 'tab-a', label: 'label-a', url: 'http://localhost:5173', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 1, recoverableError: null },
          { id: 'tab-b', label: 'label-b', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 1, recoverableError: null },
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
    const onCreateTab = vi.fn()
    renderPanel({ onCreateTab })

    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))

    expect(onCreateTab).toHaveBeenCalled()
  })

  it('closes a tab individually', () => {
    renderPanel({ session: sessionWithTabs('tab-a', 'tab-a', 'tab-b') })

    fireEvent.click(screen.getByRole('button', { name: 'Close tab example.com' }))

    expect(invoke).toHaveBeenCalledWith('browser_tab_close', { tabId: 'tab-a' })
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
})
