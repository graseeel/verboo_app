import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserSettings } from '../shared/types'
import { App } from './App'

// Boot-gate + login-error harness: the bridge is LOCKED (no CLI session, no
// API key, no models) so the app can never leave the login surface.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))
// App's import chain pulls these; their @lobehub/icons ESM does not resolve
// in jsdom (same constraint as the other App harnesses). None of them render
// on the login surface under test.
vi.mock('./features/models/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./features/terminal/LocalTerminalPanel', () => ({ LocalTerminalPanel: () => null }))
vi.mock('./features/plugins/PluginsView', () => ({ PluginsView: () => null }))
vi.mock('../../assets/branding/verboo-mascot.png', () => ({ default: 'mascot.png' }))
vi.mock('../../assets/branding/verboo-wordmark.png', () => ({ default: 'wordmark.png' }))

let settingsStore: UserSettings

function baseSettings(): UserSettings {
  return {
    language: 'en-US',
    theme: 'system',
    defaultAccessMode: 'approval',
    fullAccessEnabled: false,
    showInMenuBar: true,
    showMenuBarText: true,
    staySignedIn: false,
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

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createLockedBridge() {
  const unsubscribe = () => {}
  const bridge = {
    getUserSettings: vi.fn(async () => settingsStore),
    updateUserSettings: vi.fn(async (patch: Partial<UserSettings>) => ({ ...settingsStore, ...patch })),
    getConfig: vi.fn(async () => ({ workingDirectory: '', accessMode: 'approval', platform: 'darwin' })),
    getDefaultWorkingDirectory: vi.fn(async () => ''),
    // LOCKED: nothing the app can validate against.
    getCredentialStatus: vi.fn(async () => ({ hasApiKey: false })),
    getCliAuthStatus: vi.fn(async () => ({ loggedIn: false })),
    listModels: vi.fn(async () => ({ models: [], source: 'none', stale: false })),
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
    onProviderLoginEvent: vi.fn(() => unsubscribe),
    providerAuthStatus: vi.fn(async () => []),
  }
  return new Proxy(bridge as Record<PropertyKey, unknown>, {
    get(target, property) {
      if (property in target) return target[property]
      return vi.fn(async () => undefined)
    },
  })
}

async function renderLockedApp() {
  ;(window as unknown as { verboo: unknown }).verboo = createLockedBridge()
  render(<App />)
}

beforeEach(() => {
  // Deliberately EMPTY: no 'verboo:development-notice-accepted', no remembered
  // session. The first-boot state is the state under test.
  window.localStorage.clear()
  settingsStore = baseSettings()
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
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('App boot — the development-version interstitial is GONE (Ivo\'s order)', () => {
  it('first boot with NO prior acceptance state lands DIRECTLY on the sign-in form (en)', async () => {
    await renderLockedApp()

    // The login FORM is the first thing the user sees…
    expect(await screen.findByRole('button', { name: /Sign in with CLI/ })).toBeTruthy()
    // …not a development-version wall: no interstitial copy, no accept gate.
    expect(document.body.textContent).not.toMatch(/Important notice|Development build|not an official build/i)
    expect(screen.queryByRole('button', { name: /I understand and want to continue/ })).toBeNull()
  })

  it('first boot lands directly on the sign-in form in pt-BR too (vocabulary parity)', async () => {
    settingsStore = { ...baseSettings(), language: 'pt-BR' }
    await renderLockedApp()

    expect(await screen.findByRole('button', { name: /Entrar pelo CLI/ })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Aviso importante|Versão (em desenvolvimento|independente)|não é uma versão oficial/i)
    expect(screen.queryByRole('button', { name: /Entendi e quero continuar/ })).toBeNull()
  })
})

describe('App login — session-invalid error banner (field photo: duplicated)', () => {
  it('a failed "I already authenticated" surfaces the message EXACTLY ONCE', async () => {
    await renderLockedApp()
    const retry = await screen.findByRole('button', { name: /I already authenticated/ })
    // Let the mount-time validation settle before the click.
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(retry)
    // Settled again = the re-validation finished (button re-enabled).
    await waitFor(() => expect((screen.getByRole('button', { name: /I already authenticated/ }) as HTMLButtonElement).disabled).toBe(false))

    expect(screen.getAllByText('No valid Verboo session was found.')).toHaveLength(1)
  })
})

describe('T5: a rejected Rust command surfaces a banner and never sticks the login surface (field photo M4)', () => {
  // The CLI spawn fails (no Node installed) → listModels returns Err →
  // the Tauri invoke rejects the promise. Before the catch, the try body
  // aborted before the setAuthError setters → mute surface + "Verificando
  // sessão local…" stuck forever. Now the catch surfaces a friendly
  // headline + the raw cause behind a details toggle, and returns false.

  it('en: listModels rejecting → banner visible, "Checking…" ends, raw cause behind toggle', async () => {
    const bridge = createLockedBridge()
    bridge.listModels = vi.fn(async () => {
      throw new Error('No such file or directory (os error 2)')
    })
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    const retry = await screen.findByRole('button', { name: /I already authenticated/ })
    // Mount-time validateAccess settled (catch fired, checking=false).
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(retry)
    // The re-validation settled again (catch fired, checking=false).
    await waitFor(() => expect((screen.getByRole('button', { name: /I already authenticated/ }) as HTMLButtonElement).disabled).toBe(false))

    // The rejection surfaced a friendly headline (not a mute stuck spinner)…
    expect(screen.getByText('Could not verify your Verboo session.')).toBeTruthy()
    // …the raw cause is behind a toggle, not bare on the surface.
    expect(screen.getByText('Show technical details')).toBeTruthy()
    // …and "Checking local Verboo session…" is NOT stuck forever.
    expect(screen.queryByText('Checking local Verboo session...')).toBeNull()
  })

  it('pt-BR: listModels rejecting → banner visible, "Verificando…" ends', async () => {
    settingsStore = { ...baseSettings(), language: 'pt-BR' }
    const bridge = createLockedBridge()
    bridge.listModels = vi.fn(async () => {
      throw new Error('No such file or directory (os error 2)')
    })
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    const retry = await screen.findByRole('button', { name: /Já autentiquei/ })
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(retry)
    await waitFor(() => expect((screen.getByRole('button', { name: /Já autentiquei/ }) as HTMLButtonElement).disabled).toBe(false))

    // The click re-ran validateAccess in pt-BR (the mount-time catch
    // captured the en-US default before getUserSettings switched the
    // language — a pre-existing i18n re-render gap, out of scope for T5).
    expect(screen.getByText('Não foi possível verificar sua sessão do Verboo.')).toBeTruthy()
    expect(screen.getByText('Mostrar detalhes técnicos')).toBeTruthy()
    expect(screen.queryByText('Verificando sessão local do Verboo...')).toBeNull()
  })
})
