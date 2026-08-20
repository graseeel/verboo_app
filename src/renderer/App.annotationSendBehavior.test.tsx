import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentTurnRequest, Annotation, UserSettings } from '../shared/types'
import { App } from './App'
import { CHAT_STORE_KEY, createConversation } from './state/chatStore'

vi.mock('./features/models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./features/terminal/LocalTerminalPanel', () => ({ LocalTerminalPanel: () => null }))
vi.mock('./features/annotations/AnnotationOverlay', () => ({ AnnotationOverlay: () => null }))
vi.mock('./features/annotations/AnnotationLayer', () => ({
  AnnotationLayer: ({
    onCreate,
    onAskInSideChat,
  }: {
    onCreate: (annotation: Annotation) => void
    onAskInSideChat?: (annotation: Annotation) => void
  }) => (
    <>
      <button
        type="button"
        onClick={() => onCreate({
          id: 'annotation:main',
          segmentId: 'segment:main',
          quote: 'Main excerpt',
          prefix: '',
          suffix: '',
          occurrenceIndex: 0,
          comment: null,
          createdAt: 1,
        })}
      >
        Create main annotation
      </button>
      <button
        type="button"
        onClick={() => onAskInSideChat?.({
          id: 'annotation:side',
          segmentId: 'segment:side',
          quote: 'Side excerpt',
          prefix: '',
          suffix: '',
          occurrenceIndex: 0,
          comment: null,
          createdAt: 2,
        })}
      >
        Open side chat
      </button>
    </>
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

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function createBridge(sendTurnImpl: (request: AgentTurnRequest) => Promise<string>) {
  let onAgentEvent: ((event: AgentEvent) => void) | undefined
  const unsubscribe = () => {}
  const sendTurn = vi.fn(sendTurnImpl)
  const interrupt = vi.fn(async () => true)
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
    onAgentEvent: vi.fn((handler: (event: AgentEvent) => void) => {
      onAgentEvent = handler
      return unsubscribe
    }),
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
    sendTurn,
    interrupt,
    emitAgentEvent(event: AgentEvent) {
      onAgentEvent?.(event)
    },
    bridge: new Proxy(bridge as Record<PropertyKey, unknown>, {
      get(target, property) {
        if (property in target) return target[property]
        return vi.fn(async () => undefined)
      },
    }),
  }
}

function seedConversation() {
  const conversation = {
    ...createConversation(),
    id: 'chat:main',
    title: 'Existing chat',
    createdAt: 10,
    updatedAt: 10,
    lastTurnEndedAt: 10,
    items: [{ id: 'message:existing', role: 'user' as const, text: 'Existing message', timestamp: 10 }],
  }
  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({
    version: 3,
    projects: [],
    conversations: [conversation],
  }))
}

function renderApp(sendTurnImpl: (request: AgentTurnRequest) => Promise<string>) {
  const testBridge = createBridge(sendTurnImpl)
  ;(window as unknown as { verboo: unknown }).verboo = testBridge.bridge
  render(<App />)
  return testBridge
}

async function sendSideChatMessage() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open side chat' }))
  const sidePanel = await screen.findByLabelText('Side chat')
  const question = within(sidePanel).getByRole('textbox', { name: 'Side-chat question' })
  fireEvent.change(question, { target: { value: 'Retry this side chat' } })
  fireEvent.keyDown(question, { key: 'Enter' })
  return sidePanel
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

describe('App annotation send behavior', () => {
  it('gives an open simulator menu Escape priority over an active agent turn', async () => {
    seedConversation()
    const { emitAgentEvent, interrupt, sendTurn } = renderApp(async request => request.turnId ?? 'turn:test')

    fireEvent.click(await screen.findByRole('button', { name: 'Create main annotation' }))
    fireEvent.click(screen.getByTitle('Send'))
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1))
    const turnId = sendTurn.mock.calls[0][0].turnId!
    act(() => { emitAgentEvent({ type: 'started', turnId }) })

    const simulators = await screen.findByRole('button', { name: 'Simulators' })
    fireEvent.click(simulators)
    expect(screen.getByRole('menu', { name: 'Simulators' })).toBeInTheDocument()

    fireEvent.keyDown(simulators, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Simulators' })).not.toBeInTheDocument()
    expect(simulators).toHaveFocus()
    expect(interrupt).not.toHaveBeenCalled()
    expect(screen.queryByText('Press Esc again to stop the current turn.')).not.toBeInTheDocument()

    await act(async () => {})
    fireEvent.keyDown(simulators, { key: 'Escape' })
    expect(interrupt).not.toHaveBeenCalled()
    fireEvent.keyDown(simulators, { key: 'Escape' })
    await waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1))
  })

  it('sends an annotation-only turn and consumes its draft only after the host accepts it', async () => {
    seedConversation()
    const acceptedTurn = deferred<string>()
    const { sendTurn } = renderApp(() => acceptedTurn.promise)

    fireEvent.click(await screen.findByRole('button', { name: 'Create main annotation' }))
    const annotationChip = await screen.findByTitle('Annotations on this chat')
    fireEvent.click(screen.getByTitle('Send'))

    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1))
    const request = sendTurn.mock.calls[0][0]
    expect(request).toMatchObject({
      conversationId: 'chat:main',
      message: '',
      annotations: [expect.objectContaining({ id: 'annotation:main', quote: 'Main excerpt' })],
    })
    expect(annotationChip).toBeInTheDocument()

    await act(async () => {
      acceptedTurn.resolve(request.turnId!)
    })

    await waitFor(() => expect(screen.queryByTitle('Annotations on this chat')).not.toBeInTheDocument())
  })

  it.each([
    {
      name: 'retries a side chat after an incomplete turn',
      events: (turnId: string): AgentEvent[] => [{
        type: 'error',
        turnId,
        message: 'Turn ended before completion',
        payload: {
          category: 'incomplete_turn',
          message: 'Turn ended before completion',
          details: [],
          exitCode: 1,
          recoveryReady: false,
        },
        exitCode: 1,
      }],
    },
    {
      name: 'retries a side chat after terminal completion reports a missing session',
      events: (turnId: string): AgentEvent[] => [
        { type: 'stderr', turnId, text: 'No conversation found with session ID' },
        { type: 'done', turnId, exitCode: 1 },
      ],
    },
  ])('$name without losing its annotation context', async ({ events }) => {
    seedConversation()
    const { emitAgentEvent, sendTurn } = renderApp(async request => request.turnId ?? 'turn:test')
    const sidePanel = await sendSideChatMessage()

    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1))
    const firstRequest = sendTurn.mock.calls[0][0]
    await act(async () => {
      for (const event of events(firstRequest.turnId!)) emitAgentEvent(event)
    })

    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2))
    expect(sendTurn.mock.calls[1][0]).toMatchObject({
      conversationId: firstRequest.conversationId,
      message: 'Retry this side chat',
      annotations: [expect.objectContaining({ id: 'annotation:side', quote: 'Side excerpt' })],
    })
    await waitFor(() => expect(within(sidePanel).queryByText('1. Selected text: "Side excerpt"')).not.toBeInTheDocument())
  })
})
