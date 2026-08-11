import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CliAuthStatus,
  CredentialStatus,
  UserSettings,
  UpdateSnapshot,
  WhatsNewAcknowledgeResult,
  WhatsNewStatus,
} from '../shared/types'
import { App } from './App'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))
vi.mock('./features/models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./features/terminal/LocalTerminalPanel', () => ({ LocalTerminalPanel: () => null }))
vi.mock('./features/plugins/PluginsView', () => ({ PluginsView: () => null }))
vi.mock('../../assets/branding/verboo-mascot.png', () => ({ default: 'mascot.png' }))
vi.mock('./features/composer/Composer', () => ({
  Composer: ({ disabled }: { disabled: boolean }) => (
    <button type="button" data-testid="composer-submit" disabled={disabled}>Send prompt</button>
  ),
}))

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
  updates: { channel: 'beta', autoCheck: true, autoDownload: false },
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

const bootstrapSnapshot: UpdateSnapshot = {
  status: 'downloading',
  target: 'cli',
  channel: 'beta',
  currentVersion: '0.7.0-beta',
  cliAvailableVersion: '0.15.9',
  cliBootstrapRequired: true,
  bootstrapStage: 'runtime',
  percent: 37,
}

const pendingWhatsNew = {
  version: '0.7.0-beta',
  tag: 'v0.7.0-beta',
  preview: false,
} satisfies WhatsNewStatus

let updateListener: ((snapshot: UpdateSnapshot) => void) | undefined
let bridge: ReturnType<typeof createBridge>

function createBridge() {
  const unsubscribe = () => {}
  const knownBridge = {
    getUserSettings: vi.fn(async () => settings),
    updateUserSettings: vi.fn(async () => settings),
    getConfig: vi.fn(async () => ({ workingDirectory: '', accessMode: 'approval', platform: 'darwin' })),
    getDefaultWorkingDirectory: vi.fn(async () => ''),
    getCredentialStatus: vi.fn<() => Promise<CredentialStatus>>(
      async () => ({ hasApiKey: true, apiKeyHint: '…1234' }),
    ),
    getCliAuthStatus: vi.fn<() => Promise<CliAuthStatus>>(
      async () => ({ loggedIn: true, email: 'ada@example.test' }),
    ),
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
    getWhatsNewStatus: vi.fn<() => Promise<WhatsNewStatus | undefined>>(async () => undefined),
    acknowledgeWhatsNew: vi.fn<(version: string) => Promise<WhatsNewAcknowledgeResult>>(
      async () => ({ persisted: true }),
    ),
    getUpdateStatus: vi.fn(async () => bootstrapSnapshot),
    bootstrapCli: vi.fn(() => new Promise<UpdateSnapshot>(() => {})),
    onUpdateStatus: vi.fn((callback: (snapshot: UpdateSnapshot) => void) => {
      updateListener = callback
      return unsubscribe
    }),
    onAgentEvent: vi.fn(() => unsubscribe),
    onVideoOcrRequest: vi.fn(() => unsubscribe),
    onRefreshDataRequest: vi.fn(() => unsubscribe),
    onTerminalData: vi.fn(() => unsubscribe),
    onTerminalExit: vi.fn(() => unsubscribe),
    onProviderLoginEvent: vi.fn(() => unsubscribe),
    listenForNotificationClick: vi.fn(async () => unsubscribe),
    updateMenuBar: vi.fn(async () => {}),
    heartbeatMenuBar: vi.fn(async () => {}),
    providerAuthStatus: vi.fn(async () => []),
  }
  return new Proxy(knownBridge, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property)
      return vi.fn(async () => undefined)
    },
  })
}

beforeEach(() => {
  window.localStorage.clear()
  updateListener = undefined
  bridge = createBridge()
  ;(window as unknown as { verboo: unknown }).verboo = bridge
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
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('App first CLI installation gate', () => {
  it('starts bootstrap, blocks prompts, keeps Settings usable, then unlocks after verified success', async () => {
    render(<App />)

    expect(await screen.findByText('Preparing Verboo')).toBeVisible()
    expect(bridge.bootstrapCli).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('composer-submit')).toBeDisabled()

    act(() => updateListener?.({
      ...bootstrapSnapshot,
      bootstrapStage: 'cli',
      percent: 72,
    }))
    expect(screen.getByText('Installing the Verboo CLI')).toBeVisible()
    expect(screen.getByTestId('composer-submit')).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Configure the app' }))
    expect(await screen.findByRole('heading', { name: 'Security', level: 1 })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }))
    expect(await screen.findByText('Installing the Verboo CLI')).toBeVisible()

    vi.useFakeTimers()
    act(() => updateListener?.({
      status: 'idle',
      channel: 'beta',
      currentVersion: '0.7.0-beta',
      cliCurrentVersion: '0.15.9',
      cliBootstrapRequired: false,
    }))

    expect(screen.getByText('Verboo is ready')).toBeVisible()
    expect(screen.getByTestId('composer-submit')).toBeDisabled()

    act(() => vi.advanceTimersByTime(1_600))
    expect(screen.queryByText('Verboo is ready')).toBeNull()
    expect(screen.getByTestId('composer-submit')).toBeEnabled()
  })

  it('keeps an installed but unhealthy CLI blocked until retry is authoritatively validated', async () => {
    const installedButBroken: UpdateSnapshot = {
      ...bootstrapSnapshot,
      status: 'error',
      cliCurrentVersion: '0.15.10',
      cliAvailableVersion: undefined,
      bootstrapStage: 'cli',
      error: 'CLI: CLI smoke check failed: CodeRange failed',
      percent: undefined,
    }
    bridge.getUpdateStatus.mockResolvedValueOnce(installedButBroken)
    bridge.bootstrapCli.mockResolvedValueOnce({
      status: 'idle',
      channel: 'beta',
      currentVersion: '0.7.0-beta',
      cliCurrentVersion: '0.15.10',
      cliBootstrapRequired: false,
    })

    render(<App />)

    expect(await screen.findByText("Couldn't install the Verboo CLI")).toBeVisible()
    expect(screen.getByText(/CodeRange failed/)).toBeVisible()
    expect(screen.getByTestId('composer-submit')).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(bridge.bootstrapCli).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Verboo is ready')).toBeVisible()
  })

  it('waits for CLI bootstrap and its success animation before showing release notes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    bridge.getWhatsNewStatus.mockResolvedValue(pendingWhatsNew)
    render(<App />)

    expect(await screen.findByText('Preparing Verboo')).toBeVisible()
    expect(bridge.getWhatsNewStatus).not.toHaveBeenCalled()

    act(() => updateListener?.({
      ...bootstrapSnapshot,
      status: 'idle',
      cliBootstrapRequired: false,
      percent: 100,
    }))
    expect(screen.getByText('Verboo is ready')).toBeVisible()
    expect(bridge.getWhatsNewStatus).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(1_400) })
    expect(await screen.findByRole('dialog', { name: 'Verboo Code 0.7.0-beta is here' })).toBeVisible()
    expect(bridge.getWhatsNewStatus).toHaveBeenCalledTimes(1)
  })

  it('shows on the login surface for a first tagged clean install and closes once', async () => {
    bridge.getUpdateStatus.mockResolvedValue({
      status: 'idle',
      channel: 'beta',
      currentVersion: '0.7.0-beta',
      cliBootstrapRequired: false,
    })
    bridge.getWhatsNewStatus.mockResolvedValue(pendingWhatsNew)
    bridge.acknowledgeWhatsNew.mockResolvedValue({ persisted: true })
    bridge.getCliAuthStatus.mockResolvedValue({ loggedIn: false })
    bridge.getCredentialStatus.mockResolvedValue({ hasApiKey: false })
    bridge.listModels.mockResolvedValue({ models: [], source: 'none', stale: false })
    render(<App />)

    expect(await screen.findByRole('dialog')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(bridge.acknowledgeWhatsNew).toHaveBeenCalledWith('0.7.0-beta'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
