import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentEvent, Annotation, UserSettings } from '../shared/types'
import { ToastProvider } from './components/Toast'
import { App } from './App'
import { CHAT_STORE_KEY, createConversation } from './state/chatStore'

vi.mock('./features/composer/Composer', () => ({
  Composer: ({
    busy,
    onSubmit,
    onStop,
  }: {
    busy?: boolean
    onSubmit: (message: string) => void
    onStop?: () => void
  }) => (
    <div>
      <button type="button" onClick={() => { void onSubmit(busy ? 'Queued follow-up' : 'Start a turn') }}>
        {busy ? 'Queue main' : 'Send main'}
      </button>
      {busy && <button type="button" onClick={onStop}>Stop main</button>}
    </div>
  ),
}))

vi.mock('./features/models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./features/terminal/LocalTerminalPanel', () => ({ LocalTerminalPanel: () => null }))
vi.mock('./features/annotations/AnnotationLayer', () => ({
  AnnotationLayer: ({ onAskInSideChat }: { onAskInSideChat?: (annotation: Annotation) => void }) => (
    <button
      type="button"
      onClick={() => onAskInSideChat?.({
        id: 'annotation:stop-side-chat',
        segmentId: 'segment:stop',
        quote: 'Selected excerpt',
        prefix: '',
        suffix: '',
        occurrenceIndex: 0,
        comment: null,
        createdAt: 1,
      })}
    >
      Open stop side chat
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function createBridge(interruptImpl: () => Promise<boolean> = async () => true) {
  let onAgentEvent: ((event: AgentEvent) => void) | undefined
  const unsubscribe = () => {}
  const interrupt = vi.fn(interruptImpl)
  const sendTurn = vi.fn(async (request: { turnId?: string; conversationId?: string }) => request.turnId ?? 'turn:test')
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
    onAgentEvent: vi.fn((listener: (event: AgentEvent) => void) => {
      onAgentEvent = listener
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
    interrupt,
    sendTurn,
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
    id: 'chat:stop-button',
    title: 'Stop button chat',
    createdAt: 10,
    updatedAt: 20,
    lastTurnEndedAt: 20,
    items: [{ id: 'message:seed', role: 'user' as const, text: 'Existing message', timestamp: 10 }],
  }
  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({
    version: 3,
    projects: [],
    conversations: [conversation],
  }))
}

function renderApp(interruptImpl?: () => Promise<boolean>) {
  const host = createBridge(interruptImpl)
  ;(window as unknown as { verboo: unknown }).verboo = host.bridge
  render(<ToastProvider><App /></ToastProvider>)
  return host
}

async function startMainTurn(host: ReturnType<typeof createBridge>) {
  fireEvent.click(await screen.findByRole('button', { name: 'Send main' }))
  await waitFor(() => expect(host.sendTurn).toHaveBeenCalledTimes(1))
  await act(async () => {})
  const turnId = host.sendTurn.mock.calls[0][0].turnId!
  expect(await screen.findByRole('button', { name: 'Stop main' })).toBeInTheDocument()
  return turnId
}

beforeEach(() => {
  window.localStorage.clear()
  seedConversation()
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('App stop-button turn ownership', () => {
  it('keeps the stop control through the transient idle frame after the captured turn ends', async () => {
    const host = renderApp()
    const turnId = await startMainTurn(host)

    fireEvent.click(screen.getByRole('button', { name: 'Stop main' }))
    await waitFor(() => expect(host.interrupt).toHaveBeenCalledTimes(1))
    act(() => host.emitAgentEvent({ type: 'done', turnId, conversationId: 'chat:stop-button', exitCode: 0 }))

    expect(screen.getByRole('button', { name: 'Stop main' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send main' })).not.toBeInTheDocument()
  })

  it('does not let a second click interrupt the same turn twice', async () => {
    const pendingInterrupt = deferred<boolean>()
    const host = renderApp(() => pendingInterrupt.promise)
    await startMainTurn(host)

    fireEvent.click(screen.getByRole('button', { name: 'Stop main' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop main' }))

    expect(host.interrupt).toHaveBeenCalledTimes(1)
    pendingInterrupt.resolve(true)
    await act(async () => {})
  })

  it('re-arms stop for the queued turn that starts while the previous turn lock is active', async () => {
    const firstInterrupt = deferred<boolean>()
    let interruptCount = 0
    const host = renderApp(() => {
      interruptCount += 1
      return interruptCount === 1 ? firstInterrupt.promise : Promise.resolve(true)
    })
    const firstTurnId = await startMainTurn(host)

    fireEvent.click(screen.getByRole('button', { name: 'Queue main' }))
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Stop main' }))
    await waitFor(() => expect(host.interrupt).toHaveBeenCalledTimes(1))

    act(() => host.emitAgentEvent({ type: 'done', turnId: firstTurnId, conversationId: 'chat:stop-button', exitCode: 0 }))
    await waitFor(() => expect(host.sendTurn).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Stop main' }))

    expect(host.interrupt).toHaveBeenCalledTimes(2)
    firstInterrupt.resolve(true)
    await act(async () => {})
  })

  it('releases the stop lock after 500 ms when no next turn is running', async () => {
    const host = renderApp()
    const turnId = await startMainTurn(host)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    fireEvent.click(screen.getByRole('button', { name: 'Stop main' }))
    await act(async () => {})
    act(() => host.emitAgentEvent({ type: 'done', turnId, conversationId: 'chat:stop-button', exitCode: 0 }))

    act(() => vi.advanceTimersByTime(499))
    expect(screen.getByRole('button', { name: 'Stop main' })).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('button', { name: 'Send main' })).toBeInTheDocument()
  })

  it('can stop queued turn B after the 500 ms lock release', async () => {
    const host = renderApp()
    const firstTurnId = await startMainTurn(host)

    fireEvent.click(screen.getByRole('button', { name: 'Queue main' }))
    await act(async () => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(screen.getByRole('button', { name: 'Stop main' }))
    await act(async () => {})
    act(() => host.emitAgentEvent({ type: 'done', turnId: firstTurnId, conversationId: 'chat:stop-button', exitCode: 0 }))
    await act(async () => {})
    expect(host.sendTurn).toHaveBeenCalledTimes(2)

    act(() => vi.advanceTimersByTime(500))
    fireEvent.click(screen.getByRole('button', { name: 'Stop main' }))

    expect(host.interrupt).toHaveBeenCalledTimes(2)
  })
})

describe('App interrupt failure feedback', () => {
  it('shows the localized error toast when the main stop button interrupt fails', async () => {
    const host = renderApp(async () => false)
    await startMainTurn(host)

    fireEvent.click(screen.getByRole('button', { name: 'Stop main' }))

    expect(await screen.findByText('Could not stop the current turn.')).toBeInTheDocument()
  })

  it('shows the same error toast when the focused side-chat stop fails', async () => {
    const host = renderApp(async () => false)
    fireEvent.click(await screen.findByRole('button', { name: 'Open stop side chat' }))
    const sidePanel = await screen.findByLabelText('Side chat')
    const sideQuestion = within(sidePanel).getByRole('textbox', { name: 'Side-chat question' })
    fireEvent.change(sideQuestion, { target: { value: 'Run side turn' } })
    fireEvent.keyDown(sideQuestion, { key: 'Enter' })
    await waitFor(() => expect(host.sendTurn).toHaveBeenCalledTimes(1))

    fireEvent.click(within(sidePanel).getByRole('button', { name: 'Stop' }))

    expect(await screen.findByText('Could not stop the current turn.')).toBeInTheDocument()
  })

  it('shows the same error toast when the second Escape interrupt fails', async () => {
    const host = renderApp(async () => false)
    await startMainTurn(host)

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(await screen.findByText('Could not stop the current turn.')).toBeInTheDocument()
  })

  it('suppresses the main stop error when the captured turn ends before interrupt resolves', async () => {
    const pendingInterrupt = deferred<boolean>()
    const host = renderApp(() => pendingInterrupt.promise)
    const turnId = await startMainTurn(host)

    fireEvent.click(screen.getByRole('button', { name: 'Stop main' }))
    await waitFor(() => expect(host.interrupt).toHaveBeenCalledTimes(1))
    act(() => host.emitAgentEvent({ type: 'done', turnId, conversationId: 'chat:stop-button', exitCode: 0 }))
    pendingInterrupt.resolve(false)
    await act(async () => {})

    expect(screen.queryByText('Could not stop the current turn.')).not.toBeInTheDocument()
  })

  it('suppresses the side-chat stop error when the captured turn ends before interrupt resolves', async () => {
    const pendingInterrupt = deferred<boolean>()
    const host = renderApp(() => pendingInterrupt.promise)
    fireEvent.click(await screen.findByRole('button', { name: 'Open stop side chat' }))
    const sidePanel = await screen.findByLabelText('Side chat')
    const sideQuestion = within(sidePanel).getByRole('textbox', { name: 'Side-chat question' })
    fireEvent.change(sideQuestion, { target: { value: 'Run side turn' } })
    fireEvent.keyDown(sideQuestion, { key: 'Enter' })
    await waitFor(() => expect(host.sendTurn).toHaveBeenCalledTimes(1))
    const request = host.sendTurn.mock.calls[0][0]

    fireEvent.click(within(sidePanel).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(host.interrupt).toHaveBeenCalledTimes(1))
    act(() => host.emitAgentEvent({
      type: 'done',
      turnId: request.turnId!,
      conversationId: request.conversationId!,
      exitCode: 0,
    }))
    pendingInterrupt.resolve(false)
    await act(async () => {})

    expect(screen.queryByText('Could not stop the current turn.')).not.toBeInTheDocument()
  })

  it('suppresses the Escape error when the captured turn ends before interrupt resolves', async () => {
    const pendingInterrupt = deferred<boolean>()
    const host = renderApp(() => pendingInterrupt.promise)
    const turnId = await startMainTurn(host)

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(host.interrupt).toHaveBeenCalledTimes(1))
    act(() => host.emitAgentEvent({ type: 'done', turnId, conversationId: 'chat:stop-button', exitCode: 0 }))
    pendingInterrupt.resolve(false)
    await act(async () => {})

    expect(screen.queryByText('Could not stop the current turn.')).not.toBeInTheDocument()
  })
})
