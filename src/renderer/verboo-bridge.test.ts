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
 * What's NOT tested:
 *   - invoke() call payloads — those are integration tests (Tauri
 *     command layer) and belong in src-tauri/.
 *   - listen() event wiring — same reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
    ] as const
    for (const name of required) {
      expect(typeof (api as Record<string, unknown> | undefined)?.[name]).toBe('function')
    }
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
    ] as const
    for (const name of required) {
      expect(typeof (api as Record<string, unknown> | undefined)?.[name]).toBe('function')
    }
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
    ] as const
    for (const name of required) {
      expect(typeof (api as Record<string, unknown> | undefined)?.[name]).toBe('function')
    }
  })

  it('returns a cleanup function from event subscriptions', async () => {
    expect(api).toBeDefined()
    // onAgentEvent returns a cleanup fn — calling it must not throw.
    const cleanup = (api as Record<string, (cb: () => void) => () => void>).onAgentEvent(() => {})
    expect(typeof cleanup).toBe('function')
    expect(() => cleanup()).not.toThrow()
  })
})
