import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { AvailablePlugin } from '../../../shared/plugins'
import { usePlugins } from './usePlugins'

// ── Mocks ──────────────────────────────────────────────────────────────
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: () => {} }) }))

// ── Tauri event listener mock (Feedback-6 OBJ 1) ─────────────────────
// `listen` from @tauri-apps/api/event returns a Promise<UnlistenFn>.
// We capture the handler so the test can dispatch a synthetic event and
// assert refreshAll fires; unlisten is tracked to assert cleanup.
let capturedHandler: (() => void) | undefined
const mockUnlisten = vi.fn()
const mockListen = vi.fn().mockImplementation((_event: string, handler: () => void) => {
  capturedHandler = handler
  return Promise.resolve(mockUnlisten)
})
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => mockListen(...args) }))

const mockPluginList = vi.fn()
const mockPluginAvailable = vi.fn()
const mockMarketplaceList = vi.fn()
const mockMarketplaceManifests = vi.fn()
const mockPluginInstall = vi.fn()
const mockPluginUninstall = vi.fn()
const mockPluginEnable = vi.fn()
const mockPluginDisable = vi.fn()
const mockPluginValidate = vi.fn()

const mockWindow = {
  pluginList: mockPluginList,
  pluginAvailable: mockPluginAvailable,
  marketplaceList: mockMarketplaceList,
  marketplaceManifests: mockMarketplaceManifests,
  pluginInstall: mockPluginInstall,
  pluginUninstall: mockPluginUninstall,
  pluginEnable: mockPluginEnable,
  pluginDisable: mockPluginDisable,
  pluginValidate: mockPluginValidate,
} as any

beforeEach(() => {
  vi.clearAllMocks()
  // Default: backend returns empty lists, no marketplaces
  mockPluginList.mockResolvedValue([])
  mockPluginAvailable.mockResolvedValue({ available: [], installed: [] })
  mockMarketplaceList.mockResolvedValue([])
  mockMarketplaceManifests.mockResolvedValue({})
  // Default mutation success
  mockPluginInstall.mockResolvedValue({ success: true })
  mockPluginUninstall.mockResolvedValue({ success: true })
  mockPluginEnable.mockResolvedValue({ success: true })
  mockPluginDisable.mockResolvedValue({ success: true })

  ;(window as any).verboo = mockWindow
})

const dummyPlugin: AvailablePlugin = {
  pluginId: 'test@verboo-plugins',
  name: 'Test Plugin',
  description: 'A test plugin',
  marketplaceName: 'verboo-plugins',
  source: 'marketplace',
  installCount: 42,
}

describe('install — MutationResult contract', () => {
  it('(i) success → optimistic entry in installed list immediately', async () => {
    const testPlugin = {
      id: 'test@verboo-plugins',
      name: 'Test Plugin',
      enabled: true,
      installed: true,
      version: '1.0', scope: 'user' as const,
      installPath: '/test', installedAt: 'now', lastUpdated: 'now',
      description: 'A test plugin',
    }
    // refreshAll will call pluginList — return the optimistic entry from
    // the handler's background refreshAll so it persists.
    mockPluginList.mockResolvedValue([testPlugin])

    const { result } = renderHook(() => usePlugins())

    // Install resolves with success: true
    await act(async () => {
      await result.current.install(dummyPlugin, 'user')
    })

    await waitFor(() => {
      expect(result.current.installed.some(p => p.id === 'test@verboo-plugins')).toBe(true)
    })
    expect(mockPluginInstall).toHaveBeenCalledWith('test@verboo-plugins', 'user')
  })

  it('(ii) success:false → reverts optimistic + error thrown', async () => {
    mockPluginInstall.mockResolvedValue({
      success: false,
      exitCode: 1,
      error: { kind: 'unknown', message: 'Integrity check failed' },
    })

    const { result } = renderHook(() => usePlugins())

    await act(async () => {
      try {
        await result.current.install(dummyPlugin, 'user')
        // Should not reach here — the error should be thrown
        expect(true).toBe(false) // should not reach
      } catch (err: any) {
        expect(err.message).toBe('Integrity check failed')
      }
    })

    // Reverted: plugin no longer in installed list
    expect(result.current.installed.some(p => p.id === 'test@verboo-plugins')).toBe(false)
  })

  it('(iii) IPC rejection → reverts optimistic + error thrown', async () => {
    mockPluginInstall.mockRejectedValue(new Error('IPC transport error'))

    const { result } = renderHook(() => usePlugins())

    await act(async () => {
      try {
        await result.current.install(dummyPlugin, 'user')
        expect(true).toBe(false) // should not reach
      } catch (err: any) {
        expect(err.message).toContain('IPC transport error')
      }
    })

    // Reverted
    await waitFor(() => {
      expect(result.current.installed.some(p => p.id === 'test@verboo-plugins')).toBe(false)
    })
  })
})

describe('uninstall — MutationResult contract', () => {
  it('(i) success → removes from installed list immediately', async () => {
    const testPlugin = {
      id: 'test@verboo-plugins',
      name: 'Test Plugin',
      enabled: true,
      installed: true,
      version: '1.0', scope: 'user' as const,
      installPath: '/test', installedAt: 'now', lastUpdated: 'now',
    }
    // First call (initial refreshAll) gets the plugin. Subsequent calls
    // (from handler's refreshAll) return [] so the optimistic removal sticks.
    mockPluginList.mockResolvedValueOnce([testPlugin])
    mockPluginList.mockResolvedValue([])

    const { result } = renderHook(() => usePlugins())

    // Wait for initial refreshAll to populate the list
    await waitFor(() => {
      expect(result.current.installed).toHaveLength(1)
    })

    await act(async () => {
      await result.current.uninstall('test@verboo-plugins', 'user')
    })

    // Optimistic removal + background refreshAll both result in empty list.
    await waitFor(() => {
      expect(result.current.installed.some(p => p.id === 'test@verboo-plugins')).toBe(false)
    })
    expect(mockPluginUninstall).toHaveBeenCalledWith('test@verboo-plugins', 'user', false)
  })

  it('(ii) success:false → error thrown', async () => {
    mockPluginList.mockResolvedValue([{
      id: 'test@verboo-plugins',
      name: 'Test Plugin',
      enabled: true,
      installed: true,
      version: '1.0', scope: 'user',
      installPath: '/test', installedAt: 'now', lastUpdated: 'now',
    }])
    mockPluginUninstall.mockResolvedValue({
      success: false,
      exitCode: 1,
      error: { kind: 'unknown', message: 'Uninstall rejected' },
    })

    const { result } = renderHook(() => usePlugins())
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    await act(async () => {
      try {
        await result.current.uninstall('test@verboo-plugins', 'user')
        expect(true).toBe(false) // should not reach
      } catch (err: any) {
        expect(err.message).toBe('Uninstall rejected')
      }
    })
  })
})

describe('revert preserves list position (anti-flicker)', () => {
  it('install revert removes only the optimistic entry — siblings keep their order', async () => {
    // Two plugins already installed. Install a third optimistically, then
    // success:false reverts. The two pre-existing entries must remain in
    // the same order (no reshuffle from the revert setState).
    const p1 = { id: 'a@verboo-plugins', name: 'A', enabled: true, installed: true, version: '1', scope: 'user' as const, installPath: '/a', installedAt: 'now', lastUpdated: 'now' }
    const p2 = { id: 'b@verboo-plugins', name: 'B', enabled: true, installed: true, version: '1', scope: 'user' as const, installPath: '/b', installedAt: 'now', lastUpdated: 'now' }
    mockPluginList.mockResolvedValue([p1, p2])
    mockPluginInstall.mockResolvedValue({ success: false, exitCode: 1, error: { kind: 'unknown', message: 'fail' } })

    const { result } = renderHook(() => usePlugins())
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    const beforeIds = result.current.installed.map(p => p.id)
    expect(beforeIds).toEqual(['a@verboo-plugins', 'b@verboo-plugins'])

    await act(async () => {
      try { await result.current.install(dummyPlugin, 'user') } catch { /* expected */ }
    })

    // Revert removed the optimistic entry; pre-existing order preserved.
    const afterIds = result.current.installed.map(p => p.id)
    expect(afterIds).toEqual(['a@verboo-plugins', 'b@verboo-plugins'])
  })

  it('uninstall revert restores the plugin — refreshAll does not reshuffle siblings', async () => {
    // Three plugins installed. Uninstall the middle one optimistically,
    // success:false reverts via refreshAll. The refreshAll returns the
    // canonical list (p1, p2, p3) — order must match the backend's order,
    // not reshuffle.
    const p1 = { id: 'a@verboo-plugins', name: 'A', enabled: true, installed: true, version: '1', scope: 'user' as const, installPath: '/a', installedAt: 'now', lastUpdated: 'now' }
    const p2 = { id: 'b@verboo-plugins', name: 'B', enabled: true, installed: true, version: '1', scope: 'user' as const, installPath: '/b', installedAt: 'now', lastUpdated: 'now' }
    const p3 = { id: 'c@verboo-plugins', name: 'C', enabled: true, installed: true, version: '1', scope: 'user' as const, installPath: '/c', installedAt: 'now', lastUpdated: 'now' }
    // Initial list has all three; post-uninstall refreshAll returns all three
    // (because the uninstall failed, the backend still has p2).
    mockPluginList.mockResolvedValue([p1, p2, p3])
    mockPluginUninstall.mockResolvedValue({ success: false, exitCode: 1, error: { kind: 'unknown', message: 'fail' } })

    const { result } = renderHook(() => usePlugins())
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })

    await act(async () => {
      try { await result.current.uninstall('b@verboo-plugins', 'user') } catch { /* expected */ }
    })

    // After revert + refreshAll, the list is back to [p1, p2, p3] in order.
    await waitFor(() => {
      expect(result.current.installed.map(p => p.id)).toEqual(['a@verboo-plugins', 'b@verboo-plugins', 'c@verboo-plugins'])
    })
  })
})

describe('plugin-mutation listener (OBJ 1 fix)', () => {
  beforeEach(() => {
    capturedHandler = undefined
    vi.clearAllMocks()
    mockPluginList.mockResolvedValue([])
    mockPluginAvailable.mockResolvedValue({ available: [], installed: [] })
    mockMarketplaceList.mockResolvedValue([])
    mockMarketplaceManifests.mockResolvedValue({})
    ;(window as any).verboo = mockWindow
  })

  it('emitted event triggers refreshAll (pluginList called)', async () => {
    mockPluginList.mockResolvedValue([])
    renderHook(() => usePlugins())

    // Wait for mount (initial refreshAll)
    await waitFor(() => expect(mockPluginList).toHaveBeenCalled())

    // Reset call count so we can assert the event fired a new refreshAll
    mockPluginList.mockClear()

    // Dispatch synthetic plugin-mutation event
    await act(async () => { capturedHandler?.() })

    await waitFor(() => expect(mockPluginList).toHaveBeenCalled())
  })

  it('unmount removes listener', async () => {
    mockPluginList.mockResolvedValue([])
    const { unmount } = renderHook(() => usePlugins())
    await waitFor(() => expect(mockPluginList).toHaveBeenCalled())

    unmount()

    await waitFor(() => expect(mockUnlisten).toHaveBeenCalled())
  })
})
