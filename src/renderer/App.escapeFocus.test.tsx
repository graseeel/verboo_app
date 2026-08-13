import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Annotation, UserSettings } from '../shared/types'
import { App } from './App'
import { CHAT_STORE_KEY, createConversation } from './state/chatStore'

vi.mock('./features/composer/Composer', () => ({
  Composer: ({ onSubmit }: { onSubmit: (message: string) => void }) => (
    <button type="button" onClick={() => { void onSubmit('Start a turn') }}>Start a turn</button>
  ),
}))

vi.mock('./features/models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./features/terminal/LocalTerminalPanel', () => ({ LocalTerminalPanel: () => null }))
vi.mock('./features/annotations/AnnotationLayer', () => ({
  AnnotationLayer: ({ onAskInSideChat }: { onAskInSideChat?: (annotation: Annotation) => void }) => (
    <button
      type="button"
      onClick={() => onAskInSideChat?.({
        id: 'annotation:side-chat',
        segmentId: 'segment:1',
        quote: 'Selected excerpt',
        prefix: '',
        suffix: '',
        occurrenceIndex: 0,
        comment: null,
        createdAt: 1,
      })}
    >
      Open side chat
    </button>
  ),
}))

const userSettings: UserSettings = {
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
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createBridge() {
  const unsubscribe = () => {}
  const interrupt = vi.fn(async () => true)
  const sendTurn = vi.fn(async (request: { turnId?: string }) => request.turnId ?? 'turn:test')
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
      extension: 'managed', bridge: 'managed', mcp: 'managed', connection: 'waitingForChrome',
      panelState: 'notApplicable', aggregate: 'ready', installedVersion: '0.5.2', availableVersion: '0.5.2',
      canConfigure: false, canRepair: false, canRemove: false, storeUrlAvailable: false,
      developmentBuild: false, extensionIdSource: 'release',
    })),
    getVideoComponentState: vi.fn(async () => ({ asrModel: 'absent' })),
    onVideoTranscriberProgress: vi.fn(() => unsubscribe),
    getWorkspaceChanges: vi.fn(async () => undefined),
    sendTurn,
    interrupt,
  }

  return {
    interrupt,
    bridge: new Proxy(bridge as Record<PropertyKey, unknown>, {
      get(target, property) {
        if (property in target) return target[property]
        return vi.fn(async () => undefined)
      },
    }),
  }
}

function seedConversations() {
  const oldConversation = {
    ...createConversation(),
    id: 'chat:old',
    title: 'Old running chat',
    createdAt: 10,
    updatedAt: 20,
    lastTurnEndedAt: 20,
    items: [
      { id: 'message:old', role: 'user' as const, text: 'Existing message', timestamp: 10 },
    ],
  }
  const nextConversation = {
    ...createConversation(),
    id: 'chat:new',
    title: 'New selected chat',
    createdAt: 9,
    updatedAt: 10,
    lastTurnEndedAt: 10,
  }
  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({
    version: 3,
    projects: [],
    conversations: [oldConversation, nextConversation],
  }))
}

function pressEscapeTwice() {
  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.keyDown(window, { key: 'Escape' })
}

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('requestAnimationFrame', () => 1)
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
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App Escape focus ownership', () => {
  it('does not interrupt the previously focused running chat after selecting another sidebar chat', async () => {
    seedConversations()
    const { bridge, interrupt } = createBridge()
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Start a turn' }))
    await waitFor(() => expect(document.querySelector('.conversation-row.running')).not.toBeNull())
    fireEvent.pointerDown(document.querySelector('.workspace')!)

    fireEvent.click(screen.getByRole('button', { name: /New selected chat/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /New selected chat/ }).closest('.conversation-row')).toHaveClass('active'))

    pressEscapeTwice()

    expect(interrupt).not.toHaveBeenCalledWith('chat:old')
  })

  it('does not target a closed side chat after its focused running turn is discarded', async () => {
    seedConversations()
    const { bridge, interrupt } = createBridge()
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open side chat' }))
    const sidePanel = await screen.findByLabelText('Side chat')
    const sideQuestion = within(sidePanel).getByRole('textbox', { name: 'Side-chat question' })
    fireEvent.change(sideQuestion, { target: { value: 'Run side chat' } })
    fireEvent.keyDown(sideQuestion, { key: 'Enter' })
    await waitFor(() => expect(sideQuestion).toBeDisabled())
    fireEvent.pointerDown(sidePanel)

    window.localStorage.setItem('verboo:side-chat-skip-close-confirmation', '1')
    fireEvent.click(within(sidePanel).getByRole('button', { name: 'Close side chat' }))
    await waitFor(() => expect(screen.queryByLabelText('Side chat')).not.toBeInTheDocument())
    expect(interrupt).toHaveBeenCalledTimes(1)

    pressEscapeTwice()

    expect(interrupt).toHaveBeenCalledTimes(1)
  })
})
