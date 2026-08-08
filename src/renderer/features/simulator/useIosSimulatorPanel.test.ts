import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  IosSimulatorFrame,
  IosSimulatorLifecycleSnapshot,
  IosSimulatorPresenceEvent,
  IosSimulatorRequirements,
  IosSimulatorSession,
} from './iosSimulatorApi'
import { useIosSimulatorPanel } from './useIosSimulatorPanel'

const api = vi.hoisted(() => ({
  requirements: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  setVisible: vi.fn(),
  end: vi.fn(),
  systemAction: vi.fn(),
  retryInteraction: vi.fn(),
  captureScreen: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  revealOutput: vi.fn(),
  setStreamRate: vi.fn(),
  setFallbackRate: vi.fn(),
  tap: vi.fn(),
  drag: vi.fn(),
  typeText: vi.fn(),
  pressKey: vi.fn(),
  captureAnnotation: vi.fn(),
  onFrame: vi.fn(),
  onError: vi.fn(),
  onPresence: vi.fn(),
  onOpenRequested: vi.fn(),
  onLifecycle: vi.fn(),
}))

vi.mock('./iosSimulatorApi', () => ({ iosSimulatorApi: api }))

const device = {
  name: 'iPhone 17 Pro',
  udid: 'phone-17-pro',
  state: 'Booted',
  iosVersion: '26.5',
  family: 'iphone' as const,
}

const idleLifecycle: IosSimulatorLifecycleSnapshot = {
  udid: null,
  deviceGeneration: null,
  stage: 'idle',
  ownership: null,
  previewSuspended: false,
  interactionReady: false,
  recording: { state: 'idle' },
  recoverableError: null,
}

const readyLifecycle: IosSimulatorLifecycleSnapshot = {
  ...idleLifecycle,
  udid: 'phone-17-pro',
  deviceGeneration: 1,
  stage: 'ready',
  ownership: 'external',
  interactionReady: true,
}

const requirements: IosSimulatorRequirements = {
  ready: true,
  issue: null,
  xcodeVersion: '27.0',
  devices: [device],
  attachedUdid: null,
  streamFps: null,
  fallbackFps: null,
  source: null,
  effectiveFps: null,
  lifecycle: idleLifecycle,
}

const session: IosSimulatorSession = {
  device,
  deviceGeneration: 1,
  ownership: 'external',
  streamFps: 30,
  fallbackFps: 2,
  source: 'simctl',
  effectiveFps: null,
  lifecycle: readyLifecycle,
}

describe('useIosSimulatorPanel', () => {
  let frameHandler: ((frame: IosSimulatorFrame) => void) | undefined
  let presenceHandler: ((presence: IosSimulatorPresenceEvent) => void) | undefined
  let openRequestedHandler: ((presence?: IosSimulatorPresenceEvent | null) => void) | undefined
  let lifecycleHandler: ((snapshot: IosSimulatorLifecycleSnapshot) => void) | undefined
  let animationFrames: FrameRequestCallback[]

  function flushAnimationFrame() {
    const callback = animationFrames.shift()
    expect(callback).toBeDefined()
    act(() => callback?.(16))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    frameHandler = undefined
    presenceHandler = undefined
    openRequestedHandler = undefined
    lifecycleHandler = undefined
    animationFrames = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    api.requirements.mockResolvedValue(requirements)
    api.attach.mockImplementation(async () => {
      lifecycleHandler?.(readyLifecycle)
      return session
    })
    // Real backend contract (R1-B1, src-tauri ios_simulator.rs:1656-1668):
    // stop_session clears the authority with a generation guard and emits
    // the cleared snapshot (IosSimulatorLifecycleSnapshot::default()) on
    // every session-end path.
    api.detach.mockImplementation(async () => {
      lifecycleHandler?.(idleLifecycle)
    })
    api.setVisible.mockResolvedValue(undefined)
    api.end.mockImplementation(async () => {
      lifecycleHandler?.(idleLifecycle)
    })
    api.systemAction.mockResolvedValue(undefined)
    api.retryInteraction.mockResolvedValue({ ...readyLifecycle, stage: 'preparingInteraction' })
    api.captureScreen.mockResolvedValue({ path: '/Desktop/screenshot.png', fileName: 'screenshot.png' })
    api.startRecording.mockResolvedValue({ ...readyLifecycle, recording: { state: 'starting' } })
    api.stopRecording.mockResolvedValue({ path: '/Desktop/recording.mov', fileName: 'recording.mov' })
    api.revealOutput.mockResolvedValue(undefined)
    api.setStreamRate.mockResolvedValue(60)
    api.setFallbackRate.mockResolvedValue(1)
    api.tap.mockResolvedValue(undefined)
    api.drag.mockResolvedValue(undefined)
    api.typeText.mockResolvedValue(undefined)
    api.pressKey.mockResolvedValue(undefined)
    api.captureAnnotation.mockResolvedValue(undefined)
    api.onFrame.mockImplementation((handler: typeof frameHandler) => {
      frameHandler = handler
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
    api.onLifecycle.mockImplementation((handler: typeof lifecycleHandler) => {
      lifecycleHandler = handler
      return Promise.resolve(() => {})
    })
  })

  it('hides by suspending visibility and keeps the attached session', async () => {
    const view = renderHook(() => useIosSimulatorPanel())
    await act(async () => { await view.result.current.open() })
    await act(async () => { await view.result.current.attach('phone-17-pro') })

    await act(async () => { view.result.current.close() })
    await waitFor(() => expect(api.setVisible).toHaveBeenCalledWith(false))

    expect(api.detach).not.toHaveBeenCalled()
    expect(view.result.current.attachedUdid).toBe('phone-17-pro')
    expect(view.result.current.simulatorOpen).toBe(false)
  })

  it('resumes backend preview before refreshing on reopen', async () => {
    const order: string[] = []
    api.setVisible.mockImplementation(async (visible: boolean) => {
      order.push(visible ? 'visible' : 'hidden')
    })
    api.requirements.mockImplementation(async () => {
      order.push('requirements')
      return requirements
    })
    const view = renderHook(() => useIosSimulatorPanel())

    await act(async () => { await view.result.current.open() })

    expect(order).toEqual(['visible', 'requirements'])
  })

  it('keeps the last completed frame visible until a fresh resumed frame arrives', async () => {
    const view = renderHook(() => useIosSimulatorPanel())
    await act(async () => { await view.result.current.open() })
    await act(async () => { lifecycleHandler?.(readyLifecycle) })
    act(() => frameHandler?.({
      udid: 'phone-17-pro', deviceGeneration: 1, frameGeneration: 12,
      dataUrl: 'data:image/jpeg;base64,last-visible', capturedAtMs: 12,
      source: 'mjpeg', effectiveFps: 30,
    }))
    flushAnimationFrame()
    expect(view.result.current.frameDataUrl).toBe('data:image/jpeg;base64,last-visible')

    act(() => view.result.current.close())
    await act(async () => { await view.result.current.open() })

    expect(view.result.current.frameDataUrl).toBe('data:image/jpeg;base64,last-visible')
  })

  it('derives owned end behavior and recording state from lifecycle events', async () => {
    const view = renderHook(() => useIosSimulatorPanel())
    await act(async () => { lifecycleHandler?.({
      ...readyLifecycle,
      ownership: 'verboo',
      recording: { state: 'recording', startedAtMs: 1_786_000_000_000 },
    }) })

    expect(view.result.current.lifecycle.ownership).toBe('verboo')
    expect(view.result.current.recordingActive).toBe(true)
    await act(async () => { await view.result.current.endSimulation() })
    expect(api.end).toHaveBeenCalledTimes(1)
  })

  it('ignores a late frame from an older generation of the same udid', () => {
    const view = renderHook(() => useIosSimulatorPanel())
    act(() => lifecycleHandler?.({ ...readyLifecycle, deviceGeneration: 9 }))
    act(() => frameHandler?.({
      udid: 'phone-17-pro', deviceGeneration: 8, frameGeneration: 99,
      dataUrl: 'data:image/jpeg;base64,stale', capturedAtMs: 99,
      source: 'mjpeg', effectiveFps: 30,
    }))

    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(view.result.current.frameDataUrl).toBeUndefined()
  })

  it('does not apply a stale command return after a newer lifecycle event', async () => {
    api.setVisible.mockResolvedValue({ ...readyLifecycle, ownership: 'external' })
    const view = renderHook(() => useIosSimulatorPanel())
    act(() => lifecycleHandler?.({ ...readyLifecycle, ownership: 'verboo' }))

    await act(async () => { await view.result.current.close() })

    expect(view.result.current.lifecycle.ownership).toBe('verboo')
  })

  it('ignores the retry command snapshot and keeps the lifecycle event authoritative', async () => {
    const view = renderHook(() => useIosSimulatorPanel())
    act(() => lifecycleHandler?.({ ...readyLifecycle, ownership: 'verboo' }))
    api.retryInteraction.mockResolvedValue({ ...readyLifecycle, ownership: 'external' })

    await act(async () => { await view.result.current.retryInteraction() })

    expect(api.retryInteraction).toHaveBeenCalledTimes(1)
    expect(view.result.current.lifecycle.ownership).toBe('verboo')
  })

  it('coalesces a burst to the newest frame before updating React', async () => {
    const view = renderHook(() => useIosSimulatorPanel())
    await act(async () => { await view.result.current.open() })
    await act(async () => { await view.result.current.attach('phone-17-pro') })

    act(() => {
      for (let index = 0; index < 60; index += 1) {
        frameHandler?.({
          udid: 'phone-17-pro',
          dataUrl: `data:image/jpeg;base64,frame-${index}`,
          deviceGeneration: 1,
          frameGeneration: index + 1,
          capturedAtMs: index,
          source: 'mjpeg',
          effectiveFps: 60,
        })
      }
    })

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(view.result.current.frameDataUrl).toBeUndefined()
    flushAnimationFrame()
    expect(view.result.current.frameDataUrl).toBe('data:image/jpeg;base64,frame-59')
  })

  it('uses frame-carried presence when the standalone event is missed', async () => {
    vi.useFakeTimers()
    const view = renderHook(() => useIosSimulatorPanel())

    try {
      await act(async () => { await view.result.current.open() })
      await act(async () => { await view.result.current.attach('phone-17-pro') })

      act(() => frameHandler?.({
        udid: 'phone-17-pro',
        dataUrl: 'data:image/jpeg;base64,agent-frame',
        deviceGeneration: 1,
        frameGeneration: 1,
        capturedAtMs: 1,
        source: 'mjpeg',
        effectiveFps: 30,
        agentPresence: {
          generation: 12,
          phase: 'start',
          action: 'drag',
          start: { x: 0.2, y: 0.45 },
          end: { x: 0.8, y: 0.55 },
        },
      }))
      expect(view.result.current.agentPresence?.generation).toBe(12)

      act(() => frameHandler?.({
        udid: 'phone-17-pro',
        dataUrl: 'data:image/jpeg;base64,clear-frame',
        deviceGeneration: 1,
        frameGeneration: 2,
        capturedAtMs: 2,
        source: 'mjpeg',
        effectiveFps: 30,
        agentPresence: null,
      }))
      expect(view.result.current.agentPresence?.generation).toBe(12)
      act(() => { vi.advanceTimersByTime(900) })
      expect(view.result.current.agentPresence).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads requirements, consumes only the attached device frame, and detaches the stream', async () => {
    const view = renderHook(() => useIosSimulatorPanel())

    await act(async () => { await view.result.current.open() })
    await waitFor(() => expect(api.requirements).toHaveBeenCalledTimes(1))

    await act(async () => { await view.result.current.attach('phone-17-pro') })
    expect(view.result.current.attachedUdid).toBe('phone-17-pro')
    expect(api.attach).toHaveBeenCalledWith('phone-17-pro', 30, 2)

    act(() => frameHandler?.({ udid: 'other-device', dataUrl: 'wrong', deviceGeneration: 1, frameGeneration: 1, capturedAtMs: 1, source: 'simctl', effectiveFps: 1.8 }))
    expect(view.result.current.frameDataUrl).toBeUndefined()
    act(() => frameHandler?.({ udid: 'phone-17-pro', dataUrl: 'data:image/png;base64,frame', deviceGeneration: 1, frameGeneration: 2, capturedAtMs: 2, source: 'simctl', effectiveFps: 1.8 }))
    flushAnimationFrame()
    expect(view.result.current.frameDataUrl).toBe('data:image/png;base64,frame')
    expect(view.result.current.streamSource).toBe('simctl')
    expect(view.result.current.effectiveFps).toBe(1.8)

    act(() => frameHandler?.({ udid: 'phone-17-pro', dataUrl: 'data:image/jpeg;base64,next', deviceGeneration: 1, frameGeneration: 3, capturedAtMs: 3, source: 'mjpeg', effectiveFps: 9.2 }))
    flushAnimationFrame()
    expect(view.result.current.frameDataUrl).toBe('data:image/jpeg;base64,next')
    expect(view.result.current.streamSource).toBe('mjpeg')
    expect(view.result.current.effectiveFps).toBe(9.2)

    await act(async () => { await view.result.current.detach() })
    expect(api.detach).toHaveBeenCalledTimes(1)
    expect(view.result.current.attachedUdid).toBeUndefined()
    expect(view.result.current.frameDataUrl).toBeUndefined()
  })

  it('clears requirements attachment and session media when the end-of-session event arrives', async () => {
    api.requirements.mockResolvedValue({
      ...requirements,
      attachedUdid: 'phone-17-pro',
      streamFps: 30,
      fallbackFps: 2,
      source: 'simctl' as const,
      effectiveFps: 1.8,
    })
    const view = renderHook(() => useIosSimulatorPanel())
    await act(async () => { await view.result.current.open() })
    act(() => { lifecycleHandler?.(readyLifecycle) })
    expect(view.result.current.attachedUdid).toBe('phone-17-pro')
    expect(view.result.current.streamSource).toBe('simctl')
    await act(async () => { await view.result.current.captureScreen() })
    expect(view.result.current.lastMediaFile?.fileName).toBe('screenshot.png')

    // The backend ends the session (any path) and stop_session emits the
    // cleared snapshot; the event alone must tear down session-scoped state.
    act(() => { lifecycleHandler?.(idleLifecycle) })

    expect(view.result.current.attachedUdid).toBeUndefined()
    expect(view.result.current.streamSource).toBeUndefined()
    expect(view.result.current.effectiveFps).toBeUndefined()
    expect(view.result.current.lastMediaFile).toBeUndefined()
    expect(view.result.current.requirements?.attachedUdid).toBeNull()
    expect(view.result.current.requirements?.streamFps).toBeNull()
  })

  it('keeps the last frame when migration reports a source before its image', async () => {
    const view = renderHook(() => useIosSimulatorPanel())
    await act(async () => { await view.result.current.open() })
    await act(async () => { await view.result.current.attach('phone-17-pro') })

    act(() => frameHandler?.({
      udid: 'phone-17-pro',
      dataUrl: 'data:image/png;base64,warmup',
      deviceGeneration: 1,
      frameGeneration: 1,
      capturedAtMs: 1,
      source: 'simctl',
      effectiveFps: 1.8,
    }))
    act(() => frameHandler?.({
      udid: 'phone-17-pro',
      dataUrl: '',
      deviceGeneration: 1,
      frameGeneration: 2,
      capturedAtMs: 2,
      source: 'mjpeg',
      effectiveFps: 9.2,
    }))
    flushAnimationFrame()

    expect(view.result.current.frameDataUrl).toBe('data:image/png;base64,warmup')
    expect(view.result.current.streamSource).toBe('mjpeg')
  })

  it('changes stream fluency and fallback rate independently while attached', async () => {
    const view = renderHook(() => useIosSimulatorPanel())
    await act(async () => { await view.result.current.open() })
    await act(async () => { await view.result.current.attach('phone-17-pro') })

    await act(async () => { await view.result.current.setStreamRate(60) })
    await act(async () => { await view.result.current.setFallbackRate(1) })

    expect(api.setStreamRate).toHaveBeenCalledWith(60)
    expect(api.setFallbackRate).toHaveBeenCalledWith(1)
    expect(view.result.current.streamFps).toBe(60)
    expect(view.result.current.fallbackFps).toBe(1)
  })

  it('routes manual input directly without creating agent presence state', async () => {
    const view = renderHook(() => useIosSimulatorPanel())
    await act(async () => { await view.result.current.open() })
    await act(async () => { await view.result.current.attach('phone-17-pro') })

    await act(async () => { await view.result.current.tap({ x: 0.5, y: 0.25 }) })
    await act(async () => {
      await view.result.current.drag({ x: 0.1, y: 0.8 }, { x: 0.9, y: 0.2 }, 180)
    })
    await act(async () => { await view.result.current.typeText('Verboo') })
    await act(async () => { await view.result.current.pressKey('backspace') })

    expect(api.tap).toHaveBeenCalledWith({ x: 0.5, y: 0.25 })
    expect(api.drag).toHaveBeenCalledWith({ x: 0.1, y: 0.8 }, { x: 0.9, y: 0.2 }, 180)
    expect(api.typeText).toHaveBeenCalledWith('Verboo')
    expect(api.pressKey).toHaveBeenCalledWith('backspace')
    expect(view.result.current.agentPresence).toBeUndefined()
  })

  it('keeps newer agent presence when an older completion arrives and clears its owner', () => {
    vi.useFakeTimers()
    const view = renderHook(() => useIosSimulatorPanel())

    try {
      act(() => presenceHandler?.({
        generation: 5,
        phase: 'start',
        action: 'tap',
        target: { x: 0.25, y: 0.75 },
      }))
      expect(view.result.current.agentPresence?.generation).toBe(5)

      act(() => presenceHandler?.({
        generation: 6,
        phase: 'start',
        action: 'drag',
        start: { x: 0.1, y: 0.8 },
        end: { x: 0.9, y: 0.2 },
      }))
      act(() => presenceHandler?.({ generation: 5, phase: 'clear' }))
      expect(view.result.current.agentPresence?.generation).toBe(6)

      act(() => { vi.advanceTimersByTime(2_000) })
      act(() => presenceHandler?.({ generation: 6, phase: 'clear' }))
      expect(view.result.current.agentPresence?.generation).toBe(6)

      act(() => { vi.advanceTimersByTime(899) })
      expect(view.result.current.agentPresence?.generation).toBe(6)
      act(() => { vi.advanceTimersByTime(1) })
      expect(view.result.current.agentPresence).toBeUndefined()
      expect(api.onPresence).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('exposes each agent open request as a token and clears presence on detach', async () => {
    const view = renderHook(() => useIosSimulatorPanel())

    act(() => {
      openRequestedHandler?.()
      openRequestedHandler?.()
      presenceHandler?.({ generation: 7, phase: 'start', action: 'inspect' })
    })
    expect(view.result.current.agentOpenRequest).toBe(2)
    expect(view.result.current.agentPresence?.generation).toBe(7)

    await act(async () => { await view.result.current.detach() })
    expect(view.result.current.agentPresence).toBeUndefined()
    expect(api.onOpenRequested).toHaveBeenCalledTimes(1)
  })

  it('uses the panel-open request as the authoritative presence start', () => {
    const view = renderHook(() => useIosSimulatorPanel())

    act(() => openRequestedHandler?.({
      generation: 8,
      phase: 'start',
      action: 'tap',
      target: { x: 0.4, y: 0.6 },
    }))

    expect(view.result.current.agentOpenRequest).toBe(1)
    expect(view.result.current.agentPresence?.generation).toBe(8)
  })

  it('keeps a late attach alive when the panel was closed during boot', async () => {
    let resolveAttach: ((value: IosSimulatorSession) => void) | undefined
    api.attach.mockImplementation(() => new Promise<IosSimulatorSession>(resolve => {
      resolveAttach = resolve
    }))
    const view = renderHook(() => useIosSimulatorPanel())

    await act(async () => { await view.result.current.open() })
    const pendingAttach = view.result.current.attach('phone-17-pro')
    act(() => view.result.current.close())
    await act(async () => {
      act(() => lifecycleHandler?.(readyLifecycle))
      resolveAttach?.(session)
      await pendingAttach
    })

    expect(api.detach).not.toHaveBeenCalled()
    expect(view.result.current.attachedUdid).toBe('phone-17-pro')
  })
})
