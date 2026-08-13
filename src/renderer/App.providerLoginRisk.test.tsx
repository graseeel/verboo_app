import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ProviderLoginEvent, UserSettings } from '../shared/types'
import { App } from './App'

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

let providerLoginForward: ((event: ProviderLoginEvent) => void) | undefined
let providerLoginConfirmRisk: ReturnType<typeof vi.fn>
let providerLoginCancel: ReturnType<typeof vi.fn>

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
    onProviderLoginEvent: vi.fn((handler: (event: ProviderLoginEvent) => void) => {
      providerLoginForward = handler
      return unsubscribe
    }),
    providerLoginConfirmRisk,
    providerLoginCancel,
  }

  return new Proxy(bridge as Record<PropertyKey, unknown>, {
    get(target, property) {
      if (property in target) return target[property]
      return vi.fn(async () => undefined)
    },
  })
}

const RISK_NOTICE = 'Anthropic Usage Policy applies to this login.\nReview it before continuing.'

function fireLoginEvent(event: ProviderLoginEvent) {
  act(() => providerLoginForward?.(event))
}

async function renderApp() {
  render(<App />)
  await screen.findByRole('button', { name: /Ada/ })
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
  providerLoginConfirmRisk = vi.fn(async () => undefined)
  providerLoginCancel = vi.fn(async () => undefined)
  ;(window as unknown as { verboo: unknown }).verboo = createBridge()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('App provider login risk_notice (F4)', () => {
  it('risk_notice event opens the dialog with the FULL notice text on screen', async () => {
    await renderApp()
    fireLoginEvent({ provider: 'claude', state: 'risk_notice', message: RISK_NOTICE })

    const dialog = await screen.findByRole('dialog', { name: /risk notice|aviso de risco/i })
    expect(dialog.textContent).toContain('Anthropic Usage Policy applies to this login.')
    expect(dialog.textContent).toContain('Review it before continuing.')
  })

  it('accepting calls provider_login_confirm_risk with the provider and closes the dialog', async () => {
    await renderApp()
    fireLoginEvent({ provider: 'claude', state: 'risk_notice', message: RISK_NOTICE })
    fireEvent.click(await screen.findByRole('button', { name: /Accept the risk and continue/i }))

    await waitFor(() => expect(providerLoginConfirmRisk).toHaveBeenCalledWith('claude'))
    expect(providerLoginCancel).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /risk notice/i })).not.toBeInTheDocument())
  })

  it('cancelling calls provider_login_cancel and closes the dialog', async () => {
    await renderApp()
    fireLoginEvent({ provider: 'claude', state: 'risk_notice', message: RISK_NOTICE })
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/i }))

    await waitFor(() => expect(providerLoginCancel).toHaveBeenCalledTimes(1))
    expect(providerLoginConfirmRisk).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /risk notice/i })).not.toBeInTheDocument())
  })

  it('flow WITHOUT risk_notice (codex) stays as today — no dialog at any point', async () => {
    await renderApp()
    fireLoginEvent({ provider: 'codex', state: 'awaiting_browser' })
    fireLoginEvent({ provider: 'codex', state: 'connected' })

    expect(screen.queryByRole('dialog', { name: /risk notice/i })).not.toBeInTheDocument()
  })
})
