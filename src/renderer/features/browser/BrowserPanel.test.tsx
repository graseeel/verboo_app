import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { I18nProvider } from '../../i18n'
import { BrowserPanel } from './BrowserPanel'
import type { AnnotationMode, BrowserNavigationRequest, BrowserReloadRequest } from './useBrowserPanel'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ label: 'test-browser' }),
  convertFileSrc: vi.fn((path: string) => path),
}))

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

function renderPanel(
  onSetWidth = vi.fn(),
  reloadRequest?: BrowserReloadRequest,
  onReloadSnapshot = vi.fn(),
  annotationMode: AnnotationMode = 'idle',
  navigationRequest?: BrowserNavigationRequest,
  onNavigationHandled = vi.fn(),
) {
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
          onAddAnnotation={() => {}}
          navigationRequest={navigationRequest}
          onNavigationHandled={onNavigationHandled}
          onUrlChange={() => {}}
          reloadRequest={reloadRequest}
          onReloadSnapshot={onReloadSnapshot}
          onReloadHandled={() => {}}
          minWidth={520}
          maxWidth={864}
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
      expect(invoke).toHaveBeenCalledWith('browser_set_visible', { visible: false })
    })
  })

  it('shows the native webview only after navigating to a URL', async () => {
    renderPanel()
    const input = screen.getByPlaceholderText('Enter a URL')

    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_navigate', { url: 'https://example.com' })
      expect(invoke).toHaveBeenCalledWith('browser_set_visible', { visible: true })
    })
  })

  it('opens a detected local preview request without manual URL entry', async () => {
    const onNavigationHandled = vi.fn()
    renderPanel(vi.fn(), undefined, vi.fn(), 'idle', {
      id: 'auto-preview:1',
      url: 'http://127.0.0.1:8765/',
    }, onNavigationHandled)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_navigate', { url: 'http://127.0.0.1:8765/' })
      expect(invoke).toHaveBeenCalledWith('browser_set_visible', { visible: true })
      expect(onNavigationHandled).toHaveBeenCalledWith('auto-preview:1')
    })
  })

  it('falls back to the recoverable error state when navigation fails', async () => {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'browser_navigate') return Promise.reject(new Error('navigation failed'))
      return Promise.resolve({ label: 'test-browser' })
    })
    renderPanel()
    const input = screen.getByPlaceholderText('Enter a URL')

    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Webview unavailable')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Recreate' })).toBeVisible()
    expect(invoke).toHaveBeenCalledWith('browser_set_visible', { visible: false })
  })

  it('keeps an invalid URL inside the recoverable browser error state', async () => {
    renderPanel()
    const input = screen.getByPlaceholderText('Enter a URL')

    fireEvent.change(input, { target: { value: 'http://' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Invalid URL')).toBeVisible()
    expect(invoke).not.toHaveBeenCalledWith('browser_navigate', expect.anything())
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
    renderPanel(vi.fn(), {
      id: 'turn-1',
      conversationId: 'chat-1',
      url: 'http://localhost:5173',
      targetRect: { x: 10, y: 20, width: 40, height: 30 },
      autoVerify: false,
      verificationPrompt: 'verify',
    }, onReloadSnapshot)
    const input = screen.getByPlaceholderText('Enter a URL')
    fireEvent.change(input, { target: { value: 'http://localhost:5173' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_reload'))
    messages.push(JSON.stringify({
      type: 'page-ready', url: 'http://localhost:5173', historyLength: 1,
    }))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(onReloadSnapshot).not.toHaveBeenCalled()

    messages.push(JSON.stringify({ type: 'page-loaded', url: 'http://localhost:5173' }))
    await waitFor(() => expect(onReloadSnapshot).toHaveBeenCalledTimes(1))
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
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_navigate', { url: 'https://example.com' }))

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
    expect(invoke).toHaveBeenCalledWith('browser_destroy')
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
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_create', expect.anything()))

    left = 650
    fireEvent.transitionEnd(container.querySelector('.app-layout')!, {
      propertyName: 'grid-template-columns',
    })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('browser_set_bounds', {
        bounds: { x: 650, y: 112, width: 520, height: 640 },
      })
    })
  })

  it('resizes from the exposed left-edge drag handle', () => {
    const onSetWidth = vi.fn()
    const { container } = renderPanel(onSetWidth)

    fireEvent.pointerDown(container.querySelector('.browser-resizer')!, { clientX: 700 })
    fireEvent.pointerMove(window, { clientX: 620 })
    fireEvent.pointerUp(window)

    expect(onSetWidth).toHaveBeenCalledWith(760)
  })
})
