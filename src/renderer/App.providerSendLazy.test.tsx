import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTurnRequest, ProviderCapabilities, StoredConversation, UserSettings, VerbooModel } from '../shared/types'
import { App } from './App'
import { CHAT_STORE_KEY, createConversation } from './state/chatStore'

vi.mock('./features/models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./features/terminal/LocalTerminalPanel', () => ({ LocalTerminalPanel: () => null }))
vi.mock('./features/plugins/PluginsView', () => ({ PluginsView: () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))

const claudeFable: VerbooModel = {
  id: 'claude-fable-5',
  displayName: 'Claude Fable 5',
  contextWindow: 200000,
  supportsVision: true,
  provider: 'claude',
  raw: {},
}

let settingsStore: UserSettings

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

function createBridge(overrides: Record<PropertyKey, unknown> = {}) {
  const unsubscribe = () => {}
  const sendTurn = vi.fn((request: AgentTurnRequest) => Promise.resolve(request.turnId ?? 'turn:test'))
  // providerCapabilities is DEFERRED on purpose: the provider accounts list is
  // never marked as loaded, so the send path starts with accountsLoaded=false.
  // It must resolve to the REAL capabilities object — a void promise would
  // make reloadAccounts fall back to providerAccountsV1:false (legacy).
  const resolvedCapabilities: ProviderCapabilities = {
    providerAccountsV1: true,
    providerUsageV1: true,
    loginTransport: 'pty-slash-v1',
  }
  let resolveCaps!: (value: ProviderCapabilities) => void
  const pendingCaps = new Promise<ProviderCapabilities>(done => { resolveCaps = done })
  const bridge = {
    getUserSettings: vi.fn(async () => settingsStore),
    updateUserSettings: vi.fn(async (patch: Partial<UserSettings>) => {
      Object.assign(settingsStore, patch)
      return { ...settingsStore }
    }),
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
    onAgentEvent: vi.fn(() => unsubscribe),
    onRefreshDataRequest: vi.fn(() => unsubscribe),
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
    providerCapabilities: vi.fn(() => pendingCaps),
    providerAccountsList: vi.fn(async () => []),
    providerAccountModels: vi.fn(async () => []),
    ...overrides,
  }
  return {
    sendTurn,
    resolveCapabilities: () => resolveCaps(resolvedCapabilities),
    bridge: new Proxy(bridge as Record<PropertyKey, unknown>, {
      get(target, property) {
        if (property in target) return target[property]
        return vi.fn(async () => undefined)
      },
    }),
  }
}

function seedConversation(extra: Partial<StoredConversation> = {}) {
  const conversation = {
    ...createConversation(),
    id: 'chat:main',
    title: 'ok',
    createdAt: 10,
    updatedAt: 10,
    lastTurnEndedAt: 10,
    items: [{ id: 'message:existing', role: 'user' as const, text: 'ok', timestamp: 10 }],
    ...extra,
  }
  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({
    version: 3,
    projects: [],
    conversations: [conversation],
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
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  settingsStore = baseSettings()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('App — L3: send does not wait for the provider accounts reload', () => {
  it('sends the turn with the current snapshot as fallback while accounts are still loading', async () => {
    seedConversation()
    const harness = createBridge()
    ;(window as unknown as { verboo: unknown }).verboo = harness.bridge
    render(<App />)
    await screen.findByRole('button', { name: /Ada/ })

    await waitFor(() => expect(document.querySelector('.composer-text-wrap textarea')).toBeTruthy())
    const input = document.querySelector('.composer-text-wrap textarea') as HTMLElement
    fireEvent.change(input, { target: { value: 'responda apenas: ok' } })
    fireEvent.click(document.querySelector('.send-button') as HTMLElement)

    // The capabilities promise is STILL pending here (accountsLoaded=false).
    // L3: the preflight must run against the current snapshot and the turn
    // must be sent WITHOUT waiting for the reload to finish.
    await waitFor(() => expect(harness.sendTurn).toHaveBeenCalledTimes(1), { timeout: 3000 })
    await act(async () => { harness.resolveCapabilities() })
  })

  // L3 — the converse case: when the conversation HAS a provider account
  // binding, a cold snapshot must NOT degrade to legacy. The send waits for
  // the reload and goes out with the bound account.
  it('with a conversation binding the send waits for the reload and goes out with the bound account', async () => {
    seedConversation({ providerAccountBindings: { claude: 'claude-a' } })
    const harness = createBridge({
      providerAccountsList: vi.fn(async () => [{
        schemaVersion: 1,
        provider: 'claude',
        accountId: 'claude-a',
        displayLabel: 'Claude 1',
        isDefault: true,
        connectionState: 'connected',
      }]),
      providerAccountModels: vi.fn(async () => [claudeFable]),
    })
    ;(window as unknown as { verboo: unknown }).verboo = harness.bridge
    render(<App />)
    await screen.findByRole('button', { name: /Ada/ })

    await waitFor(() => expect(document.querySelector('.composer-text-wrap textarea')).toBeTruthy())
    const input = document.querySelector('.composer-text-wrap textarea') as HTMLElement
    fireEvent.change(input, { target: { value: 'responda apenas: ok' } })
    fireEvent.click(document.querySelector('.send-button') as HTMLElement)

    // The capabilities promise is still pending — the turn must WAIT for the
    // reload instead of being sent with a legacy (no-account) request.
    await act(async () => { await Promise.resolve() })
    expect(harness.sendTurn).not.toHaveBeenCalled()

    // Once the reload resolves, the send completes WITH the bound account.
    await act(async () => { harness.resolveCapabilities() })
    await waitFor(() => expect(harness.sendTurn).toHaveBeenCalledTimes(1), { timeout: 3000 })
    const request = harness.sendTurn.mock.calls[0][0] as AgentTurnRequest
    expect(request.providerAccount?.accountId).toBe('claude-a')
  })
})
