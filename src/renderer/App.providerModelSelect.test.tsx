import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ProviderLoginEvent, UserSettings, VerbooModel } from '../shared/types'
import { App } from './App'

// @lobehub/icons transitively imports @lobehub/fluent-emoji, whose ESM is not
// resolvable in jsdom. Mock ONLY the icon — the ModelSelector under test is
// the REAL one (the defect lives in the selection path).
vi.mock('./features/models/ModelIcon', () => ({ ModelIcon: () => null }))

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
  rightToolbar?: ReactNode
}

vi.mock('./features/composer/Composer', () => ({
  Composer: ({ leftToolbar, rightToolbar }: ComposerProps) => (
    <div data-testid="composer-stub">{leftToolbar}{rightToolbar}</div>
  ),
}))

vi.mock('./features/terminal/LocalTerminalPanel', () => ({
  LocalTerminalPanel: () => null,
}))

vi.mock('./features/plugins/PluginsView', () => ({
  PluginsView: () => null,
}))

// The REAL field catalog shape (F2): verboo entries carry NO provider field;
// codex entries carry provider: 'codex' and unprefixed slugs.
const verbooUltra: VerbooModel = {
  id: 'glm-5.2',
  displayName: 'Ultra',
  contextWindow: 200000,
  supportsVision: false,
  raw: {},
}

const codexSol: VerbooModel = {
  id: 'gpt-5.6-sol',
  displayName: 'GPT-5.6-Sol',
  contextWindow: 272000,
  supportsVision: true,
  provider: 'codex',
  raw: {},
}

const codexGpt55: VerbooModel = {
  id: 'gpt-5.5',
  displayName: 'GPT-5.5',
  contextWindow: 272000,
  supportsVision: true,
  provider: 'codex',
  raw: {},
}

const catalog = [verbooUltra, codexSol, codexGpt55]

// The field catalog crossed SEARCH_THRESHOLD (12): verboo entries + 8 codex
// models. The owner SEARCHED 'gpt' before clicking — replicate exactly.
const bigCatalog: VerbooModel[] = [
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `verboo-model-${index}`,
    displayName: `Verboo Model ${index}`,
    contextWindow: 128000,
    supportsVision: false,
    raw: {},
  })),
  codexSol,
  codexGpt55,
]

let settingsStore: UserSettings
let updateUserSettingsMock: ReturnType<typeof vi.fn>
let activeCatalog: VerbooModel[] = catalog

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

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let providerLoginForward: ((event: ProviderLoginEvent) => void) | undefined
let listModelsMock: ReturnType<typeof vi.fn>

function createBridge() {
  const unsubscribe = () => {}
  const bridge = {
    getUserSettings: vi.fn(async () => settingsStore),
    updateUserSettings: updateUserSettingsMock,
    getConfig: vi.fn(async () => ({ workingDirectory: '', accessMode: 'approval', platform: 'darwin' })),
    getDefaultWorkingDirectory: vi.fn(async () => ''),
    getCredentialStatus: vi.fn(async () => ({ hasApiKey: true, apiKeyHint: '…1234' })),
    getCliAuthStatus: vi.fn(async () => ({ loggedIn: true, email: 'ada@example.test' })),
    listModels: listModelsMock,
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
    providerAuthStatus: vi.fn(async () => [{ provider: 'codex', connected: true, account: 'ada@openai.test' }]),
  }

  return new Proxy(bridge as Record<PropertyKey, unknown>, {
    get(target, property) {
      if (property in target) return target[property]
      return vi.fn(async () => undefined)
    },
  })
}

function modelPill(): HTMLElement {
  return document.querySelector('.model-pill') as HTMLElement
}

async function renderApp(expectPill = 'Ultra') {
  render(<App />)
  await screen.findByRole('button', { name: /Ada/ })
  await waitFor(() => expect(modelPill()).toBeTruthy())
  await waitFor(() => expect(modelPill().textContent).toContain(expectPill))
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
  activeCatalog = catalog
  listModelsMock = vi.fn(async () => ({ models: activeCatalog, source: 'cli', stale: false }))
  settingsStore = baseSettings()
  // The Rust echo: merges the patch and returns the whole settings object.
  updateUserSettingsMock = vi.fn(async (patch: Partial<UserSettings>) => {
    Object.assign(settingsStore, patch)
    return { ...settingsStore }
  })
  ;(window as unknown as { verboo: unknown }).verboo = createBridge()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('App — selecting a PROVIDER model applies it (field defect)', () => {
  it('automatically recovers when two startup catalog reads miss a connected provider', async () => {
    listModelsMock
      .mockResolvedValueOnce({
        models: [verbooUltra],
        source: 'cli',
        stale: false,
        providerError: 'provider catalog temporarily unavailable',
      })
      .mockResolvedValueOnce({
        models: [verbooUltra],
        source: 'cli',
        stale: false,
        providerError: 'provider catalog still initializing',
      })
      .mockResolvedValue({ models: catalog, source: 'cli', stale: false })

    await renderApp()
    await waitFor(() => expect(listModelsMock).toHaveBeenCalledTimes(3), { timeout: 2_500 })

    fireEvent.click(modelPill())
    // Single popover: the pill opens the model list DIRECTLY.
    expect(await screen.findByRole('button', { name: /GPT-5\.6-Sol/ })).toBeInTheDocument()
  })

  it('catalog with provider model → click GPT-5.6-Sol → the ACTIVE model changes on screen and persists', async () => {
    await renderApp()

    fireEvent.click(modelPill())
    // Single popover: the list itself greets the user — no drill-in row.
    const option = await screen.findByRole('button', { name: /GPT-5\.6-Sol/ })
    fireEvent.click(option)

    // The composer chip (the visible active model) must flip to the provider
    // model — the field defect leaves it on "Ultra".
    await waitFor(() => expect(modelPill().textContent).toContain('GPT-5.6-Sol'))
    expect(updateUserSettingsMock).toHaveBeenCalledWith({ lastSelectedModelId: 'gpt-5.6-sol' })
  })

  it('a DEGRADED refresh (catalog transiently without provider models) must NOT demote the explicit selection', async () => {
    await renderApp()
    fireEvent.click(modelPill())
    fireEvent.click(await screen.findByRole('button', { name: /GPT-5\.6-Sol/ }))
    await waitFor(() => expect(modelPill().textContent).toContain('GPT-5.6-Sol'))

    // attach_provider_models (model_service.rs:187) DEGRADES SILENTLY when the
    // provider CLI read fails: the next refresh can carry a codex-less catalog.
    activeCatalog = [verbooUltra]
    fireEvent.click(modelPill())
    // Reopening lands on the models list again (single popover) — the GPT-5.5
    // OPTION on screen proves the list is visible BEFORE the refresh, so the
    // disappearance wait below is meaningful.
    await screen.findByRole('button', { name: /GPT-5\.5/ })
    fireEvent.click(await screen.findByRole('button', { name: /^Refresh$|^Atualizar$/ }))

    // Wait until the refresh LANDS on screen: the open panel re-renders the
    // degraded catalog and the codex options vanish. Asserting the pill right
    // after the click would race the async refresh and read the stale text.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /GPT-5\.5/ })).toBeNull()
    })

    // THE assertion, on screen: the explicit selection survives the hiccup.
    // resolveSelectedModel used to jump to models[0] — permanently, since
    // every later refresh then kept the demotion (the field defect).
    expect(modelPill().textContent).toContain('GPT-5.6-Sol')

    activeCatalog = catalog
  })

  it('the provider selection SURVIVES an app reopen (startup hydrates from settings)', async () => {
    settingsStore = { ...baseSettings(), lastSelectedModelId: 'gpt-5.6-sol' }
    await renderApp('GPT-5.6-Sol')

    expect(modelPill().textContent).toContain('GPT-5.6-Sol')
  })

  it('startup under a DEGRADED first catalog keeps the persisted provider selection (pill falls back to the raw id)', async () => {
    // Sibling defect, same root: at startup current is undefined, so the
    // resolve used to drop the persisted choice to models[0] whenever the
    // first catalog arrived without provider models.
    activeCatalog = [verbooUltra]
    settingsStore = { ...baseSettings(), lastSelectedModelId: 'gpt-5.6-sol' }
    await renderApp('gpt-5.6-sol')

    // No model object is known at a fresh mount — the honest on-screen
    // fallback is the raw id, never the generic label nor a demoted model.
    expect(modelPill().textContent).toContain('gpt-5.6-sol')
  })

  it('EXACT field path: search "gpt" in a >12-model catalog, then click — the active model flips', async () => {
    activeCatalog = bigCatalog
    await renderApp('Verboo Model 0')

    fireEvent.click(modelPill())
    // Single popover: the search box is right there (catalog > 12 models).
    const search = await screen.findByRole('textbox')
    fireEvent.change(search, { target: { value: 'gpt' } })
    fireEvent.click(await screen.findByRole('button', { name: /GPT-5\.6-Sol/ }))

    await waitFor(() => expect(modelPill().textContent).toContain('GPT-5.6-Sol'))
    expect(updateUserSettingsMock).toHaveBeenCalledWith({ lastSelectedModelId: 'gpt-5.6-sol' })
  })
})
