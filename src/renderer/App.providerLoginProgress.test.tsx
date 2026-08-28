import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ProviderAuthStatus, ProviderLoginEvent, UserSettings } from '../shared/types'
import { App } from './App'
import { ToastProvider } from './components/Toast'

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
  PluginsView: () => null,
}))

let settingsLanguage: 'en-US' | 'pt-BR' = 'en-US'

const userSettings = () => ({
  language: settingsLanguage,
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
}) as UserSettings

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let providerLoginForward: ((event: ProviderLoginEvent) => void) | undefined
let providerLoginStart: ReturnType<typeof vi.fn>
let providerLoginCancel: ReturnType<typeof vi.fn>
let providerLoginConfirmRisk: ReturnType<typeof vi.fn>
// Stateful bridge universe: the connected event makes the App re-read
// provider_auth_status, so the mock must reflect the CLI's new reality.
let authList: ProviderAuthStatus[]

function createBridge() {
  const unsubscribe = () => {}
  const bridge = {
    getUserSettings: vi.fn(async () => userSettings()),
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
    onProviderLoginEvent: vi.fn((handler: (event: ProviderLoginEvent) => void) => {
      providerLoginForward = handler
      return unsubscribe
    }),
    providerAuthStatus: vi.fn(async () => authList),
    // This suite deliberately exercises the legacy single-account cards.
    // Declare that capability result explicitly: an absent/rejected command
    // now means a transient discovery failure and must stay in loading.
    providerCapabilities: vi.fn(async () => ({ providerAccountsV1: false, providerUsageV1: false })),
    providerAccountsList: vi.fn(async () => []),
    providerAccountsUsage: vi.fn(async () => []),
    providerLoginStart,
    providerLoginCancel,
    providerLoginConfirmRisk,
  }

  return new Proxy(bridge as Record<PropertyKey, unknown>, {
    get(target, property) {
      if (property in target) return target[property]
      return vi.fn(async () => undefined)
    },
  })
}

function fireLoginEvent(event: ProviderLoginEvent) {
  act(() => providerLoginForward?.(event))
}

// T11: the provider cards MOVED from Integrações (Chrome tab) to their own
// Provedores tab — the connect flow is now exercised through the new home.
async function renderAppOnProviders() {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: /Ada/ }))
  fireEvent.click(screen.getByRole('button', { name: /^Settings$|^Configurações$/ }))
  fireEvent.click(await screen.findByRole('button', { name: /^Providers$|^Provedores$/ }))
  await screen.findByText('Codex')
  await waitFor(() => expect(providerLoginForward).toBeDefined())
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
  providerLoginForward = undefined
  settingsLanguage = 'en-US'
  providerLoginStart = vi.fn(async () => 'ok')
  providerLoginCancel = vi.fn(async () => undefined)
  providerLoginConfirmRisk = vi.fn(async () => undefined)
  authList = [{ provider: 'codex', connected: false }]
  ;(window as unknown as { verboo: unknown }).verboo = createBridge()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('App provider card — live progress during the login flow', () => {
  it('Conectar → starting → awaiting_browser: progress button on the card, Cancelar aborts', async () => {
    await renderAppOnProviders()

    fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }))
    await waitFor(() => expect(providerLoginStart).toHaveBeenCalledWith('codex'))
    expect(await screen.findByRole('button', { name: /Connecting…/i })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toHaveProperty('disabled', false)

    fireLoginEvent({ provider: 'codex', state: 'awaiting_browser' })
    expect(await screen.findByRole('button', { name: /Waiting for browser…/i })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }))
    await waitFor(() => expect(providerLoginCancel).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: /^Connect$/i })).toHaveProperty('disabled', false)
  })

  it('connected event ends the flow: card flips to Connected, progress gone', async () => {
    await renderAppOnProviders()

    fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }))
    fireLoginEvent({ provider: 'codex', state: 'awaiting_browser' })
    await screen.findByRole('button', { name: /Waiting for browser…/i })

    // The CLI wrote the credentials before reporting connected.
    authList = [{ provider: 'codex', connected: true, account: 'ada@openai.test' }]
    fireLoginEvent({ provider: 'codex', state: 'connected' })

    expect(await screen.findByText(/^Connected$/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Waiting for browser…|Connecting…/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^Disconnect$/i })).toHaveProperty('disabled', true)
  })

  it('pt-BR locale: the awaiting_browser toast renders the PT-BR text on screen (not the initial en)', async () => {
    settingsLanguage = 'pt-BR'
    // main.tsx wraps App in ToastProvider — the toast only renders with it.
    render(<ToastProvider><App /></ToastProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /Ada/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Configurações$/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^Provedores$/ }))
    await screen.findByText('Codex')
    await waitFor(() => expect(providerLoginForward).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: /^Conectar$/i }))
    fireLoginEvent({ provider: 'codex', state: 'awaiting_browser' })

    // The event fires AFTER the locale loaded — the toast must use the
    // CURRENT translator, never the one captured on the first render.
    expect(await screen.findByText(/Conclua o login no navegador/)).toBeInTheDocument()
    expect(screen.queryByText(/Finish signing in in the browser/)).toBeNull()
  })

  it.each([
    ['en-US', 'Settings', 'Providers', 'Could not confirm the provider login. Try again.'],
    ['pt-BR', 'Configurações', 'Provedores', 'Não foi possível confirmar o login do provedor. Tente novamente.'],
  ] as const)(
    '%s locale: a stable confirmation failure renders localized copy, never the IPC code',
    async (language, settingsLabel, providersLabel, expectedMessage) => {
      settingsLanguage = language
      render(<ToastProvider><App /></ToastProvider>)
      fireEvent.click(await screen.findByRole('button', { name: /Ada/ }))
      fireEvent.click(screen.getByRole('button', { name: settingsLabel }))
      fireEvent.click(await screen.findByRole('button', { name: providersLabel }))
      await screen.findByText('Codex')
      await waitFor(() => expect(providerLoginForward).toBeDefined())

      fireLoginEvent({
        provider: 'codex',
        state: 'error',
        message: 'provider_login_confirmation_failed',
      })

      expect(await screen.findByText(expectedMessage)).toBeInTheDocument()
      expect(screen.queryByText(/provider_login_confirmation_failed|provider_protocol_error/)).toBeNull()
    },
  )

  it('risk_notice keeps the card in progress; cancelling via the dialog returns it to Conectar', async () => {
    authList = [{ provider: 'claude', connected: false }]
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /Ada/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Providers' }))
    await screen.findByText('Claude')
    await waitFor(() => expect(providerLoginForward).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }))
    fireLoginEvent({ provider: 'claude', state: 'awaiting_browser' })
    fireLoginEvent({ provider: 'claude', state: 'risk_notice', message: 'Anthropic Usage Policy applies.' })

    // Dialog up AND the card still shows the flow is alive.
    const dialog = await screen.findByRole('dialog', { name: /risk notice/i })
    expect(screen.getByRole('button', { name: /Waiting for browser…/i })).toHaveProperty('disabled', true)

    // Two "Cancel" buttons exist now (card + dialog) — cancel via the DIALOG.
    fireEvent.click(within(dialog).getByRole('button', { name: /^Cancel$/i }))
    await waitFor(() => expect(providerLoginCancel).toHaveBeenCalledTimes(1))
    expect(providerLoginConfirmRisk).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: /^Connect$/i })).toHaveProperty('disabled', false)
  })
})
