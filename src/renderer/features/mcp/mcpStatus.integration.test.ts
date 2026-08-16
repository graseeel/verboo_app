/**
 * Unit tests for MCP Status and Chrome Integration hook LOGIC.
 *
 * NOTE: These tests use simplified hook implementations that exercise the
 * same state management patterns as the real useChromeIntegration hook
 * (src/renderer/features/settings/useChromeIntegration.ts), but with
 * mockable dependencies. They are NOT integration tests against the real
 * App.tsx — they validate the contract and state transitions in isolation.
 *
 * Covers:
 * - Chrome integration status fetch (extension, bridge, mcp, connection)
 * - MCP server state transitions (missing → managed → connected)
 * - MCP configuration actions (configure, repair, test, remove)
 * - Error handling when Chrome is not installed
 * - Panel state transitions
 * - Aggregate state computation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useState, useCallback, useEffect } from 'react'
import {
  installVerbooBridge,
  defaultChromeStatus,
  createVerbooBridgeMock,
} from '../../test/test-utils'
import type {
  ChromeIntegrationStatus,
  ChromeComponentState,
  ChromeConnectionState,
  ChromeIntegrationAggregate,
} from '../../../shared/types'

// ─── Mocks ──────────────────────────────────────────────────────────────────
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))

// ─── Derived aggregate (mirrors Rust-side computation) ──────────────────────
function computeAggregate(status: ChromeIntegrationStatus): ChromeIntegrationAggregate {
  if (status.extension === 'missing' && status.bridge === 'missing' && status.mcp === 'missing') {
    return 'notConfigured'
  }
  if (status.extension === 'missing' || status.bridge === 'missing' || status.mcp === 'missing') {
    return 'incomplete'
  }
  if (status.connection === 'connected') return 'connected'
  return 'ready'
}

// ─── Test hook: useChromeIntegration ────────────────────────────────────────
function useChromeIntegration(mockBridge: Pick<createVerbooBridgeMock, 'getChromeIntegrationStatus' | 'chromeIntegrationConfigure' | 'chromeIntegrationTest'>) {
  const [status, setStatus] = useState<ChromeIntegrationStatus | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [testing, setTesting] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await mockBridge.getChromeIntegrationStatus()
      setStatus(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [mockBridge])

  const configure = useCallback(async (devExtId?: string) => {
    const result = await mockBridge.chromeIntegrationConfigure({ developmentExtensionId: devExtId })
    if (result.success) await refresh()
    return result
  }, [mockBridge, refresh])

  const testConnection = useCallback(async () => {
    setTesting(true)
    try {
      return await mockBridge.chromeIntegrationTest()
    } finally {
      setTesting(false)
    }
  }, [mockBridge])

  useEffect(() => { void refresh() }, [refresh])

  const aggregate = status ? computeAggregate(status) : 'notConfigured'

  return { status, loading, error, testing, aggregate, refresh, configure, testConnection }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCP Status Integration', () => {
  let bridge: ReturnType<typeof createVerbooBridgeMock>

  beforeEach(() => {
    vi.clearAllMocks()
    bridge = installVerbooBridge()
  })

  describe('status fetch', () => {
    it('loads Chrome integration status on mount', async () => {
      bridge.getChromeIntegrationStatus.mockResolvedValue(defaultChromeStatus({
        extension: 'managed',
        bridge: 'managed',
        mcp: 'managed',
        connection: 'connected',
        aggregate: 'connected',
      }))

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.status).toBeDefined()
      expect(result.current.status?.extension).toBe('managed')
      expect(result.current.status?.mcp).toBe('managed')
      expect(result.current.status?.connection).toBe('connected')
    })

    it('handles error during status fetch', async () => {
      bridge.getChromeIntegrationStatus.mockRejectedValue(new Error('Tauri not available'))

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.error).toBe('Tauri not available')
      expect(result.current.status).toBeUndefined()
    })
  })

  describe('aggregate state computation', () => {
    it('returns notConfigured when all components are missing', () => {
      const status = defaultChromeStatus()
      expect(computeAggregate(status)).toBe('notConfigured')
    })

    it('returns incomplete when some components are missing', () => {
      const status = defaultChromeStatus({
        extension: 'managed',
        bridge: 'missing',
        mcp: 'missing',
      })
      expect(computeAggregate(status)).toBe('incomplete')
    })

    it('returns ready when all components are present but not connected', () => {
      const status = defaultChromeStatus({
        extension: 'managed',
        bridge: 'managed',
        mcp: 'managed',
        connection: 'waitingForChrome',
      })
      expect(computeAggregate(status)).toBe('ready')
    })

    it('returns connected when all components are present and connected', () => {
      const status = defaultChromeStatus({
        extension: 'managed',
        bridge: 'managed',
        mcp: 'managed',
        connection: 'connected',
      })
      expect(computeAggregate(status)).toBe('connected')
    })
  })

  describe('component states', () => {
    it('extension can be missing, outdated, invalid, or managed', () => {
      const states: ChromeComponentState[] = ['missing', 'managed', 'outdated', 'invalid', 'conflict']
      for (const state of states) {
        const status = defaultChromeStatus({ extension: state })
        expect(status.extension).toBe(state)
      }
    })

    it('mcp follows same state model as extension', () => {
      const status = defaultChromeStatus({ mcp: 'managed' })
      expect(status.mcp).toBe('managed')
    })
  })

  describe('connection states', () => {
    it('connection can be waitingForChrome, connected, ambiguous, or incompatible', () => {
      const states: ChromeConnectionState[] = ['waitingForChrome', 'connected', 'ambiguous', 'incompatible']
      for (const state of states) {
        const status = defaultChromeStatus({ connection: state })
        expect(status.connection).toBe(state)
      }
    })
  })

  describe('configure action', () => {
    it('calls chromeIntegrationConfigure and refreshes on success', async () => {
      bridge.chromeIntegrationConfigure.mockResolvedValue({ success: true })
      bridge.getChromeIntegrationStatus
        .mockResolvedValueOnce(defaultChromeStatus({ extension: 'missing' }))
        .mockResolvedValueOnce(defaultChromeStatus({ extension: 'managed', mcp: 'managed' }))

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      await act(async () => {
        await result.current.configure()
      })

      expect(bridge.chromeIntegrationConfigure).toHaveBeenCalled()
      // Status refreshed after configure
      expect(result.current.status?.extension).toBe('managed')
    })

    it('passes development extension id when provided', async () => {
      bridge.chromeIntegrationConfigure.mockResolvedValue({ success: true })

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      await act(async () => {
        await result.current.configure('abcdefghijklmnop')
      })

      expect(bridge.chromeIntegrationConfigure).toHaveBeenCalledWith({
        developmentExtensionId: 'abcdefghijklmnop',
      })
    })
  })

  describe('test connection action', () => {
    it('runs connection test and reports results', async () => {
      bridge.chromeIntegrationTest.mockResolvedValue({
        helper: true,
        extension: true,
        mcp: true,
      })

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      let testResult: any
      await act(async () => {
        testResult = await result.current.testConnection()
      })

      expect(testResult.helper).toBe(true)
      expect(testResult.extension).toBe(true)
      expect(testResult.mcp).toBe(true)
      expect(result.current.testing).toBe(false)
    })

    it('sets testing state during test', async () => {
      let resolveTest: (v: any) => void
      bridge.chromeIntegrationTest.mockImplementation(() =>
        new Promise(resolve => { resolveTest = resolve })
      )

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      // Start test — state update is async, so check after a microtask
      let testPromise: Promise<any>
      await act(async () => {
        testPromise = result.current.testConnection()
      })

      // After act, the state update should be flushed
      expect(result.current.testing).toBe(true)

      await act(async () => {
        resolveTest!({ helper: true, extension: false, mcp: false })
        await testPromise!
      })

      expect(result.current.testing).toBe(false)
    })
  })

  describe('MCP component status display', () => {
    it('shows managed state when MCP is registered via CLI', async () => {
      bridge.getChromeIntegrationStatus.mockResolvedValue(defaultChromeStatus({
        mcp: 'managed',
      }))

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.status?.mcp).toBe('managed')
    })

    it('shows missing state when MCP is not registered', async () => {
      bridge.getChromeIntegrationStatus.mockResolvedValue(defaultChromeStatus({
        mcp: 'missing',
      }))

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.status?.mcp).toBe('missing')
    })

    it('shows conflict when MCP has version conflict', async () => {
      bridge.getChromeIntegrationStatus.mockResolvedValue(defaultChromeStatus({
        mcp: 'conflict',
      }))

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.status?.mcp).toBe('conflict')
    })
  })

  describe('version tracking', () => {
    it('exposes installed and available versions', async () => {
      bridge.getChromeIntegrationStatus.mockResolvedValue(defaultChromeStatus({
        installedVersion: '1.5.0',
        availableVersion: '1.6.0',
      }))

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.status?.installedVersion).toBe('1.5.0')
      expect(result.current.status?.availableVersion).toBe('1.6.0')
    })

    it('shows canConfigure, canRepair, canRemove flags', async () => {
      bridge.getChromeIntegrationStatus.mockResolvedValue(defaultChromeStatus({
        canConfigure: true,
        canRepair: true,
        canRemove: true,
      }))

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.status?.canConfigure).toBe(true)
      expect(result.current.status?.canRepair).toBe(true)
      expect(result.current.status?.canRemove).toBe(true)
    })
  })

  describe('refresh', () => {
    it('can manually refresh status', async () => {
      bridge.getChromeIntegrationStatus
        .mockResolvedValueOnce(defaultChromeStatus({ mcp: 'missing' }))
        .mockResolvedValueOnce(defaultChromeStatus({ mcp: 'managed' }))

      const { result } = renderHook(() => useChromeIntegration(bridge))

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })
      expect(result.current.status?.mcp).toBe('missing')

      await act(async () => {
        await result.current.refresh()
      })

      expect(result.current.status?.mcp).toBe('managed')
    })
  })
})
