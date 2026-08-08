import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn<(
    eventName: string,
    callback: (event: { payload: unknown }) => void,
  ) => Promise<() => void>>(() => Promise.resolve(() => {})),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (eventName: string, callback: (event: { payload: unknown }) => void) =>
    listenMock(eventName, callback),
}))

import { iosSimulatorApi } from './iosSimulatorApi'

describe('iosSimulatorApi event listeners', () => {
  let originalInternals: PropertyDescriptor | undefined

  beforeEach(() => {
    originalInternals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    listenMock.mockClear()
  })

  afterEach(() => {
    if (originalInternals) {
      Object.defineProperty(window, '__TAURI_INTERNALS__', originalInternals)
    } else {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
  })

  it('returns a no-op listener outside the Tauri runtime', async () => {
    const unlisten = await iosSimulatorApi.onPresence(() => {})

    expect(listenMock).not.toHaveBeenCalled()
    expect(() => unlisten()).not.toThrow()
  })

  it('registers and forwards events inside the Tauri runtime', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    const handler = vi.fn()

    await iosSimulatorApi.onOpenRequested(handler)

    expect(listenMock).toHaveBeenCalledWith('ios-simulator:open-requested', expect.any(Function))
    const forward = listenMock.mock.calls[0]?.[1]
    expect(forward).toBeDefined()
    const payload = { generation: 4, phase: 'start', action: 'tap' }
    forward?.({ payload })
    expect(handler).toHaveBeenCalledWith(payload)
  })

  it('invokes visibility, system-action, and interaction-retry commands', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)

    await iosSimulatorApi.setVisible(false)
    await iosSimulatorApi.systemAction('home')
    await iosSimulatorApi.retryInteraction()

    expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, 'ios_simulator_set_visible', { visible: false })
    expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(2, 'ios_simulator_system_action', { action: 'home' })
    expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(3, 'ios_simulator_retry_interaction')
  })

  it('registers and forwards the serialized lifecycle snapshot event', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    const handler = vi.fn()
    const snapshot = {
      udid: 'phone-17-pro',
      deviceGeneration: 9,
      stage: 'ready',
      ownership: 'verboo',
      previewSuspended: false,
      interactionReady: true,
      recording: { state: 'idle' },
      recoverableError: null,
    }

    await iosSimulatorApi.onLifecycle(handler)

    expect(listenMock).toHaveBeenCalledWith('ios-simulator:lifecycle', expect.any(Function))
    const forward = listenMock.mock.calls[0]?.[1]
    forward?.({ payload: snapshot })
    expect(handler).toHaveBeenCalledWith(snapshot)
  })
})
