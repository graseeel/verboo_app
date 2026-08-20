import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { UserSettings } from '../shared/types'
import { App } from './App'
import { CHAT_STORE_KEY, createConversation } from './state/chatStore'
import type { IosSimulatorLifecycleSnapshot } from './features/simulator/iosSimulatorApi'

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn<(
    eventName: string,
    callback: (event: { payload: unknown }) => void,
  ) => Promise<() => void>>(() => Promise.resolve(() => {})),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (eventName: string, callback: (event: { payload: unknown }) => void) =>
    listenMock(eventName, callback),
}))

type ComposerProps = {
  leftToolbar?: ReactNode
}

type PluginsViewProps = {
  onManageChromeIntegration: () => void
}

vi.mock('./features/composer/Composer', () => ({
  Composer: ({ leftToolbar }: ComposerProps) => <div data-testid="composer-stub">{leftToolbar}</div>,
}))

vi.mock('./features/models/ModelSelector', () => ({
  ModelSelector: () => null,
}))

vi.mock('./features/terminal/LocalTerminalPanel', () => ({
  LocalTerminalPanel: () => null,
}))

vi.mock('./features/plugins/PluginsView', () => ({
  PluginsView: ({ onManageChromeIntegration }: PluginsViewProps) => (
    <button type="button" onClick={onManageChromeIntegration}>Manage Chrome integration</button>
  ),
}))

const userSettings = {
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

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let lifecycleForward: ((event: { payload: unknown }) => void) | undefined
let androidOpenForward: ((event: { payload: unknown }) => void) | undefined

function createBridge() {
  const unsubscribe = () => {}
  const bridge = {
    getUserSettings: vi.fn(async () => userSettings),
    getConfig: vi.fn(async () => ({ workingDirectory: '', accessMode: 'approval', platform: 'darwin' })),
    getDefaultWorkingDirectory: vi.fn(async () => ''),
    getCredentialStatus: vi.fn(async () => ({ hasApiKey: true, apiKeyHint: '…1234' })),
    getCliAuthStatus: vi.fn(async () => ({ loggedIn: true, email: 'ada@example.test' })),
    listModels: vi.fn(async () => ({
      models: [{ id: 'model-1', displayName: 'Test model', raw: {} }],
      source: 'api-key',
      stale: false,
    })),
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
    listenForNotificationClick: vi.fn(async () => unsubscribe),
    updateMenuBar: vi.fn(async () => {}),
    heartbeatMenuBar: vi.fn(async () => {}),
    chromeIntegrationStatus: vi.fn(async () => ({
      extension: 'managed',
      bridge: 'managed',
      mcp: 'managed',
      connection: 'waitingForChrome',
      panelState: 'notApplicable',
      aggregate: 'ready',
      installedVersion: '0.5.2',
      availableVersion: '0.5.2',
      canConfigure: false,
      canRepair: false,
      canRemove: false,
      storeUrlAvailable: false,
      developmentBuild: false,
      extensionIdSource: 'release',
    })),
    getVideoComponentState: vi.fn(async () => ({ asrModel: 'absent' })),
    onVideoTranscriberProgress: vi.fn(() => unsubscribe),
  }

  return new Proxy(bridge as Record<PropertyKey, unknown>, {
    get(target, property) {
      if (property in target) return target[property]
      return vi.fn(async () => undefined)
    },
  })
}

function renderApp() {
  render(<App />)
  return screen.findByRole('button', { name: /Ada/ })
}

function seedArchivedChats() {
  const now = Date.now()
  const restore = {
    ...createConversation(),
    id: 'chat:restore',
    title: 'Restore this chat',
    createdAt: now - 4_000,
    updatedAt: now - 4_000,
    lastTurnEndedAt: now - 4_000,
    archivedAt: now - 2_000,
  }
  const remove = {
    ...createConversation(),
    id: 'chat:remove',
    title: 'Delete this chat',
    createdAt: now - 3_000,
    updatedAt: now - 3_000,
    lastTurnEndedAt: now - 3_000,
    archivedAt: now - 1_000,
  }

  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({
    version: 3,
    projects: [],
    conversations: [restore, remove],
  }))
}

beforeEach(() => {
  window.localStorage.clear()
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
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
  lifecycleForward = undefined
  androidOpenForward = undefined
  listenMock.mockImplementation((eventName, callback) => {
    if (eventName === 'ios-simulator:lifecycle') lifecycleForward = callback
    if (eventName === 'android-emulator:open-requested') androidOpenForward = callback
    return Promise.resolve(() => {})
  })
  ;(window as unknown as { verboo: unknown }).verboo = createBridge()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('App settings shortcuts', () => {
  it('opens the simulator on the Android tab when the Android agent requests it', async () => {
    await renderApp()
    await waitFor(() => expect(androidOpenForward).toBeDefined())

    act(() => androidOpenForward?.({ payload: null }))

    const topbar = screen.getAllByRole('banner').find(element => element.classList.contains('topbar'))
    expect(topbar).toBeDefined()
    if (!topbar) throw new Error('TopBar was not rendered')
    await waitFor(() => {
      expect(within(topbar).getByRole('button', { name: 'Simulators' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByRole('tab', { name: 'Android' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('complementary', { name: 'Android emulator' })).toBeInTheDocument()
    })
  })

  it('opens the panel on the platform selected from the real TopBar menu', async () => {
    await renderApp()
    const topbar = screen.getAllByRole('banner').find(element => element.classList.contains('topbar'))
    expect(topbar).toBeDefined()
    if (!topbar) throw new Error('TopBar was not rendered')

    fireEvent.click(within(topbar).getByRole('button', { name: 'Simulators' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Android Emulator' }))
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Android' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('complementary', { name: 'Android emulator' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Hide simulator' }))
    fireEvent.click(within(topbar).getByRole('button', { name: 'Simulators' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'iOS Simulator' }))
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'iOS' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('complementary', { name: 'iOS simulator' })).toBeInTheDocument()
    })
  })

  it('restores the simulator and carries a hidden-panel lifecycle event into TopBar', async () => {
    const avatar = await renderApp()
    const topbar = screen.getAllByRole('banner').find(element => element.classList.contains('topbar'))
    expect(topbar).toBeDefined()
    if (!topbar) throw new Error('TopBar was not rendered')
    fireEvent.click(await within(topbar).findByRole('button', { name: 'Simulators' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'iOS Simulator' }))
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'iOS simulator' })).toBeInTheDocument())

    fireEvent.click(avatar)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByRole('heading', { name: 'Security', level: 1 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }))
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'iOS simulator' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Hide simulator' }))
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'iOS simulator' })).toHaveClass('is-hidden'))
    await waitFor(() => expect(lifecycleForward).toBeDefined())

    const lifecycle: IosSimulatorLifecycleSnapshot = {
      udid: 'phone-17-pro',
      deviceGeneration: 1,
      stage: 'ready',
      ownership: 'verboo',
      previewSuspended: true,
      interactionReady: true,
      recording: { state: 'recording', startedAtMs: Date.now() - 1_000 },
      recoverableError: null,
    }
    act(() => lifecycleForward?.({ payload: lifecycle }))

    expect(screen.getByLabelText('Screen recording in progress')).toBeInTheDocument()
  })

  it('routes the avatar Settings shortcut to Security', async () => {
    fireEvent.click(await renderApp())
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    expect(await screen.findByRole('heading', { name: 'Security', level: 1 })).toBeInTheDocument()
  })

  it('routes the locked Free mode shortcut to Security', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Ask for approval' }))
    fireEvent.click(screen.getByRole('button', { name: /^Free mode/ }))

    expect(await screen.findByRole('heading', { name: 'Security', level: 1 })).toBeInTheDocument()
  })

  it('routes Chrome management to Integrations', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Chrome integration' }))

    expect(await screen.findByRole('heading', { name: 'Integrations', level: 1 })).toBeInTheDocument()
  })

  it('does not expose a separate Profile route in the avatar menu', async () => {
    fireEvent.click(await renderApp())

    expect(screen.queryByRole('button', { name: 'Profile' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })

  it('keeps archived chats in the sidebar, where restore and deletion update the real chat store', async () => {
    seedArchivedChats()
    await renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Archived chats · 2' }))
    const archivedList = screen.getByRole('list', { name: 'Archived chats' })
    expect(within(archivedList).getByText('Restore this chat')).toBeInTheDocument()
    expect(within(archivedList).getByText('Delete this chat')).toBeInTheDocument()

    const restoreRow = within(archivedList).getByText('Restore this chat').closest('li')!
    fireEvent.click(within(restoreRow).getByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Archived chats · 1' })).toBeInTheDocument())
    expect(screen.getByText('Restore this chat').closest('.conversation-row')).not.toBeNull()

    const deleteRow = screen.getByText('Delete this chat').closest('li')!
    fireEvent.click(within(deleteRow).getByRole('button', { name: 'Delete' }))
    const confirmDialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(screen.queryByText('Delete this chat')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Archived chats/ })).not.toBeInTheDocument()
    })
  })

  it('does not render the archived sidebar entry when there are no archived chats', async () => {
    await renderApp()

    expect(screen.queryByRole('button', { name: /Archived chats/ })).not.toBeInTheDocument()
  })
})
