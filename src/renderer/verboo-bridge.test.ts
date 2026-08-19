/**
 * Regression tests for verboo-bridge.ts — the Tauri shim for window.verboo.
 *
 * The shim is the single load-bearing piece that lets the renderer run
 * unchanged under both Electron (preload owns window.verboo) and Tauri
 * (this shim owns window.verboo). These tests pin the contract so a
 * future refactor can't silently break the IS_TAURI guard or the API
 * surface that the renderer depends on.
 *
 * What's tested:
 *   - IS_TAURI guard: in a non-Tauri jsdom env, window.verboo must NOT
 *     be overwritten (the preload owns it). This is the exact bug that
 *     broke the Electron build when the shim was first added.
 *   - API shape: every method the renderer calls must exist on the
 *     exported api object. A missing method would surface as a runtime
 *     TypeError in the renderer, not a build error.
 *
 * Critical intent-bearing invoke payloads and event channel wiring are also
 * pinned here because changing either silently changes updater behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { VerbooDesktopApi } from './verboo-bridge'

// Mock @tauri-apps/api before importing the shim — otherwise the shim
// calls getCurrentWebview() at module load, which throws in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve({})),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  }),
}))

describe('verboo-bridge — IS_TAURI guard', () => {
  let originalInternals: PropertyDescriptor | undefined
  let originalVerboo: unknown

  beforeEach(() => {
    // Save and clear window.verboo so each test starts clean.
    originalVerboo = (window as unknown as Record<string, unknown>).verboo
    delete (window as unknown as Record<string, unknown>).verboo
    // Save and remove __TAURI_INTERNALS__ so jsdom looks like Electron.
    originalInternals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    // Clear the module cache so the shim re-evaluates IS_TAURI.
    vi.resetModules()
  })

  afterEach(() => {
    // Restore window.verboo and __TAURI_INTERNALS__.
    if (originalVerboo !== undefined) {
      ;(window as unknown as Record<string, unknown>).verboo = originalVerboo
    } else {
      delete (window as unknown as Record<string, unknown>).verboo
    }
    if (originalInternals) {
      Object.defineProperty(window, '__TAURI_INTERNALS__', originalInternals)
    } else {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
    vi.resetModules()
  })

  it('does NOT set window.verboo when __TAURI_INTERNALS__ is absent (Electron env)', async () => {
    // Electron env: no __TAURI_INTERNALS__. The shim must be a no-op so
    // it doesn't clobber the preload's window.verboo.
    expect('__TAURI_INTERNALS__' in window).toBe(false)
    await import('./verboo-bridge')
    expect((window as unknown as Record<string, unknown>).verboo).toBeUndefined()
  })

  it('DOES set window.verboo when __TAURI_INTERNALS__ is present (Tauri env)', async () => {
    // Tauri env: __TAURI_INTERNALS__ exists. The shim must own window.verboo.
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    await import('./verboo-bridge')
    expect((window as unknown as Record<string, unknown>).verboo).toBeDefined()
    expect(typeof (window as unknown as Record<string, unknown>).verboo).toBe('object')
  })
})

describe('verboo-bridge — API shape', () => {
  // Import once with Tauri internals present so the api object is built.
  // We don't re-import per test — the shape is static.
  // We intentionally avoid referencing the unexported `VerbooDesktopApi`
  // type here; the API surface is checked dynamically by name.
  let api: Record<string, unknown> | undefined

  beforeEach(async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    vi.resetModules()
    vi.mocked(invoke).mockClear()
    await import('./verboo-bridge')
    api = (window as unknown as { verboo?: Record<string, unknown> }).verboo
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    delete (window as unknown as Record<string, unknown>).verboo
    vi.resetModules()
  })

  it('exposes every config/auth/credentials method the renderer calls', () => {
    expect(api).toBeDefined()
    const required = [
      'getConfig',
      'startCliLogin',
      'getCliAuthStatus',
      'logout',
      'openDashboard',
      'openSubscriptions',
      'openSignup',
      'getCredentialStatus',
      'setApiKey',
      'clearApiKey',
      'checkWindowsLoginPrereqs',
      'installGitWindows',
    ] as const
    for (const name of required) {
      expect(typeof (api as Record<string, unknown> | undefined)?.[name]).toBe('function')
    }
  })

  // Issue #71 (contrato-71-gitbash): the command names are the
  // cross-fence contract with Rust — a rename on either side is a
  // runtime-only failure, so the exact strings are pinned here.
  it('maps the Windows Git onboarding commands verbatim (issue #71 contract)', async () => {
    expect(api).toBeDefined()
    vi.mocked(invoke).mockClear()
    const auth = api as Record<string, () => Promise<unknown>>
    await auth.checkWindowsLoginPrereqs()
    await auth.installGitWindows()
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['check_windows_login_prereqs'],
      ['install_git_windows'],
    ])
  })

  it('exposes every models/profile/feedback method', () => {
    expect(api).toBeDefined()
    const required = [
      'listModels',
      'getProfile',
      'sendFeedback',
    ] as const
    for (const name of required) {
      expect(typeof (api as Record<string, unknown> | undefined)?.[name]).toBe('function')
    }
  })

  it('forwards the versioned provider account commands with sanitized camelCase payloads', async () => {
    expect(api).toBeDefined()
    vi.mocked(invoke).mockClear()
    const providers = api as Record<string, (...args: unknown[]) => Promise<unknown>>
    await providers.providerCapabilities()
    await providers.providerAccountsList()
    await providers.providerAccountsUsage('codex', 'local-a')
    await providers.providerAccountModels('codex', 'local-a')
    await providers.providerAccountSetDefault('codex', 'local-a')
    await providers.providerAccountRemove('codex', 'local-a')
    await providers.providerLoginStart('codex', 'local-a')

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['provider_capabilities'],
      ['provider_accounts_list'],
      ['provider_accounts_usage', { provider: 'codex', accountId: 'local-a' }],
      ['provider_account_models', { provider: 'codex', accountId: 'local-a' }],
      ['provider_account_set_default', { provider: 'codex', accountId: 'local-a' }],
      ['provider_account_remove', { provider: 'codex', accountId: 'local-a' }],
      ['provider_login_start', { provider: 'codex', reconnectAccountId: 'local-a' }],
    ])
  })

  // B1 — provider_accounts_usage requires both provider and accountId at the
  // type level. The Rust command (provider_accounts.rs:286-321) returns
  // `provider_argument_required` if either is missing, so the renderer type
  // must not advertise an optional signature that the backend rejects.
  it('B1: providerAccountsUsage requires both provider and accountId', async () => {
    expect(api).toBeDefined()
    if (!api) return
    const providers = api as VerbooDesktopApi
    // @ts-expect-error — calling without arguments must be a type error.
    await providers.providerAccountsUsage()
    // @ts-expect-error — calling with only the provider must be a type error.
    await providers.providerAccountsUsage('codex')
    // OK: both arguments present.
    await providers.providerAccountsUsage('codex', 'local-a')
  })

  it('exposes every settings/menu/window/skills method', () => {
    expect(api).toBeDefined()
    const required = [
      'getUserSettings',
      'updateUserSettings',
      'resetUserSettings',
      'updateMenuBar',
      'forceIdleMenuBar',
      'heartbeatMenuBar',
      'toggleWindowZoom',
      'listSkills',
      'openUserSkillsFolder',
      'getDefaultWorkingDirectory',
      'getBundledCliVersion',
      'chromeIntegrationStatus',
      'chromeIntegrationConfigure',
      'chromeIntegrationRepair',
      'chromeIntegrationTest',
      'chromeIntegrationRemove',
      'openChromeExtensionStore',
    ] as const
    for (const name of required) {
      expect(typeof (api as Record<string, unknown> | undefined)?.[name]).toBe('function')
    }
  })

  it('maps Chrome integration controls to exact Tauri commands and payloads', async () => {
    const chrome = api as Record<string, (...args: unknown[]) => Promise<unknown>>
    const request = { developmentExtensionId: 'abcdefghijklmnopabcdefghijklmnop' }

    await chrome.chromeIntegrationStatus()
    await chrome.chromeIntegrationConfigure(request)
    await chrome.chromeIntegrationRepair(request)
    await chrome.chromeIntegrationTest()
    await chrome.chromeIntegrationRemove()
    await chrome.openChromeExtensionStore()

    expect(vi.mocked(invoke).mock.calls.slice(-6)).toEqual([
      ['chrome_integration_status'],
      ['chrome_integration_configure', { request }],
      ['chrome_integration_repair', { request }],
      ['chrome_integration_test'],
      ['chrome_integration_remove'],
      ['open_chrome_extension_store'],
    ])
  })

  it('exposes every workspace/files/agent method', () => {
    expect(api).toBeDefined()
    const required = [
      'getWorkspaceChanges',
      'getWorkspaceBranches',
      'switchWorkspaceBranch',
      'commitWorkspaceChanges',
      'createWorkspacePullRequest',
      'pushWorkspaceChanges',
      'recordFileRead',
      'recordFileWrite',
      'listStaleFiles',
      'clearStaleFiles',
      'evaluateGoal',
      'listWorkspaceFiles',
      'listProjectInstructionFiles',
      'readProjectInstructionFile',
      'writeProjectInstructionFile',
      'pickFiles',
      'inspectFiles',
      'inspectDroppedFiles',
      'beginPastedFileUpload',
      'appendPastedFileChunk',
      'finishPastedFileUpload',
      'abortPastedFileUpload',
      'pickFolder',
      'createProjectFolder',
      'sendTurn',
      'runResearchSubagents',
      'cancelResearchSubagents',
      'interrupt',
    ] as const
    for (const name of required) {
      expect(typeof (api as Record<string, unknown> | undefined)?.[name]).toBe('function')
    }
  })

  it('exposes every event subscription method', () => {
    expect(api).toBeDefined()
    const required = [
      'onAgentEvent',
      'onRefreshDataRequest',
      'onUpdateStatus',
      'onTerminalData',
      'onTerminalExit',
      'onTerminalError',
    ] as const
    for (const name of required) {
      expect(typeof (api as Record<string, unknown> | undefined)?.[name]).toBe('function')
    }
  })

  it('exposes every update/terminal/clipboard/review method', () => {
    expect(api).toBeDefined()
    const required = [
      'getUpdateStatus',
      'bootstrapCli',
      'checkForUpdates',
      'downloadUpdate',
      'installUpdate',
      'terminalStart',
      'terminalWrite',
      'terminalResize',
      'terminalStop',
      'terminalGetState',
      'clipboardReadText',
      'clipboardWriteText',
      'getWorkspaceReviewMetadata',
      'getFileDiff',
      'revertFile',
      'openExternalFile',
      'allowMediaPreviewFile',
    ] as const
    for (const name of required) {
      expect(typeof (api as Record<string, unknown> | undefined)?.[name]).toBe('function')
    }
  })

  it('distinguishes confirmed CLI downloads from app auto-downloads', async () => {
    expect(api).toBeDefined()
    const download = api?.downloadUpdate as (userInitiated?: boolean) => Promise<unknown>

    await download(false)
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('download_update', {
      userInitiated: false,
    })

    await download()
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('download_update', {
      userInitiated: true,
    })
  })

  it('authorizes one local media path before converting it for the webview', async () => {
    expect(api).toBeDefined()

    await (api as Record<string, (path: string) => Promise<unknown>>).allowMediaPreviewFile('/photos/reference.png')

    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('allow_media_preview_file', {
      path: '/photos/reference.png',
    })
  })

  it('routes first-install retry through the dedicated CLI bootstrap command', async () => {
    expect(api).toBeDefined()

    await (api as Record<string, () => Promise<unknown>>).bootstrapCli()

    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('bootstrap_cli')
  })

  it('returns a cleanup function from event subscriptions', async () => {
    expect(api).toBeDefined()
    // onAgentEvent returns a cleanup fn — calling it must not throw.
    const cleanup = (api as Record<string, (cb: () => void) => () => void>).onAgentEvent(() => {})
    expect(typeof cleanup).toBe('function')
    expect(() => cleanup()).not.toThrow()
  })

  it('subscribes update status to the backend snapshot event', () => {
    expect(api).toBeDefined()
    ;(api as Record<string, (cb: () => void) => () => void>).onUpdateStatus(() => {})
    expect(vi.mocked(listen)).toHaveBeenLastCalledWith(
      'update:snapshot',
      expect.any(Function),
    )
  })
})
