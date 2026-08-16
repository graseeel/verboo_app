/**
 * Shared test utilities for Verboo Code renderer integration tests.
 *
 * Provides common mock factories, typed invoke stubs, and render helpers
 * so individual test files stay focused on assertions rather than setup.
 */
import { vi, expect, type Mock } from 'vitest'
import type { VerbooModel, ModelDiscoveryResult, SkillSummary, ChromeIntegrationStatus } from '../../shared/types'

// ─── Tauri invoke mock ──────────────────────────────────────────────────────

export type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/** Create a typed Tauri invoke mock with optional per-command overrides. */
export function createInvokeMock(overrides?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>): InvokeFn {
  const invoke = vi.fn().mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (overrides && command in overrides) {
      const handler = overrides[command]
      return typeof handler === 'function' ? handler(args ?? {}) : handler
    }
    return undefined
  })
  return invoke as unknown as InvokeFn
}

/** Install global Tauri mocks (call in beforeEach or at module level). */
export function installTauriMocks(overrides?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  const invoke = createInvokeMock(overrides)
  vi.mock('@tauri-apps/api/core', () => ({ invoke }))
  vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn().mockResolvedValue(() => {}),
  }))
  return { invoke }
}

// ─── Window bridge mock ─────────────────────────────────────────────────────

export interface VerbooBridgeMock {
  pluginList: Mock
  pluginAvailable: Mock
  marketplaceList: Mock
  marketplaceManifests: Mock
  pluginInstall: Mock
  pluginUninstall: Mock
  pluginEnable: Mock
  pluginDisable: Mock
  pluginValidate: Mock
  listSkills: Mock
  openUserSkillsFolder: Mock
  checkSkillApproval: Mock
  approveSkill: Mock
  listModels: Mock
  getChromeIntegrationStatus: Mock
  chromeIntegrationConfigure: Mock
  chromeIntegrationTest: Mock
}

/** Create a comprehensive window.verboo bridge mock. */
export function createVerbooBridgeMock(overrides?: Partial<VerbooBridgeMock>): VerbooBridgeMock {
  const bridge: VerbooBridgeMock = {
    pluginList: vi.fn().mockResolvedValue([]),
    pluginAvailable: vi.fn().mockResolvedValue({ available: [], installed: [] }),
    marketplaceList: vi.fn().mockResolvedValue([]),
    marketplaceManifests: vi.fn().mockResolvedValue({}),
    pluginInstall: vi.fn().mockResolvedValue({ success: true }),
    pluginUninstall: vi.fn().mockResolvedValue({ success: true }),
    pluginEnable: vi.fn().mockResolvedValue({ success: true }),
    pluginDisable: vi.fn().mockResolvedValue({ success: true }),
    pluginValidate: vi.fn().mockResolvedValue({ valid: true }),
    listSkills: vi.fn().mockResolvedValue([]),
    openUserSkillsFolder: vi.fn().mockResolvedValue(undefined),
    checkSkillApproval: vi.fn().mockResolvedValue({ pending: [] }),
    approveSkill: vi.fn().mockResolvedValue({ success: true }),
    listModels: vi.fn().mockResolvedValue({ models: [], source: 'none', stale: false }),
    getChromeIntegrationStatus: vi.fn().mockResolvedValue(defaultChromeStatus()),
    chromeIntegrationConfigure: vi.fn().mockResolvedValue({ success: true }),
    chromeIntegrationTest: vi.fn().mockResolvedValue({ helper: true, extension: true, mcp: true }),
    ...overrides,
  }
  return bridge
}

/** Install window.verboo bridge mock globally. */
export function installVerbooBridge(overrides?: Partial<VerbooBridgeMock>) {
  const bridge = createVerbooBridgeMock(overrides)
  ;(window as any).verboo = bridge
  return bridge
}

// ─── Fixture factories ──────────────────────────────────────────────────────

export function makeModel(overrides?: Partial<VerbooModel>): VerbooModel {
  return {
    id: 'test-model-1',
    displayName: 'Test Model',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsVision: false,
    reasoning: undefined,
    raw: {},
    ...overrides,
  }
}

export function makeModelDiscoveryResult(overrides?: Partial<ModelDiscoveryResult>): ModelDiscoveryResult {
  return {
    models: [makeModel()],
    source: 'cli',
    stale: false,
    ...overrides,
  }
}

export function makeSkill(overrides?: Partial<SkillSummary>): SkillSummary {
  return {
    id: 'skill:test',
    name: 'test-skill',
    description: 'A test skill',
    path: '/skills/test/SKILL.md',
    source: 'user',
    trusted: true,
    ...overrides,
  }
}

export function defaultChromeStatus(overrides?: Partial<ChromeIntegrationStatus>): ChromeIntegrationStatus {
  return {
    extension: 'missing',
    bridge: 'missing',
    mcp: 'missing',
    connection: 'waitingForChrome',
    panelState: 'unknown',
    aggregate: 'notConfigured',
    installedVersion: undefined,
    availableVersion: '1.0.0',
    canConfigure: true,
    canRepair: false,
    canRemove: false,
    storeUrlAvailable: true,
    developmentBuild: false,
    extensionIdSource: 'none',
    ...overrides,
  }
}

// ─── Assertion helpers ──────────────────────────────────────────────────────

/** Assert that invoke was called with a specific command. */
export function expectInvokeCalled(invoke: Mock, command: string, times?: number) {
  const calls = invoke.mock.calls.filter((call: unknown[]) => call[0] === command)
  if (times !== undefined) {
    expect(calls).toHaveLength(times)
  } else {
    expect(calls.length).toBeGreaterThan(0)
  }
  return calls
}

/** Assert that invoke was NOT called with a specific command. */
export function expectInvokeNotCalled(invoke: Mock, command: string) {
  const calls = invoke.mock.calls.filter((call: unknown[]) => call[0] === command)
  expect(calls).toHaveLength(0)
}

/** Get the args of the first invoke call with a specific command. */
export function getInvokeArgs(invoke: Mock, command: string): Record<string, unknown> | undefined {
  const call = invoke.mock.calls.find((c: unknown[]) => c[0] === command)
  return call?.[1] as Record<string, unknown> | undefined
}
