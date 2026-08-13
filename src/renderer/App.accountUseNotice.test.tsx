import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ProviderCapabilities, StoredConversation, UserSettings, VerbooModel } from '../shared/types'
import { App } from './App'
import { CHAT_STORE_KEY, createConversation } from './state/chatStore'

vi.mock('./features/models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./features/terminal/LocalTerminalPanel', () => ({ LocalTerminalPanel: () => null }))
vi.mock('./features/plugins/PluginsView', () => ({ PluginsView: () => null }))
vi.mock('./features/composer/Composer', () => ({
  Composer: ({ leftToolbar }: { leftToolbar?: ReactNode }) => <div data-testid="composer-stub">{leftToolbar}</div>,
}))
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
  } as UserSettings
}

function resolvedCapabilities(): ProviderCapabilities {
  return { providerAccountsV1: true, providerUsageV1: true }
}

function createBridge() {
  const sendTurn = vi.fn(async () => 'turn-1')
  const bridge = {
    getUserSettings: vi.fn(async () => baseSettings()),
    updateUserSettings: vi.fn(async (patch: Partial<UserSettings>) => ({ ...baseSettings(), ...patch })),
    getConfig: vi.fn(async () => ({ workingDirectory: '', accessMode: 'approval', platform: 'darwin' })),
    getDefaultWorkingDirectory: vi.fn(async () => ''),
    getCredentialStatus: vi.fn(async () => ({ hasApiKey: true, apiKeyHint: '…1234' })),
    getCliAuthStatus: vi.fn(async () => ({ loggedIn: true, email: 'ada@example.test' })),
    listModels: vi.fn(async () => ({
      models: [{ ...claudeFable }],
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
    getUpdateStatus: vi.fn(async () => ({ status: 'up-to-date', current: '0.1.0', latest: '0.1.0' })),
    sendTurn,
    onAgentEvent: vi.fn(() => () => {}),
    onRefreshDataRequest: vi.fn(() => () => {}),
    onUpdateStatus: vi.fn(() => () => {}),
    onTerminalData: vi.fn(() => () => {}),
    onTerminalExit: vi.fn(() => () => {}),
    listenForNotificationClick: vi.fn(async () => () => {}),
    updateMenuBar: vi.fn(async () => {}),
    heartbeatMenuBar: vi.fn(async () => {}),
    onProviderLoginEvent: vi.fn(() => () => {}),
    providerAuthStatus: vi.fn(async () => []),
    chromeIntegrationStatus: vi.fn(async () => ({
      extension: 'managed', bridge: 'managed', mcp: 'managed', connection: 'waitingForChrome',
      panelState: 'notApplicable', aggregate: 'ready', installedVersion: '0.5.2', availableVersion: '0.5.2',
      canConfigure: false, canRepair: false, canRemove: false, storeUrlAvailable: false,
      developmentBuild: false, extensionIdSource: 'release',
    })),
    getVideoComponentState: vi.fn(async () => ({ asrModel: 'absent' })),
    onVideoTranscriberProgress: vi.fn(() => () => {}),
    onVideoOcrRequest: vi.fn(() => () => {}),
    getWorkspaceChanges: vi.fn(async () => ({ added: [], modified: [], deleted: [] })),
    providerCapabilities: vi.fn(async () => resolvedCapabilities()),
    providerAccountsList: vi.fn(async () => [{
      schemaVersion: 1,
      provider: 'claude',
      accountId: 'claude-a',
      displayLabel: 'Claude 1',
      isDefault: true,
      connectionState: 'connected',
    }]),
    providerAccountModels: vi.fn(async () => [claudeFable]),
    providerLoginStart: vi.fn(async () => 'ok'),
    providerLoginCancel: vi.fn(async () => undefined),
    providerLoginConfirmRisk: vi.fn(async () => undefined),
    providerAuthUpdate: vi.fn(async () => {}),
  }
  return {
    sendTurn,
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

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function storedConversation(): StoredConversation {
  const store = JSON.parse(window.localStorage.getItem(CHAT_STORE_KEY) ?? '{}') as {
    conversations: StoredConversation[]
  }
  return store.conversations.find(conversation => conversation.id === 'chat:main') as StoredConversation
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
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('App — A1: switching the conversation account emits NO transcript notice', () => {
  it('uses a provider account from the Provedores card and adds no "next turn" activity to the transcript', async () => {
    seedConversation()
    const harness = createBridge()
    ;(window as unknown as { verboo: unknown }).verboo = harness.bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /Ada/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Settings$|^Configurações$/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^Providers$|^Provedores$/ }))
    await screen.findByText('Claude')

    // The account card renders the primary action "Use here".
    fireEvent.click(await screen.findByRole('button', { name: /^Use here$|^Usar aqui$/ }))
    // The confirm dialog closes the flow.
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^Use this account$|^Usar esta conta$/ }))

    // The flow really ran: the conversation is now bound to the account.
    await waitFor(() => {
      const conversation = storedConversation()
      expect(conversation.providerAccountBindings?.claude).toBe('claude-a')
    })

    // A1 — the transcript must NOT gain a red "…for the next turn" activity.
    const conversation = storedConversation()
    const notice = conversation.items.find(item =>
      item.kind === 'activity' && /next turn|próximo turno/i.test(item.text ?? ''),
    )
    expect(notice).toBeUndefined()
    await act(async () => {})
  })

  it('re-binds to a DIFFERENT account without adding a transcript notice either', async () => {
    // The conversation was bound to a STALE account id — using the card
    // re-binds to the live claude-a (previousAccountId !== accountId), the
    // exact branch that used to emit the notice.
    seedConversation({ providerAccountBindings: { claude: 'claude-stale' } })
    const harness = createBridge()
    ;(window as unknown as { verboo: unknown }).verboo = harness.bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /Ada/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Settings$|^Configurações$/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^Providers$|^Provedores$/ }))
    await screen.findByText('Claude')

    fireEvent.click(await screen.findByRole('button', { name: /^Use here$|^Usar aqui$/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^Use this account$|^Usar esta conta$/ }))

    await waitFor(() => {
      const conversation = storedConversation()
      expect(conversation.providerAccountBindings?.claude).toBe('claude-a')
    })
    const conversation = storedConversation()
    const notice = conversation.items.find(item =>
      item.kind === 'activity' && /next turn|próximo turno/i.test(item.text ?? ''),
    )
    expect(notice).toBeUndefined()
    await act(async () => {})
  })
})
