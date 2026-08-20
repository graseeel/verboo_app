import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AndroidEmulatorFrame,
  AndroidEmulatorLifecycleEvent,
  AndroidEmulatorPresenceEvent,
  AndroidEmulatorRequirements,
  AndroidEmulatorSession,
} from './androidEmulatorApi'
import { useAndroidEmulatorPanel } from './useAndroidEmulatorPanel'

const api = vi.hoisted(() => ({
  requirements: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  end: vi.fn(),
  setVisible: vi.fn(),
  setStreamRate: vi.fn(),
  setFallbackRate: vi.fn(),
  tap: vi.fn(),
  drag: vi.fn(),
  typeText: vi.fn(),
  pressKey: vi.fn(),
  systemAction: vi.fn(),
  accessibilitySnapshot: vi.fn(),
  inspectPoint: vi.fn(),
  captureScreen: vi.fn(),
  recordingStart: vi.fn(),
  recordingStop: vi.fn(),
  onFrame: vi.fn(),
  onLifecycle: vi.fn(),
  onError: vi.fn(),
  onPresence: vi.fn(),
  onOpenRequested: vi.fn(),
}))

vi.mock('./androidEmulatorApi', () => ({ androidEmulatorApi: api }))

const device = {
  avdName: 'Pixel_8_API_35',
  displayName: 'Pixel 8',
  apiLevel: 35,
  family: 'phone' as const,
  running: false,
}

const requirements: AndroidEmulatorRequirements = {
  ready: true,
  issue: null,
  devices: [device],
}

const session: AndroidEmulatorSession = {
  device: { ...device, running: true },
  serial: 'emulator-5554',
  generation: 7,
  ownership: 'verboo',
  streamFps: 2,
  fallbackFps: 1,
  lifecycle: { stage: 'ready' },
}

describe('useAndroidEmulatorPanel (PA-27)', () => {
  let frameHandler: ((frame: AndroidEmulatorFrame) => void) | undefined
  let lifecycleHandler: ((event: AndroidEmulatorLifecycleEvent) => void) | undefined
  let presenceHandler: ((event: AndroidEmulatorPresenceEvent) => void) | undefined
  let openRequestedHandler: ((event?: AndroidEmulatorPresenceEvent | null) => void) | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    frameHandler = undefined
    lifecycleHandler = undefined
    presenceHandler = undefined
    openRequestedHandler = undefined
    api.requirements.mockResolvedValue(requirements)
    api.attach.mockImplementation(async () => session)
    api.detach.mockResolvedValue(undefined)
    api.end.mockResolvedValue(undefined)
    api.setVisible.mockResolvedValue(undefined)
    api.setStreamRate.mockResolvedValue(undefined)
    api.setFallbackRate.mockResolvedValue(undefined)
    api.tap.mockResolvedValue(undefined)
    api.drag.mockResolvedValue(undefined)
    api.typeText.mockResolvedValue(undefined)
    api.pressKey.mockResolvedValue(undefined)
    api.systemAction.mockResolvedValue(undefined)
    api.accessibilitySnapshot.mockResolvedValue({ nodes: [] })
    api.inspectPoint.mockResolvedValue(null)
    api.captureScreen.mockResolvedValue({ path: '/captures/android-screen.png' })
    api.recordingStart.mockResolvedValue(undefined)
    api.recordingStop.mockResolvedValue({ path: '/captures/android-recording.mp4' })
    api.onFrame.mockImplementation((handler: typeof frameHandler) => {
      frameHandler = handler
      return Promise.resolve(() => {})
    })
    api.onLifecycle.mockImplementation((handler: typeof lifecycleHandler) => {
      lifecycleHandler = handler
      return Promise.resolve(() => {})
    })
    api.onError.mockImplementation(() => Promise.resolve(() => {}))
    api.onPresence.mockImplementation((handler: typeof presenceHandler) => {
      presenceHandler = handler
      return Promise.resolve(() => {})
    })
    api.onOpenRequested.mockImplementation((handler: typeof openRequestedHandler) => {
      openRequestedHandler = handler
      return Promise.resolve(() => {})
    })
  })

  it('resumes preview before refreshing and hides without detaching the session', async () => {
    const order: string[] = []
    api.setVisible.mockImplementation(async (visible: boolean) => {
      order.push(visible ? 'visible' : 'hidden')
    })
    api.requirements.mockImplementation(async () => {
      order.push('requirements')
      return requirements
    })
    const view = renderHook(() => useAndroidEmulatorPanel())

    await act(async () => { await view.result.current.open() })
    await act(async () => { await view.result.current.attach(device.avdName) })
    act(() => view.result.current.close())
    await waitFor(() => expect(api.setVisible).toHaveBeenLastCalledWith(false))

    expect(order.slice(0, 2)).toEqual(['visible', 'requirements'])
    expect(api.detach).not.toHaveBeenCalled()
    expect(view.result.current.session?.device.avdName).toBe(device.avdName)
  })

  it('publishes only frames from the attached generation as PNG data URLs', async () => {
    const view = renderHook(() => useAndroidEmulatorPanel())
    await act(async () => { await view.result.current.attach(device.avdName) })

    act(() => frameHandler?.({ pngBase64: 'c3RhbGU=', width: 1080, height: 2400, generation: 6 }))
    expect(view.result.current.frameDataUrl).toBeUndefined()

    act(() => frameHandler?.({ pngBase64: 'YW5kcm9pZA==', width: 1080, height: 2400, generation: 7 }))
    expect(view.result.current.frameDataUrl).toBe('data:image/png;base64,YW5kcm9pZA==')
  })

  it('derives readiness from lifecycle and dispatches the frozen input vocabulary', async () => {
    const view = renderHook(() => useAndroidEmulatorPanel())
    await act(async () => { await view.result.current.attach(device.avdName) })

    act(() => lifecycleHandler?.({ stage: 'preparingInteraction' }))
    expect(view.result.current.interactionReady).toBe(false)
    act(() => lifecycleHandler?.({ stage: 'ready' }))
    expect(view.result.current.interactionReady).toBe(true)

    await act(async () => {
      await view.result.current.tap({ x: 0.25, y: 0.75 })
      await view.result.current.drag({ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.9 }, 240)
      await view.result.current.typeText('hello android')
      await view.result.current.pressKey('arrowLeft')
      await view.result.current.runSystemAction('recents')
    })

    expect(api.tap).toHaveBeenCalledWith(0.25, 0.75)
    expect(api.drag).toHaveBeenCalledWith(0.1, 0.2, 0.8, 0.9, 240)
    expect(api.typeText).toHaveBeenCalledWith('hello android')
    expect(api.pressKey).toHaveBeenCalledWith('arrowLeft')
    expect(api.systemAction).toHaveBeenCalledWith('recents')
  })

  it('clears local session state after detach and end', async () => {
    const view = renderHook(() => useAndroidEmulatorPanel())
    await act(async () => { await view.result.current.attach(device.avdName) })
    await act(async () => { await view.result.current.detach() })

    expect(view.result.current.session).toBeUndefined()
    expect(view.result.current.frameDataUrl).toBeUndefined()

    await act(async () => { await view.result.current.attach(device.avdName) })
    await act(async () => { await view.result.current.endSimulation() })
    expect(view.result.current.session).toBeUndefined()
  })

  it('exposes configurable stream and fallback rates through the F1 API', async () => {
    const view = renderHook(() => useAndroidEmulatorPanel())
    await act(async () => { await view.result.current.attach(device.avdName) })

    await act(async () => {
      await view.result.current.setStreamRate(5)
      await view.result.current.setFallbackRate(0.5)
    })

    expect(api.setStreamRate).toHaveBeenCalledWith(5)
    expect(api.setFallbackRate).toHaveBeenCalledWith(0.5)
    expect(view.result.current.session).toMatchObject({ streamFps: 5, fallbackFps: 0.5 })
  })

  it('increments agentOpenRequest and forwards a starting presence from onOpenRequested', async () => {
    const view = renderHook(() => useAndroidEmulatorPanel())
    await act(async () => { await view.result.current.attach(device.avdName) })
    const presence: AndroidEmulatorPresenceEvent = {
      generation: 7,
      phase: 'start',
      action: 'tap',
      target: { x: 0.5, y: 0.5 },
    }

    act(() => openRequestedHandler?.(presence))

    expect(view.result.current.agentOpenRequest).toBe(1)
    expect(view.result.current.agentPresence).toEqual(presence)
  })

  it('exposes Android accessibility inspection through the frozen inspect command', async () => {
    api.inspectPoint.mockResolvedValue({
      rect: { x: 0.25, y: 0.2, width: 0.5, height: 0.1 },
      element: {
        id: 'save', role: 'android.widget.Button', label: 'Save',
        frame: { x: 270, y: 480, width: 540, height: 240 },
        enabled: true, visible: true, actionable: true,
      },
    })
    const view = renderHook(() => useAndroidEmulatorPanel())
    await act(async () => { await view.result.current.attach(device.avdName) })

    const hit = await view.result.current.inspectPoint({ x: 0.5, y: 0.25 }, true)

    expect(api.inspectPoint).toHaveBeenCalledWith(0.5, 0.25)
    expect(hit).toMatchObject({ element: { id: 'save' }, rect: { x: 0.25, width: 0.5 } })
  })

  it('drives screenshot and recording state through the frozen media commands', async () => {
    const view = renderHook(() => useAndroidEmulatorPanel())
    await act(async () => { await view.result.current.attach(device.avdName) })

    await act(async () => { await view.result.current.captureScreen() })
    expect(view.result.current.lastMediaFile).toEqual({
      path: '/captures/android-screen.png',
      fileName: 'android-screen.png',
    })

    await act(async () => { await view.result.current.toggleRecording() })
    expect(api.recordingStart).toHaveBeenCalledOnce()
    expect(view.result.current.recording.state).toBe('recording')

    await act(async () => { await view.result.current.toggleRecording() })
    expect(api.recordingStop).toHaveBeenCalledOnce()
    expect(view.result.current.recording.state).toBe('idle')
    expect(view.result.current.lastMediaFile).toEqual({
      path: '/captures/android-recording.mp4',
      fileName: 'android-recording.mp4',
    })
  })
})
