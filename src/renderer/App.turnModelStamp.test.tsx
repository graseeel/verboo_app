import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentResultSnapshot, AgentTurnRequest, UserSettings, VerbooModel } from '../shared/types'
import { App } from './App'
import { CHAT_STORE_KEY, createConversation } from './state/chatStore'

// ModelSelector stays out of this harness (its @lobehub/icons ESM does not
// resolve in jsdom). The selection itself hydrates from settings + catalog —
// the component is not part of what these tests exercise.
vi.mock('./features/models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./features/terminal/LocalTerminalPanel', () => ({ LocalTerminalPanel: () => null }))
vi.mock('./features/plugins/PluginsView', () => ({ PluginsView: () => null }))

// The simulator panel subscribes through the real @tauri-apps/api/event —
// mock the tauri layer so the __TAURI_INTERNALS__ stub stays minimal.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

// The owner's model (measured by the Maestro): claude-fable-5 exists exactly
// once in the catalog, in the claude group — no id ambiguity anywhere.
const claudeFable: VerbooModel = {
  id: 'claude-fable-5',
  displayName: 'Claude Fable 5',
  contextWindow: 200000,
  supportsVision: true,
  provider: 'claude',
  raw: {},
}

let settingsStore: UserSettings
let updateUserSettingsMock: ReturnType<typeof vi.fn>
let agentEventForward: ((event: AgentEvent) => void) | undefined
let refreshDataForward: (() => void) | undefined
let resolveSendTurn: (() => void) | undefined

function baseSettings(): UserSettings {
  return {
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
    lastSelectedModelId: 'claude-fable-5',
  } as UserSettings
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createBridge() {
  const unsubscribe = () => {}
  // DEFERRED on purpose: the test controls WHEN the invoke resolves, so the
  // 'started' event can land first — the exact Rust ordering (turn_service
  // emits `started`, THEN the send_turn command returns). The old harness
  // resolved sendTurn immediately, which drained the runTurn continuation
  // (turnModels stamp) BEFORE `started` and hid the race (T10).
  const sendTurn = vi.fn((request: AgentTurnRequest) => new Promise<string>(resolve => {
    resolveSendTurn = () => resolve(request.turnId ?? 'turn:test')
  }))
  const bridge = {
    getUserSettings: vi.fn(async () => settingsStore),
    updateUserSettings: updateUserSettingsMock,
    getConfig: vi.fn(async () => ({ workingDirectory: '', accessMode: 'approval', platform: 'darwin' })),
    getDefaultWorkingDirectory: vi.fn(async () => ''),
    getCredentialStatus: vi.fn(async () => ({ hasApiKey: true, apiKeyHint: '…1234' })),
    getCliAuthStatus: vi.fn(async () => ({ loggedIn: true, email: 'ada@example.test' })),
    listModels: vi.fn(async () => ({ models: [claudeFable], source: 'cli', stale: false })),
    getProfile: vi.fn(async () => ({
      status: 'ready',
      user: { name: 'Ada' },
      summary: { totalTokens: 1, tokensInTotal: 1, tokensOutTotal: 0, reqTotal: 1 },
      plan: { name: 'Pro', status: 'active' },
    })),
    pluginList: vi.fn(async () => []),
    pluginSkills: vi.fn(async () => []),
    getUpdateStatus: vi.fn(async () => undefined),
    sendTurn,
    onAgentEvent: vi.fn((handler: (event: AgentEvent) => void) => {
      agentEventForward = handler
      return unsubscribe
    }),
    onRefreshDataRequest: vi.fn((handler: () => void) => {
      refreshDataForward = handler
      return unsubscribe
    }),
    onVideoOcrRequest: vi.fn(() => unsubscribe),
    onUpdateStatus: vi.fn(() => unsubscribe),
    onTerminalData: vi.fn(() => unsubscribe),
    onTerminalExit: vi.fn(() => unsubscribe),
    listenForNotificationClick: vi.fn(async () => unsubscribe),
    updateMenuBar: vi.fn(async () => {}),
    heartbeatMenuBar: vi.fn(async () => {}),
    onProviderLoginEvent: vi.fn(() => unsubscribe),
    providerAuthStatus: vi.fn(async () => [{ provider: 'claude', connected: true, account: 'ada@anthropic.test' }]),
    chromeIntegrationStatus: vi.fn(async () => ({
      extension: 'managed', bridge: 'managed', mcp: 'managed', connection: 'waitingForChrome',
      panelState: 'notApplicable', aggregate: 'ready', installedVersion: '0.5.2', availableVersion: '0.5.2',
      canConfigure: false, canRepair: false, canRemove: false, storeUrlAvailable: false,
      developmentBuild: false, extensionIdSource: 'release',
    })),
    getVideoComponentState: vi.fn(async () => ({ asrModel: 'absent' })),
    onVideoTranscriberProgress: vi.fn(() => unsubscribe),
    getWorkspaceChanges: vi.fn(async () => undefined),
  }

  return {
    sendTurn,
    emitAgentEvent(event: AgentEvent) {
      agentEventForward?.(event)
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
    title: 'responda apenas: ok',
    createdAt: 10,
    updatedAt: 10,
    lastTurnEndedAt: 10,
    items: [{ id: 'message:existing', role: 'user' as const, text: 'responda apenas: ok', timestamp: 10 }],
  }
  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({
    version: 3,
    projects: [],
    conversations: [conversation],
  }))
}

function turnArticle(): HTMLElement {
  const article = document.querySelector('article.turn-view')
  expect(article).toBeTruthy()
  return article as HTMLElement
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
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  // jsdom lacks Element.scrollTo — the autoscroll effect fires as the
  // transcript appends turn items.
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  agentEventForward = undefined
  refreshDataForward = undefined
  resolveSendTurn = undefined
  settingsStore = baseSettings()
  updateUserSettingsMock = vi.fn(async (patch: Partial<UserSettings>) => {
    Object.assign(settingsStore, patch)
    return { ...settingsStore }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('App — T10: o carimbo de modelo chega ao item MESMO quando `started` ganha a corrida', () => {
  it('turno claude puro (só texto) persiste o carimbo e o cabeçalho diz Claude, não Verboo', async () => {
    // Reproduces the owner's exact turn: "responda apenas: ok" on
    // claude-fable-5. Pure-text turn — ONE text segment, no activities — the
    // shape that persisted with NO model fields in the field measurement.
    seedConversation()
    const harness = createBridge()
    ;(window as unknown as { verboo: unknown }).verboo = harness.bridge
    render(<App />)
    await screen.findByRole('button', { name: /Ada/ })

    await waitFor(() => expect(document.querySelector('.composer-text-wrap textarea')).toBeTruthy())
    const input = document.querySelector('.composer-text-wrap textarea') as HTMLElement
    fireEvent.change(input, { target: { value: 'responda apenas: ok' } })
    fireEvent.click(document.querySelector('.send-button') as HTMLElement)
    await waitFor(() => expect(harness.sendTurn).toHaveBeenCalledTimes(1))
    const turnId = harness.sendTurn.mock.calls[0][0].turnId as string

    // RUST ORDER: `started` is emitted BEFORE the send_turn invoke resolves.
    // At this instant turnModels.current[turnId] does NOT exist yet — the
    // placeholder segment is born without the stamp (the pre-fix bug).
    act(() => { harness.emitAgentEvent({ type: 'started', turnId }) })
    await act(async () => { resolveSendTurn?.() })

    const resultSnapshot: AgentResultSnapshot = {
      turnId,
      exitCode: 0,
      isError: false,
      rawResult: { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
    }
    act(() => { harness.emitAgentEvent({ type: 'stdout', turnId, text: 'ok' }) })
    act(() => { harness.emitAgentEvent({ type: 'result', turnId, result: resultSnapshot }) })
    act(() => { harness.emitAgentEvent({ type: 'done', turnId, exitCode: 0 }) })

    // Header: the turn was CLAUDE — stamped at send time, re-stamped after
    // the invoke resolved. Never the literal 'Verboo'.
    await waitFor(() => {
      expect(turnArticle().querySelector('.message-meta')?.textContent).toBe('Claude - Claude Fable 5')
    })

    // Persistence: the stamp must SURVIVE on the stored item (the owner's
    // store had NO model fields on this exact turn shape).
    await waitFor(() => {
      const raw = window.localStorage.getItem(CHAT_STORE_KEY)
      expect(raw).toBeTruthy()
      const store = JSON.parse(raw!) as {
        conversations: Array<{ id: string; items: Array<Record<string, unknown>> }>
      }
      const conversation = store.conversations.find(c => c.id === 'chat:main')
      const item = conversation?.items.find(i => i.id === `${turnId}:text:1`)
      expect(item, 'assistant text segment must be persisted').toBeTruthy()
      expect(item?.modelId).toBe('claude-fable-5')
      expect(item?.modelDisplayName).toBe('Claude Fable 5')
      expect(item?.provider).toBe('claude')
    }, { timeout: 3000 })
  })
})
