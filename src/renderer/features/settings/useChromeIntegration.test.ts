import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChromeIntegrationStatus } from '../../../shared/types'
import { useChromeIntegration } from './useChromeIntegration'

const readyStatus: ChromeIntegrationStatus = {
  extension: 'managed',
  bridge: 'managed',
  mcp: 'managed',
  connection: 'waitingForChrome',
  aggregate: 'ready',
  installedVersion: '0.5.2-beta.1',
  availableVersion: '0.5.2-beta.1',
  canConfigure: false,
  canRepair: false,
  canRemove: true,
  storeUrlAvailable: true,
  developmentBuild: true,
  extensionIdSource: 'development',
}

const api = {
  chromeIntegrationStatus: vi.fn(),
  chromeIntegrationConfigure: vi.fn(),
  chromeIntegrationRepair: vi.fn(),
  chromeIntegrationTest: vi.fn(),
  chromeIntegrationRemove: vi.fn(),
  openChromeExtensionStore: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  api.chromeIntegrationStatus.mockResolvedValue(readyStatus)
  api.chromeIntegrationConfigure.mockResolvedValue(readyStatus)
  api.chromeIntegrationRepair.mockResolvedValue(readyStatus)
  api.chromeIntegrationTest.mockResolvedValue(true)
  api.chromeIntegrationRemove.mockResolvedValue({
    ...readyStatus,
    extension: 'missing',
    bridge: 'missing',
    mcp: 'missing',
    aggregate: 'notConfigured',
  })
  api.openChromeExtensionStore.mockResolvedValue(true)
  ;(window as unknown as { verboo: typeof api }).verboo = api
})

describe('useChromeIntegration', () => {
  it('loads read-only status on mount and performs no mutation', async () => {
    const { result } = renderHook(() => useChromeIntegration())

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.status).toEqual(readyStatus)
    expect(api.chromeIntegrationStatus).toHaveBeenCalledTimes(1)
    expect(api.chromeIntegrationConfigure).not.toHaveBeenCalled()
    expect(api.chromeIntegrationRepair).not.toHaveBeenCalled()
    expect(api.chromeIntegrationRemove).not.toHaveBeenCalled()
  })

  it('passes an explicitly validated development extension ID to configure', async () => {
    const { result } = renderHook(() => useChromeIntegration())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setDevelopmentExtensionId('abcdefghijklmnopabcdefghijklmnop'))
    await act(async () => { await result.current.configure() })

    expect(api.chromeIntegrationConfigure).toHaveBeenCalledWith({
      developmentExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    })
  })

  it('rejects an invalid development extension ID before invoking Tauri', async () => {
    const { result } = renderHook(() => useChromeIntegration())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setDevelopmentExtensionId('invalid'))
    await act(async () => { await result.current.configure() })

    expect(api.chromeIntegrationConfigure).not.toHaveBeenCalled()
    expect(result.current.error).toBe('chrome_extension_id_invalid')
  })

  it('runs repair, ping test, and removal only when explicitly called', async () => {
    const { result } = renderHook(() => useChromeIntegration())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.repair() })
    await act(async () => { await result.current.testConnection() })
    await act(async () => { await result.current.remove() })

    expect(api.chromeIntegrationRepair).toHaveBeenCalledWith({})
    expect(api.chromeIntegrationTest).toHaveBeenCalledTimes(1)
    expect(api.chromeIntegrationRemove).toHaveBeenCalledTimes(1)
    expect(result.current.lastTestPassed).toBe(true)
  })

  it('preserves backend error codes for localized rendering', async () => {
    api.chromeIntegrationConfigure.mockRejectedValue('chrome_mcp_conflict')
    const { result } = renderHook(() => useChromeIntegration())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.configure() })

    expect(result.current.error).toBe('chrome_mcp_conflict')
  })
})
