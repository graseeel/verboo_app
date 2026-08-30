import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listen } from '@tauri-apps/api/event'
import type { LoginEvent, UpdateSnapshot, UserSettings } from '../shared/types'
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
let updateListener: ((snapshot: UpdateSnapshot) => void) | undefined

const READY_SNAPSHOT: UpdateSnapshot = {
  status: 'idle',
  channel: 'stable',
  currentVersion: '0.7.0',
  cliBootstrapRequired: false,
}

function bootstrapDownloadingSnapshot(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    status: 'downloading',
    target: 'cli',
    channel: 'stable',
    currentVersion: '0.7.0',
    cliAvailableVersion: '0.15.9',
    cliBootstrapRequired: true,
    bootstrapStage: 'runtime',
    percent: 37,
    ...overrides,
  }
}

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
    getUpdateStatus: vi.fn(async () => READY_SNAPSHOT),
    onUpdateStatus: vi.fn((callback: (snapshot: UpdateSnapshot) => void) => {
      updateListener = callback
      return unsubscribe
    }),
    onAgentEvent: vi.fn(() => unsubscribe),
    onVideoOcrRequest: vi.fn(() => unsubscribe),
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
  const bridge = createLockedBridge()
  ;(window as unknown as { verboo: unknown }).verboo = bridge
  render(<App />)
}

function emitLoginEvent(payload: LoginEvent) {
  const call = vi.mocked(listen).mock.calls.find(([name]) => name === 'login:event')
  expect(call, 'App must mount the real LoginScreen login:event listener').toBeDefined()
  act(() => {
    const handler = call![1] as (event: { payload: LoginEvent }) => void
    handler({ payload })
  })
}

beforeEach(() => {
  // Deliberately EMPTY: no 'verboo:development-notice-accepted', no remembered
  // session. The first-boot state is the state under test.
  window.localStorage.clear()
  vi.mocked(listen).mockClear()
  updateListener = undefined
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

describe('App login — session-invalid boot and revalidation state', () => {
  it('boot without credentials renders the typed no-session result as a localized neutral note', async () => {
    settingsStore = { ...baseSettings(), language: 'pt-BR' }
    const bridge = createLockedBridge()
    bridge.listModels = vi.fn(async () => ({
      models: [],
      source: 'none' as const,
      stale: false,
      error: 'Entre com Verboo pelo CLI/app ou configure uma chave API.',
    }))
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    const note = await screen.findByText('Nenhuma sessão Verboo válida foi encontrada.')
    expect(note.className).toBe('login-empty')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // PA-47 (field video, logged-out cold start): the boot retry clears the
  // structured authError first, so during its in-flight window the ONLY
  // thing that could paint red is the raw modelResult.error fallback —
  // the user saw that flash ('Entre com Verboo pelo CLI/app...' + 'Tentar
  // de novo') for ~1s between the two validations. While `checking` is
  // true the surface must stay progress/neutral; the banner can only
  // appear after the verification settles.
  it('boot revalidation NEVER renders the modelResult.error banner while checking (cold-retry window)', async () => {
    settingsStore = { ...baseSettings(), language: 'pt-BR' }
    const bridge = createLockedBridge()
    let calls = 0
    let releaseRetry: (result: unknown) => void = () => {}
    const retryGate = new Promise<unknown>(resolve => {
      releaseRetry = resolve
    })
    const failingDiscovery = () => ({
      models: [] as never[],
      source: 'none' as const,
      stale: false,
      error: 'Entre com Verboo pelo CLI/app para atualizar os modelos da sua conta.',
    })
    bridge.listModels = vi.fn(async () => {
      calls += 1
      if (calls === 1) return failingDiscovery()
      // The retry hangs so the transient checking state is observable.
      return retryGate
    })
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    // First cold validation settles → NEUTRAL no-session note, no banner.
    const note = await screen.findByText('Nenhuma sessão Verboo válida foi encontrada.')
    expect(note.className).toBe('login-empty')
    expect(screen.queryByRole('alert')).toBeNull()

    // The 700ms cold-start retry fires and starts a SECOND validation
    // against a hanging listModels — checking stays in flight.
    await waitFor(() => expect(calls).toBe(2), { timeout: 3_000 })

    // THE TRANSIENT WINDOW: authError was cleared, checking is true, and
    // modelResult still carries the raw first-failure error. Falling back
    // to modelResult.error MUST NOT paint a red banner here — the correct
    // state is the progress note.
    await screen.findByText('Validando credenciais e modelos disponíveis...')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.login-warning')).toBeNull()

    // The retry settles as no-session too — final state is the neutral
    // note again, still no banner.
    await act(async () => {
      releaseRetry(failingDiscovery())
    })
    const finalNote = await screen.findByText('Nenhuma sessão Verboo válida foi encontrada.')
    expect(finalNote.className).toBe('login-empty')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('"I already authenticated" ending without a session shows action feedback instead of the passive note', async () => {
    await renderLockedApp()
    const retry = await screen.findByRole('button', { name: /I already authenticated/ }, { timeout: 1_000 })
    await waitFor(() => {
      expect((retry as HTMLButtonElement).disabled, document.querySelector('.login-panel')?.textContent).toBe(false)
    }, { timeout: 1_000 })

    fireEvent.click(retry)
    await waitFor(() => {
      expect(screen.queryByRole('alert'), document.querySelector('.login-panel')?.textContent).not.toBeNull()
    }, { timeout: 1_000 })
    const alert = screen.getByRole('alert')

    expect(alert.textContent).toContain('Could not verify your Verboo session.')
    expect(screen.queryByText('No valid Verboo session was found.')).toBeNull()
  })

  it('successful CLI completion followed by no session shows action feedback', async () => {
    const bridge = createLockedBridge()
    bridge.startCliLogin = vi.fn(async () => ({ ok: true, message: 'CLI login started.' }))
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    const start = await screen.findByRole('button', { name: /Sign in with CLI/ })
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(start)
    await screen.findByText('Login started — waiting for the browser…')

    emitLoginEvent({ kind: 'complete', ok: true, status: { loggedIn: true } })

    // onLoginComplete retries validateAccess twice (500ms + 1500ms) before
    // LoginScreen can fail the user action and paint the alert.
    const alert = await screen.findByRole('alert', {}, { timeout: 5_000 })
    expect(alert.textContent).toContain('Could not complete CLI sign-in.')
    expect(screen.queryByText('No valid Verboo session was found.')).toBeNull()
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

  it('pt-BR: getCredentialStatus rejecting with secret_service_unavailable uses the full i18n headline, never the raw code', async () => {
    settingsStore = { ...baseSettings(), language: 'pt-BR' }
    const bridge = createLockedBridge()
    bridge.getCredentialStatus = vi.fn(async () => {
      throw new Error('secret_service_unavailable')
    })
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    const retry = await screen.findByRole('button', { name: /Já autentiquei/ })
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(retry)
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /Já autentiquei/ }) as HTMLButtonElement).disabled).toBe(false)
    })

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('coleção Default')
    expect(alert.textContent).not.toContain('secret_service_unavailable')
    expect(alert.textContent).not.toContain('Não foi possível verificar sua sessão do Verboo.')
    expect(alert.querySelector('details')).toBeNull()
  })
})

describe('healthy CLI bootstrap on the login surface (win32/darwin/linux)', () => {
  function createBootstrapBridge(platform: string, overrides: { deferredUpdateStatus?: boolean } = {}) {
    const bridge = createLockedBridge()
    bridge.getConfig = vi.fn(async () => ({ workingDirectory: '', accessMode: 'approval', platform }))
    if (overrides.deferredUpdateStatus) {
      // Authoritative snapshot never arrives within the test window.
      bridge.getUpdateStatus = vi.fn(() => new Promise<UpdateSnapshot>(() => {}))
    } else {
      bridge.getUpdateStatus = vi.fn(async () => bootstrapDownloadingSnapshot())
    }
    // Bootstrap stays in flight for the whole scenario — never resolves.
    bridge.bootstrapCli = vi.fn(() => new Promise<UpdateSnapshot>(() => {}))
    // If any CLI login path fires during bootstrap, this test FAILS loudly.
    bridge.startCliLogin = vi.fn(async () => {
      throw new Error('startCliLogin must not fire while CLI bootstrap is pending')
    })
    return bridge
  }

  async function renderBootstrapApp(bridge: ReturnType<typeof createLockedBridge>) {
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)
    // The preparation card replaces the CLI controls while the download runs.
    await screen.findByText('Preparing Verboo')
  }

  it.each(['win32', 'darwin', 'linux'])('healthy download shows preparation, never an error, and latches CLI actions (%s)', async platform => {
    const bridge = createBootstrapBridge(platform)
    await renderBootstrapApp(bridge)

    // Real preparation presentation: the existing gate card vocabulary…
    expect(document.querySelector('.login-cli-bootstrap .cli-bootstrap-card')).toBeTruthy()
    expect(screen.getByText('37%')).toBeTruthy()
    // …never an error banner while the bootstrap is healthy.
    expect(screen.queryByRole('alert')).toBeNull()

    // CLI actions are latched: the primary control is REPLACED by the
    // preparation card (nothing to click), the secondary revalidation is
    // disabled, and the startCliLogin spy stays untouched even if a click
    // is force-fired at the surface.
    expect(screen.queryByRole('button', { name: /Sign in with CLI/ })).toBeNull()
    const already = screen.getByRole('button', { name: /I already authenticated/ })
    expect(already).toHaveProperty('disabled', true)
    fireEvent.click(already)
    await act(async () => {})
    expect(bridge.startCliLogin).not.toHaveBeenCalled()

    // Non-CLI paths stay reachable: the API key entry point works.
    const apiKeyButton = screen.getByRole('button', { name: /Use an API key/ })
    expect(apiKeyButton).toHaveProperty('disabled', false)
    fireEvent.click(apiKeyButton)
    expect(await screen.findByLabelText(/API key/i)).toBeTruthy()
  })

  it('API key unlocks the app while the bootstrap continues; the post-login gate stays up', async () => {
    const bridge = createBootstrapBridge('darwin')
    bridge.sendTurn = vi.fn(async () => 'turn:never')
    // The api-key catalog only exists AFTER the key is saved — the boot-time
    // validation (and its 700ms B1 retry) must keep seeing an empty machine,
    // otherwise the app self-unlocks before this scenario clicks anything.
    let apiKeySaved = false
    bridge.listModels = vi.fn(async () => {
      if (!apiKeySaved) return { models: [], source: 'none' as const, stale: false }
      return {
        models: [{ id: 'model-1', displayName: 'Test model', raw: {} }],
        source: 'api-key' as const,
        stale: false,
      }
    })
    bridge.setApiKey = vi.fn(async () => {
      apiKeySaved = true
      return { hasApiKey: true, apiKeyHint: '…1234' }
    })
    await renderBootstrapApp(bridge)
    fireEvent.click(screen.getByRole('button', { name: /Use an API key/ }))
    fireEvent.change(await screen.findByLabelText(/API key/i), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByRole('button', { name: /Save|Salvar/ }))
    // Entry unlocked on the REAL api-key catalog while bootstrap still runs…
    await waitFor(() => expect(screen.queryByRole('button', { name: /Sign in with CLI/ })).toBeNull())
    // The live snapshot stream keeps feeding BOTH gates: stage cli arrives
    // while the user is already inside the app.
    act(() => {
      updateListener?.(bootstrapDownloadingSnapshot({ bootstrapStage: 'cli', percent: 64 }))
    })
    expect(await screen.findByText('Installing the Verboo CLI')).toBeTruthy()
    expect(document.querySelector('.cli-bootstrap-gate')).toBeTruthy()
    // …and no turn may start from the blocked agent surface.
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  it('stage and percent updates stream into the preparation card, then success releases CLI login after the flash', async () => {
    const bridge = createBootstrapBridge('darwin')
    bridge.startCliLogin = vi.fn(async () => ({ ok: true, message: 'CLI login started.' }))
    await renderBootstrapApp(bridge)

    // Stage transition runtime -> cli arrives through the live snapshot…
    act(() => {
      updateListener?.(bootstrapDownloadingSnapshot({ bootstrapStage: 'cli', percent: 88 }))
    })
    expect(await screen.findByText('Installing the Verboo CLI')).toBeTruthy()
    expect(screen.getByText('88%')).toBeTruthy()

    // …and completion flips required=false: existing success flash, then
    // the CLI login controls release after the timer.
    act(() => {
      updateListener?.({ ...bootstrapDownloadingSnapshot(), status: 'idle', cliBootstrapRequired: false })
    })
    expect(await screen.findByText('Verboo is ready')).toBeTruthy()

    // After the 1.4s success flash the primary control comes back armed…
    const signIn = await screen.findByRole('button', { name: /Sign in with CLI/ }, { timeout: 3_000 })
    await waitFor(() => expect(signIn).toHaveProperty('disabled', false))
    fireEvent.click(signIn)
    expect(await screen.findByText('Login started — waiting for the browser…')).toBeTruthy()
    expect(bridge.startCliLogin).toHaveBeenCalledTimes(1)
  })

  it('a real bootstrap error surfaces the alert with Retry; the API key path stays usable', async () => {
    const bridge = createLockedBridge()
    bridge.getUpdateStatus = vi.fn(async () =>
      bootstrapDownloadingSnapshot({ status: 'error' as const, error: 'network down' }),
    )
    bridge.bootstrapCli = vi.fn(async () => bootstrapDownloadingSnapshot())
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't prepare Verboo")
    // Containment: the login-surface Retry lives INSIDE the shared card.
    const retry = await screen.findByRole('button', { name: /Try again/ })
    expect(retry.closest('.cli-bootstrap-card')).toBeTruthy()
    fireEvent.click(retry)
    await waitFor(() => expect(bridge.bootstrapCli).toHaveBeenCalledTimes(1))
    // Error recovery does not take the non-CLI paths hostage.
    expect(await screen.findByText('Preparing Verboo')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Use an API key/ }))
    expect(await screen.findByLabelText(/API key/i)).toBeTruthy()
  })

  it('deferred update status: honest checking state latches CLI without download claims (darwin)', async () => {
    const bridge = createBootstrapBridge('darwin', { deferredUpdateStatus: true })
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    // Honest neutral presentation — no installing/download copy.
    const container = await screen.findByText(
      'Verboo is checking the local setup. CLI sign-in stays paused until preparation is complete.',
    )
    expect(screen.getByText('Checking Verboo')).toBeTruthy()
    expect(container.closest('.login-cli-bootstrap')).toBeTruthy()
    expect(container.closest('.login-cli-bootstrap')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText('Installing the Verboo CLI')).toBeNull()
    expect(screen.queryByText(/download/i)).toBeNull()

    // CLI actions stay latched; non-CLI paths stay reachable.
    expect(screen.queryByRole('button', { name: /Sign in with CLI/ })).toBeNull()
    const already = screen.getByRole('button', { name: /I already authenticated/ })
    expect(already).toHaveProperty('disabled', true)
    const apiKeyButton = screen.getByRole('button', { name: /Use an API key/ })
    expect(apiKeyButton).toHaveProperty('disabled', false)
  })

  it('a late initial getUpdateStatus rejection cannot override an authoritative live snapshot', async () => {
    let rejectInitial: (reason: unknown) => void = () => {}
    const unsubscribe = () => {}
    const bridge = createLockedBridge()
    bridge.getUpdateStatus = vi.fn(() => new Promise<UpdateSnapshot>((_resolve, reject) => {
      rejectInitial = reject
    }))
    bridge.onUpdateStatus = vi.fn((callback: (snapshot: UpdateSnapshot) => void) => {
      updateListener = callback
      return unsubscribe
    })
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    // The live event stream delivers an authoritative downloading snapshot…
    act(() => {
      updateListener?.(bootstrapDownloadingSnapshot({ bootstrapStage: 'runtime', percent: 37 }))
    })
    expect(await screen.findByText('Preparing Verboo')).toBeTruthy()
    expect(screen.getByText('37%')).toBeTruthy()

    // …and only THEN the stale initial promise rejects. The snapshot is the
    // authority: the presentation must stay installing, never paint the
    // late error.
    await act(async () => {
      rejectInitial(new Error('late initial crash'))
    })
    expect(screen.getByText('Preparing Verboo')).toBeTruthy()
    expect(screen.getByText('37%')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('deferred status + valid API key: unlocked shell stays gated on checking with zero turns', async () => {
    const bridge = createBootstrapBridge('darwin', { deferredUpdateStatus: true })
    let apiKeySaved = false
    bridge.listModels = vi.fn(async () => {
      if (!apiKeySaved) return { models: [], source: 'none' as const, stale: false }
      return {
        models: [{ id: 'model-1', displayName: 'Test model', raw: {} }],
        source: 'api-key' as const,
        stale: false,
      }
    })
    bridge.setApiKey = vi.fn(async () => {
      apiKeySaved = true
      return { hasApiKey: true, apiKeyHint: '…1234' }
    })
    bridge.sendTurn = vi.fn(async () => 'turn:never')
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)
    // With the initial read deferred, the surface shows the honest checking
    // card — NOT any installing/download copy.
    await screen.findByText('Checking Verboo')
    fireEvent.click(screen.getByRole('button', { name: /Use an API key/ }))
    fireEvent.change(await screen.findByLabelText(/API key/i), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getByRole('button', { name: /Save|Salvar/ }))

    // The shell mounts, but the GATE STAYS: checking copy, composer latched.
    await screen.findByText('Checking Verboo')
    expect(document.querySelector('.cli-bootstrap-gate')).toBeTruthy()
    expect(document.querySelector('.cli-bootstrap-gate .cli-bootstrap-card--checking')).toBeTruthy()
    const composer = document.querySelector('.composer textarea') as HTMLTextAreaElement | null
      ?? document.querySelector('textarea')
    expect(composer).toBeTruthy()
    expect(composer!.disabled).toBe(true)
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  it('a rejected getUpdateStatus is a REAL localized bootstrap error with working Retry', async () => {
    const bridge = createBootstrapBridge('linux', { deferredUpdateStatus: true })
    bridge.getUpdateStatus = vi.fn(() => Promise.reject(new Error('update service crashed')))
    let bootstrapSettled: (snapshot: UpdateSnapshot) => void = () => {}
    bridge.bootstrapCli = vi.fn(() => new Promise<UpdateSnapshot>(resolve => {
      bootstrapSettled = resolve
    }))
    ;(window as unknown as { verboo: unknown }).verboo = bridge
    render(<App />)

    // Localized bootstrap alert with the REAL cause behind the card…
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't prepare Verboo")
    expect(alert.textContent).toContain('update service crashed')
    // …and Retry re-invokes bootstrapCli and returns to a healthy state.
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(bridge.bootstrapCli).toHaveBeenCalledTimes(1))
    act(() => {
      bootstrapSettled(bootstrapDownloadingSnapshot({ bootstrapStage: 'cli', percent: 12 }))
    })
    await screen.findByText('Installing the Verboo CLI')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
