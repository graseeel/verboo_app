import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { UserSettings, VerbooModel } from '../shared/types'
import { CHAT_STORE_KEY } from './state/chatStore'
import { App } from './App'

vi.mock('./features/models/ModelIcon', () => ({ ModelIcon: () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

vi.mock('./features/composer/Composer', () => ({
  Composer: ({ leftToolbar, rightToolbar }: { leftToolbar?: ReactNode; rightToolbar?: ReactNode }) => (
    <div data-testid="composer-stub">{leftToolbar}{rightToolbar}</div>
  ),
}))

vi.mock('./features/terminal/LocalTerminalPanel', () => ({ LocalTerminalPanel: () => null }))
vi.mock('./features/plugins/PluginsView', () => ({ PluginsView: () => null }))

const model: VerbooModel = {
  id: 'glm-5.2',
  displayName: 'Ultra',
  contextWindow: 200000,
  supportsVision: false,
  raw: {},
}

const settings: UserSettings = {
  language: 'en-US',
  theme: 'system',
  defaultAccessMode: 'approval',
  fullAccessEnabled: false,
  showInMenuBar: true,
  showMenuBarText: true,
  staySignedIn: true,
  preventSleepWhileRunning: true,
  completionNotifications: 'background',
  permissionNotifications: true,
  questionNotifications: true,
  responseEnhancementsEnabled: true,
  personality: 'pragmatic',
  customInstructions: '',
  trustedCommands: [],
  customSlashCommands: [],
  memoriesEnabled: true,
  chroniclePreview: true,
  ignoreToolChatsForMemory: true,
  goalMode: { enabled: true, maxTurns: 4, maxElapsedMinutes: 10, allowAutoAccess: false },
  updates: { channel: 'stable', autoCheck: true, autoDownload: false },
  visionFallbackConsent: 'ask',
  videoFallbackConsent: 'ask',
  trustedSkills: [],
  includeVerbooCoAuthor: false,
  browserVerificationEnabled: true,
  loadWebIcons: true,
} as UserSettings

function seedConversation() {
  const now = Date.now()
  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({
    version: 4,
    projects: [],
    conversations: [{
      id: 'chat:media',
      title: 'Media preview',
      items: [{
        id: 'user:media',
        role: 'user',
        text: 'Veja estas mídias',
        timestamp: now,
        attachments: [
          { path: '/photos/reference.png', name: 'reference.png', size: 2048, kind: 'image', mediaType: 'image/png' },
          { path: '/videos/demo.mp4', name: 'demo.mp4', size: 4096, kind: 'video', mediaType: 'video/mp4' },
        ],
      }],
      subagents: [],
      createdAt: now,
      updatedAt: now,
      lastTurnEndedAt: now,
    }],
  }))
}

function createBridge() {
  const unsubscribe = () => {}
  const bridge = {
    getUserSettings: vi.fn(async () => settings),
    updateUserSettings: vi.fn(async () => settings),
    getConfig: vi.fn(async () => ({ workingDirectory: '', accessMode: 'approval', platform: 'darwin' })),
    getDefaultWorkingDirectory: vi.fn(async () => ''),
    getCredentialStatus: vi.fn(async () => ({ hasApiKey: true, apiKeyHint: '…1234' })),
    getCliAuthStatus: vi.fn(async () => ({ loggedIn: true, email: 'ada@example.test' })),
    listModels: vi.fn(async () => ({ models: [model], source: 'cli', stale: false })),
    getProfile: vi.fn(async () => ({
      status: 'ready',
      user: { name: 'Ada' },
      summary: { totalTokens: 1, tokensInTotal: 1, tokensOutTotal: 0, reqTotal: 1 },
      plan: { name: 'Pro', status: 'active' },
    })),
    pluginList: vi.fn(async () => []),
    pluginSkills: vi.fn(async () => []),
    getUpdateStatus: vi.fn(async () => undefined),
    onAgentEvent: vi.fn(() => unsubscribe),
    onVideoOcrRequest: vi.fn(() => unsubscribe),
    onUpdateStatus: vi.fn(() => unsubscribe),
    onRefreshDataRequest: vi.fn(() => unsubscribe),
    onTerminalData: vi.fn(() => unsubscribe),
    onTerminalExit: vi.fn(() => unsubscribe),
    onProviderLoginEvent: vi.fn(() => unsubscribe),
    listenForNotificationClick: vi.fn(async () => unsubscribe),
    updateMenuBar: vi.fn(async () => {}),
    heartbeatMenuBar: vi.fn(async () => {}),
    providerAuthStatus: vi.fn(async () => []),
    allowMediaPreviewFile: vi.fn(async (path: string) => path),
    fileUrl: (path: string) => `asset://localhost${path}`,
    openExternalFile: vi.fn(async () => {}),
  }

  return new Proxy(bridge as Record<PropertyKey, unknown>, {
    get(target, property) {
      if (property in target) return target[property]
      return vi.fn(async () => undefined)
    },
  })
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  window.localStorage.clear()
  seedConversation()
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  ;(window as unknown as { verboo: unknown }).verboo = createBridge()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

async function renderApp() {
  render(<App />)
  await screen.findByRole('button', { name: /Ada/ })
  await screen.findByRole('button', { name: 'Preview reference.png' })
}

describe('App transcript media preview', () => {
  it('stages entry and keeps the preview mounted through its exit transition', async () => {
    await renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Preview reference.png' }))

    const mountedPanel = document.querySelector('.media-preview-panel')
    expect(mountedPanel).toHaveAttribute('data-open', 'false')
    expect(mountedPanel).toHaveAttribute('inert')
    await waitFor(() => expect(mountedPanel).toHaveAttribute('data-open', 'true'))
    expect(mountedPanel).not.toHaveAttribute('inert')

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(document.querySelector('.media-preview-panel')).toHaveAttribute('data-open', 'false')
    expect(document.querySelector('.media-preview-panel')).toHaveAttribute('inert')
    await waitFor(
      () => expect(document.querySelector('.media-preview-panel')).toBeNull(),
      { timeout: 800 },
    )
  })

  it('opens an image in the shared right lane without adding a TopBar action', async () => {
    await renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Preview reference.png' }))

    const panel = await screen.findByRole('region', { name: 'Media preview' })
    expect(within(panel).getByRole('img', { name: 'reference.png' })).toHaveAttribute(
      'src',
      'asset://localhost/photos/reference.png',
    )
    const topbar = document.querySelector('.topbar') as HTMLElement
    expect(within(topbar).queryByRole('button', { name: /media preview/i })).toBeNull()
  })

  it('closes immediately when the operating system requests reduced motion', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Preview reference.png' }))
    await screen.findByRole('region', { name: 'Media preview' })
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))

    expect(document.querySelector('.media-preview-panel')).toBeNull()
  })

  it('replaces the image with a video, closes explicitly, and yields the lane to browser', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Preview reference.png' }))
    await screen.findByRole('region', { name: 'Media preview' })

    fireEvent.click(screen.getByRole('button', { name: 'Preview demo.mp4' }))
    const panel = screen.getByRole('region', { name: 'Media preview' })
    const renderedVideo = await within(panel).findByLabelText('demo.mp4')
    expect(renderedVideo.tagName).toBe('VIDEO')
    expect(renderedVideo).toHaveAttribute('src', 'asset://localhost/videos/demo.mp4')
    expect((renderedVideo as HTMLVideoElement).autoplay).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }))
    expect(document.querySelector('.media-preview-panel')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Preview reference.png' }))
    await screen.findByRole('region', { name: 'Media preview' })
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(screen.queryByRole('region', { name: 'Media preview' })).toBeNull()
  })
})
