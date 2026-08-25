import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AndroidAccessibilityNode,
  AndroidEmulatorFrame,
  AndroidEmulatorLifecycleEvent,
  AndroidEmulatorPresenceEvent,
  AndroidEmulatorRequirements,
  AndroidEmulatorSession,
} from './androidEmulatorApi'
import type { Vaf1Frame } from './vaf1'
import { useAndroidEmulatorPanel } from './useAndroidEmulatorPanel'

const api = vi.hoisted(() => ({
  requirements: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  end: vi.fn(),
  setVisible: vi.fn(),
  setStreamRate: vi.fn(),
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
  readFrame: vi.fn(),
  onFrameReady: vi.fn(),
  onPreviewState: vi.fn(),
}))

// importOriginal preserva os exports PUROS reais (parseVaf1-adjacentes:
// parseFrameError/parsePreviewState, tipos) que o hook consome; só o objeto
// androidEmulatorApi é substituído. (Gap do plano: factory não atualizada.)
vi.mock('./androidEmulatorApi', async importOriginal => ({
  ...(await importOriginal<typeof import('./androidEmulatorApi')>()),
  androidEmulatorApi: api,
}))

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
  const readyHandlers: Array<(ready: { generation: number; seq: number }) => void> = []
  const stateHandlers: Array<(event: Record<string, unknown>) => void> = []

  beforeEach(() => {
    // ERRATA Task 8: vi.clearAllMocks preserva filas Once — a mockRejectedValueOnce
    // divergente do teste "stale_generation with MATCHING" vazaria para o
    // "stale bounded" seguinte. vi.resetAllMocks limpa TUDO (impls default +
    // filas Once); os defaults são re-wireados logo abaixo.
    vi.resetAllMocks()
    frameHandler = undefined
    lifecycleHandler = undefined
    presenceHandler = undefined
    openRequestedHandler = undefined
    readyHandlers.length = 0
    stateHandlers.length = 0
    api.readFrame.mockResolvedValue(new ArrayBuffer(0))
    api.onFrameReady.mockImplementation(handler => { readyHandlers.push(handler); return Promise.resolve(() => {}) })
    api.onPreviewState.mockImplementation(handler => { stateHandlers.push(handler); return Promise.resolve(() => {}) })
    api.requirements.mockResolvedValue(requirements)
    api.attach.mockImplementation(async () => session)
    api.detach.mockResolvedValue(undefined)
    api.end.mockResolvedValue(undefined)
    api.setVisible.mockResolvedValue(undefined)
    api.setStreamRate.mockResolvedValue(undefined)
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
    ;(window as unknown as { verboo: unknown }).verboo = {
      getUserSettings: vi.fn().mockResolvedValue({}),
      updateUserSettings: vi.fn().mockResolvedValue(undefined),
    }
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

    expect(api.tap).toHaveBeenCalledWith(0.25, 0.75, 'manual')
    expect(api.drag).toHaveBeenCalledWith(0.1, 0.2, 0.8, 0.9, 240, 'manual')
    expect(api.typeText).toHaveBeenCalledWith('hello android', 'manual')
    expect(api.pressKey).toHaveBeenCalledWith('arrowLeft', 'manual')
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

  it('normalizes the echoed attach streamFps into the state (F5, line 133)', async () => {
    const view = renderHook(() => useAndroidEmulatorPanel())
    await act(async () => { await view.result.current.attach(device.avdName) })

    expect(view.result.current.streamFps).toBe(60)
    expect(view.result.current.session?.streamFps).toBe(2)
  })

  it('normalizes setStreamRate before the native boundary while preserving the attach wire echo', async () => {
    const view = renderHook(() => useAndroidEmulatorPanel())
    await act(async () => { await view.result.current.attach(device.avdName) })

    await act(async () => { await view.result.current.setStreamRate(5) })

    expect(api.setStreamRate).toHaveBeenCalledWith(60)
    expect(view.result.current.streamFps).toBe(60)
    expect(view.result.current.session?.streamFps).toBe(2)
  })

  it('setStreamRate(30) is identity under normalize (F5, identidade pin)', async () => {
    const view = renderHook(() => useAndroidEmulatorPanel())
    await act(async () => { await view.result.current.attach(device.avdName) })

    await act(async () => { await view.result.current.setStreamRate(30) })

    expect(view.result.current.streamFps).toBe(30)
  })

  it('normalizes setStreamRate(5) before attach through the no-session path (F5, line 303)', async () => {
    const view = renderHook(() => useAndroidEmulatorPanel())

    await act(async () => { await view.result.current.setStreamRate(5) })

    expect(view.result.current.streamFps).toBe(60)
  })

  describe('Task 11 — persisted stream settings', () => {
    it('loads the persisted rate before the first attach', async () => {
      ;(window as unknown as { verboo: unknown }).verboo = {
        getUserSettings: vi.fn().mockResolvedValue({ androidStreamFps: 30 }),
        updateUserSettings: vi.fn().mockResolvedValue(undefined),
      }
      api.attach.mockResolvedValueOnce({ ...session, streamFps: 30 })
      const view = renderHook(() => useAndroidEmulatorPanel())

      await act(async () => { await view.result.current.attach(device.avdName) })

      expect(api.attach).toHaveBeenCalledWith(device.avdName, 30, 1, 'vaf1')
      expect(view.result.current.streamFps).toBe(30)
    })

    it('restores persisted authority and exposes persistFailed when saving rejects', async () => {
      ;(window as unknown as { verboo: unknown }).verboo = {
        getUserSettings: vi.fn().mockResolvedValue({ androidStreamFps: 60 }),
        updateUserSettings: vi.fn().mockRejectedValue(new Error('write failed')),
      }
      const view = renderHook(() => useAndroidEmulatorPanel())

      await act(async () => { await view.result.current.setStreamRate(30) })

      expect(view.result.current.streamFps).toBe(60)
      expect(view.result.current.fpsSyncError).toBe('persistFailed')
      expect(api.setStreamRate).not.toHaveBeenCalled()
    })

    it('rolls persistence and UI back when native apply rejects', async () => {
      const updateUserSettings = vi.fn().mockResolvedValue(undefined)
      ;(window as unknown as { verboo: unknown }).verboo = {
        getUserSettings: vi.fn().mockResolvedValue({ androidStreamFps: 60 }),
        updateUserSettings,
      }
      api.setStreamRate.mockRejectedValue(new Error('native apply failed'))
      const view = renderHook(() => useAndroidEmulatorPanel())

      await act(async () => { await view.result.current.setStreamRate(30) })

      expect(updateUserSettings).toHaveBeenNthCalledWith(1, { androidStreamFps: 30 })
      expect(updateUserSettings).toHaveBeenNthCalledWith(2, { androidStreamFps: 60 })
      expect(view.result.current.streamFps).toBe(60)
      expect(view.result.current.fpsSyncError).toBe('applyFailed')
    })

    it('duplo-fail do rollback: persist + load falham → state cai no default 60 + rollbackFailed (pin Task 11)', async () => {
      // updateUserSettings: 1ª chamada SUCEDE (persist inicial passa), 2ª FALHA
      // (rollback persist rejeita). getUserSettings: SEMPRE rejeita →
      // loadPersistedStreamFps cai no catch e retorna o default 60.
      let updateCall = 0
      const updateUserSettings = vi.fn().mockImplementation(async () => {
        updateCall += 1
        if (updateCall === 1) return undefined
        throw new Error('write failed (rollback)')
      })
      ;(window as unknown as { verboo: unknown }).verboo = {
        getUserSettings: vi.fn().mockRejectedValue(new Error('read failed')),
        updateUserSettings,
      }
      api.setStreamRate.mockRejectedValue(new Error('native apply failed'))
      const view = renderHook(() => useAndroidEmulatorPanel())

      await act(async () => { await view.result.current.setStreamRate(30) })

      // Caminho do rollback fail: state caiu no default via loadPersistedStreamFps
      // (que capturou o reject e retornou 60), error='rollbackFailed' (selector
      // disabled, conforme recomendação do Lacre).
      expect(updateUserSettings).toHaveBeenNthCalledWith(1, { androidStreamFps: 30 })
      expect(updateUserSettings).toHaveBeenNthCalledWith(2, { androidStreamFps: 60 })
      expect(view.result.current.streamFps).toBe(60)
      expect(view.result.current.fpsSyncError).toBe('rollbackFailed')
    })
  })

  describe('useAndroidEmulatorPanel — VAF1 pipeline', () => {
    // Buffer COMPLETO e VÁLIDO: header 36 + payload w*h*3 (2x2 ⇒ 48 bytes),
    // dentro do bounding box — parseVaf1 aceita e o paint é real.
    function vaf1Buffer(generation: number, seq: number): ArrayBuffer {
      const width = 2
      const height = 2
      const buf = new ArrayBuffer(36 + width * height * 3)
      const view = new DataView(buf)
      for (const [i, ch] of [...'VAF1'].entries()) view.setUint8(i, ch.charCodeAt(0))
      view.setBigUint64(4, BigInt(generation), true)
      view.setUint32(12, seq, true)
      view.setBigUint64(16, 1_000n, true)
      view.setUint32(24, width, true)
      view.setUint32(28, height, true)
      view.setUint8(32, 1)
      return buf
    }
    it('does NOT read before bindPreviewCanvas registers the paint target', async () => {
      // Slot real: readFrame devolve o frame VAF1 íntegro do wakeup seq 1.
      api.readFrame.mockResolvedValue(vaf1Buffer(session.generation, 1))
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      expect(api.attach).toHaveBeenLastCalledWith(device.avdName, 60, 1, 'vaf1')
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 1 })))
      expect(api.readFrame).not.toHaveBeenCalled()
      const push = vi.fn()
      act(() => view.result.current.bindPreviewCanvas(push))
      await waitFor(() => expect(api.readFrame).toHaveBeenCalledWith(session.generation))
      await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    })
    it('keeps exactly one read in flight with dirty coalescing', async () => {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      api.readFrame.mockImplementation(() =>
        // Slot real: cada leitura devolve o frame MAIS RECENTE publicado —
        // a N-ésima leitura vê seq N (wakeups deste teste: seq 1, depois 2).
        gate.then(() => vaf1Buffer(7, api.readFrame.mock.calls.length)))
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      const push = vi.fn()
      act(() => view.result.current.bindPreviewCanvas(push))
      act(() => readyHandlers.forEach(h => h({ generation: 7, seq: 1 })))
      // Garante a timeline pretendida: o read#1 precisa estar EM VOO (rAF
      // natural ~16ms) ANTES do wakeup seq 2 — senão ele vira "latest vence"
      // no pending em vez de exercitar o dirty coalescing.
      await waitFor(() => expect(api.readFrame).toHaveBeenCalledTimes(1))
      act(() => readyHandlers.forEach(h => h({ generation: 7, seq: 2 })))
      await act(async () => { release() })
      await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(api.readFrame).toHaveBeenCalledTimes(2))
      expect(push).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 2 }))
    })
    it('close during an in-flight read yields ZERO paint and no second invoke until a NEW wakeup', async () => {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      api.readFrame.mockImplementation(() => gate.then(() => vaf1Buffer(session.generation, 1)))
      const push = vi.fn()
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      act(() => view.result.current.bindPreviewCanvas(push))
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 1 })))
      await waitFor(() => expect(api.readFrame).toHaveBeenCalledTimes(1))
      act(() => view.result.current.close())            // época++ durante o voo
      await act(async () => { release() })
      await act(async () => { await Promise.resolve() }) // resolve do invoke antigo
      expect(push).not.toHaveBeenCalled()               // ZERO paint da época velha
      expect(api.readFrame).toHaveBeenCalledTimes(1)
      await act(async () => { await view.result.current.open() })  // reopen NÃO auto-agenda
      expect(api.readFrame).toHaveBeenCalledTimes(1)
      expect(push).not.toHaveBeenCalled()
    })
    it('reopen before resolve keeps EXACTLY one invoke; old result ignored; new wakeup reads again', async () => {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      api.readFrame.mockImplementation(() => gate.then(() => vaf1Buffer(session.generation, 1)))
      const push = vi.fn()
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      act(() => view.result.current.bindPreviewCanvas(push))
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 1 })))
      await waitFor(() => expect(api.readFrame).toHaveBeenCalledTimes(1))
      act(() => view.result.current.close())            // oculto: aguarda invoke resolver
      await act(async () => { release() })
      await act(async () => { await Promise.resolve() })
      expect(api.readFrame).toHaveBeenCalledTimes(1)    // nenhum segundo invoke concorrente
      await act(async () => { await view.result.current.open() })  // reopen NÃO agenda por si só
      expect(api.readFrame).toHaveBeenCalledTimes(1)
      api.readFrame.mockResolvedValue(vaf1Buffer(session.generation, 2))
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 2 })))
      await waitFor(() => expect(api.readFrame).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(push).toHaveBeenCalledWith(expect.objectContaining({ seq: 2 })))
    })
    it('frame-ready during same-AVD reattach buffers LATEST and drains after response', async () => {
      let resolveReattach!: (value: AndroidEmulatorSession) => void
      api.attach.mockResolvedValueOnce(session)                                      // 1ª attach RESOLVE
      api.attach.mockImplementationOnce(() =>                                        // 2ª fica em gate
        new Promise<AndroidEmulatorSession>(resolve => { resolveReattach = resolve }))
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      let reattachPromise!: Promise<void>
      act(() => { reattachPromise = view.result.current.attach(device.avdName) }) // reattach em voo
      await act(async () => { await Promise.resolve() })
      act(() => readyHandlers.forEach(h => h({ generation: 7, seq: 5 })))            // bufferizado
      act(() => readyHandlers.forEach(h => h({ generation: 7, seq: 6 })))            // latest vence
      api.readFrame.mockResolvedValue(vaf1Buffer(7, 6))  // slot real: latest seq 6
      const push = vi.fn()
      act(() => view.result.current.bindPreviewCanvas(push))
      await act(async () => {
        resolveReattach({ ...session, generation: 7 })
        await reattachPromise
      })
      await waitFor(() => expect(api.readFrame).toHaveBeenCalledWith(7))
      await waitFor(() => expect(push).toHaveBeenCalledWith(expect.objectContaining({ seq: 6 })))
      expect(api.readFrame).toHaveBeenCalledTimes(1)   // dreno ÚNICO pós-resposta
      expect(push).toHaveBeenCalledTimes(1)
    })
    it('stale legacy downgrade callback NEVER writes state across close/open eras', async () => {
      const nextSession: AndroidEmulatorSession = { ...session, generation: 9 }
      api.attach.mockResolvedValueOnce(session)                                  // 1ª RESOLVE
      let releaseLegacy!: (value: AndroidEmulatorSession) => void
      api.attach.mockImplementationOnce(() =>                                    // downgrade DEFERRED
        new Promise<AndroidEmulatorSession>(resolve => { releaseLegacy = resolve }))
      let releaseNew!: (value: AndroidEmulatorSession) => void
      // 3ª chamada (reattach pós close/open) também deferred — enfileirada ANTES do uso:
      api.attach.mockImplementationOnce(() =>
        new Promise<AndroidEmulatorSession>(resolve => { releaseNew = resolve }))

      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      const push = vi.fn((frame: {
        generation: number; seq: number; timestampUs: bigint
        width: number; height: number; pixels: Uint8Array
      }) => ({
        generation: frame.generation, seq: frame.seq, timestampUs: frame.timestampUs,
        width: frame.width, height: frame.height, paintedAtMs: performance.now(),
      }))
      act(() => view.result.current.bindPreviewCanvas(push))
      await act(async () => { view.result.current.onWebglTerminalFailure() })     // era velha em voo
      act(() => view.result.current.close())                                     // epoch++
      await act(async () => { await view.result.current.open() })
      let newEraPromise!: Promise<void>
      act(() => { newEraPromise = view.result.current.attach(device.avdName) }) // NOVA era em voo
      await act(async () => { await Promise.resolve() })
      act(() => readyHandlers.forEach(h => h({ generation: 7, seq: 9 })))         // bufferizado pela nova era

      // Era VELHA resolve DEPOIS do close/open/new-start: ÓRFÃO.
      await act(async () => { releaseLegacy(nextSession) })
      expect(view.result.current.session?.generation).toBe(7)                     // NÃO virou 9
      expect(view.result.current.error).toBeUndefined()
      expect(view.result.current.previewState?.source ?? undefined)
        .not.toBe('adbFallback')                                                  // adbFallback órfão não aplica

      // Nova era finaliza: drena o wakeup bufferizado exatamente uma vez.
      api.readFrame.mockResolvedValue(vaf1Buffer(7, 9))   // slot real: seq 9
      await act(async () => {
        releaseNew({ ...session, generation: 7 })
        await newEraPromise
      })
      await waitFor(() => expect(api.readFrame).toHaveBeenCalledWith(7))
      await waitFor(() => expect(push).toHaveBeenCalledWith(expect.objectContaining({ seq: 9 })))
      expect(api.readFrame).toHaveBeenCalledTimes(1)
    })
    it('downgrade drains the NATIVE buffered preview-state byte-a-byte', async () => {
      api.attach.mockResolvedValueOnce(session)                                  // attach do usuário
      let releaseDowngrade!: (value: AndroidEmulatorSession) => void
      api.attach.mockImplementationOnce(() =>                                    // downgrade DEFERRED
        new Promise<AndroidEmulatorSession>(resolve => { releaseDowngrade = resolve }))
      const legacySession: AndroidEmulatorSession = { ...session, generation: 8 }
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      await act(async () => { view.result.current.onWebglTerminalFailure() })

      // Estado NATIVE autoritativo chega DURANTE o attach do downgrade:
      act(() => stateHandlers.forEach(h => h({
        generation: 8, source: 'adbFallback',
        requestedFps: 60, degraded: true, reason: 'unavailable',
      })))

      await act(async () => { releaseDowngrade(legacySession) })
      await waitFor(() => {
        // BYTE A BYTE do objeto native — degraded/reason/source SOBREVIVEM:
        expect(view.result.current.previewState).toEqual({
          generation: 8, source: 'adbFallback',
          requestedFps: 60, degraded: true, reason: 'unavailable',
        })
      })
      expect(view.result.current.previewMode).toBe('legacy')
    })

    it('downgrade WITHOUT buffered state claims NOTHING — interim honest only', async () => {
      api.attach.mockResolvedValueOnce(session)
      let releaseDowngrade!: (value: AndroidEmulatorSession) => void
      api.attach.mockImplementationOnce(() =>
        new Promise<AndroidEmulatorSession>(resolve => { releaseDowngrade = resolve }))
      const legacySession: AndroidEmulatorSession = { ...session, generation: 8 }
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      await act(async () => { view.result.current.onWebglTerminalFailure() })

      await act(async () => { releaseDowngrade(legacySession) })
      await waitFor(() => {
        const state = view.result.current.previewState
        expect(state?.source).toBe('adbFallback')
        expect(state?.generation).toBe(8)
        expect(state?.degraded).toBe(true)                       // NUNCA false sintetizado
        expect(Object.keys(state ?? {}).sort()).toEqual([
          'degraded', 'generation', 'requestedFps', 'source',
        ])                                                       // SEM reason inventada
      })
    })

    it('buffers drain monotonic latest-by-(generation, seq); no freeze on inverse order', async () => {
      const nextSession: AndroidEmulatorSession = { ...session, generation: 9 }
      api.attach.mockResolvedValueOnce(session)
      let releaseReattach!: (value: AndroidEmulatorSession) => void
      api.attach.mockImplementationOnce(() =>
        new Promise<AndroidEmulatorSession>(resolve => { releaseReattach = resolve }))
      api.readFrame.mockResolvedValue(vaf1Buffer(9, 6))   // slot real: latest seq 6
      const push = vi.fn((frame: {
        generation: number; seq: number; timestampUs: bigint
        width: number; height: number; pixels: Uint8Array
      }) => ({
        generation: frame.generation, seq: frame.seq, timestampUs: frame.timestampUs,
        width: frame.width, height: frame.height, paintedAtMs: performance.now(),
      }))
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      let reattachPromise!: Promise<void>
      act(() => { reattachPromise = view.result.current.attach(device.avdName) }) // reattach em voo
      await act(async () => { await Promise.resolve() })

      act(() => readyHandlers.forEach(h => h({ generation: 9, seq: 5 })))          // N (alvo)
      act(() => readyHandlers.forEach(h => h({ generation: 7, seq: 9 })))          // velho: rejeitado
      act(() => readyHandlers.forEach(h => h({ generation: 9, seq: 4 })))          // seq regressivo: rejeitado
      act(() => readyHandlers.forEach(h => h({ generation: 9, seq: 6 })))          // mesmo gen, seq maior vence

      act(() => stateHandlers.forEach(h => h({
        generation: 9, source: 'grpc', requestedFps: 60, degraded: true, reason: 'gpuSoftware',
      })))                                                                          // primeiro estado gen9
      act(() => stateHandlers.forEach(h => h({
        generation: 8, source: 'grpc', requestedFps: 30, degraded: false,
      })))                                                                          // MENOR: rejeitado
      act(() => stateHandlers.forEach(h => h({
        generation: 9, source: 'adbFallback', requestedFps: 30,
        degraded: true, reason: 'unavailable',
      })))                                                                          // same-gen last-wins

      // O plano literal omite o bindPreviewCanvas — sem paint target registrado o
      // dreno jamais pintaria (guard pushFrameRef). Mesma posição do teste-irmão.
      act(() => view.result.current.bindPreviewCanvas(push))
      await act(async () => {
        releaseReattach(nextSession)
        await reattachPromise
      })
      await waitFor(() => expect(api.readFrame).toHaveBeenCalledWith(9))
      await waitFor(() => expect(push).toHaveBeenCalledWith(expect.objectContaining({ seq: 6 })))
      expect(push).toHaveBeenCalledTimes(1)                                        // sem congelar, sem duplicar
      await waitFor(() => {
        expect(view.result.current.previewState).toEqual({
          generation: 9, source: 'adbFallback', requestedFps: 30,
          degraded: true, reason: 'unavailable',
        })
      })
    })
    it('stale_generation with MATCHING currentGeneration resyncs; divergent halts', async () => {
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      const push = vi.fn()
      act(() => view.result.current.bindPreviewCanvas(push))
      api.readFrame.mockRejectedValueOnce({ code: 'stale_generation', currentGeneration: session.generation })
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 7 })))
      await waitFor(() => expect(api.readFrame).toHaveBeenCalled())
      api.readFrame.mockResolvedValue(vaf1Buffer(session.generation, 8))
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 8 })))
      await waitFor(() => expect(push).toHaveBeenCalled())       // ressincronizou sem halted
      api.readFrame.mockRejectedValueOnce({
        code: 'stale_generation', currentGeneration: session.generation + 10,
      })
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 9 })))
      await waitFor(() => expect(api.readFrame).toHaveBeenCalledTimes(3))
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 10 })))
      expect(api.readFrame).toHaveBeenCalledTimes(3)             // halted: sem nova leitura
    })
    it('stale bounded: first match auto-retries ONCE; second match waits WITHOUT halt; divergent halts (rAF fake, zero sleep)', async () => {
      // rAF controlável: NENHUM callback roda sem flush explícito ⇒ loop/halt
      // ficam determinísticos e a mutação morde sem depender de timers reais.
      let rafQueue: Array<() => void> = []
      const flushRaf = async () => {
        const queued = rafQueue
        rafQueue = []
        for (const cb of queued) cb()
        for (let tick = 0; tick < 3; tick++) {
          await act(async () => { await Promise.resolve() })
        }
      }
      const originalRaf = window.requestAnimationFrame
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        rafQueue.push(() => cb(performance.now()))
        return rafQueue.length
      }) as typeof window.requestAnimationFrame

      try {
        const view = renderHook(() => useAndroidEmulatorPanel())
        await act(async () => { await view.result.current.attach(device.avdName) })
        const push = vi.fn()
        act(() => view.result.current.bindPreviewCanvas(push))

        api.readFrame.mockRejectedValueOnce({ code: 'stale_generation', currentGeneration: session.generation })
        api.readFrame.mockRejectedValueOnce({ code: 'stale_generation', currentGeneration: session.generation })

        act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 11 })))
        await flushRaf()                                   // read#1: stale MATCH → ressync
        expect(api.readFrame).toHaveBeenCalledTimes(1)
        await flushRaf()                                   // read#2: stale MATCH de novo
        expect(api.readFrame).toHaveBeenCalledTimes(2)

        // Drenagem EXPLÍCITA dupla: se houvesse LOOP, cada flush geraria +1 read.
        await flushRaf()
        await flushRaf()
        expect(api.readFrame).toHaveBeenCalledTimes(2)     // MUTAÇÃO loop falha AQUI
        expect(view.result.current.previewMode).toBe('vaf1') // MUTAÇÃO halted-falha AQUI
        expect(view.result.current.error).toBeUndefined()

        // NOVO wakeup agenda normalmente (segundo match NÃO halted):
        api.readFrame.mockResolvedValue(vaf1Buffer(session.generation, 12))
        act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 12 })))
        await flushRaf()
        expect(api.readFrame).toHaveBeenCalledTimes(3)
        await waitFor(() => expect(push).toHaveBeenCalledWith(expect.objectContaining({ seq: 12 })))

        // DIVERGENTE: halted real — wakeup seguinte não lê.
        api.readFrame.mockRejectedValueOnce({
          code: 'stale_generation', currentGeneration: session.generation + 10,
        })
        act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 13 })))
        await flushRaf()
        expect(api.readFrame).toHaveBeenCalledTimes(4)
        act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 14 })))
        await flushRaf()
        expect(api.readFrame).toHaveBeenCalledTimes(4)
      } finally {
        window.requestAnimationFrame = originalRaf
      }
    })

    it('preview-state during SAME-AVD reattach buffers against the NEW generation', async () => {
      const nextSession: AndroidEmulatorSession = { ...session, generation: 8 }
      let resolveReattach!: (value: AndroidEmulatorSession) => void
      api.attach.mockResolvedValueOnce(session)                                      // 1ª RESOLVE
      api.attach.mockImplementationOnce(() =>
        new Promise<AndroidEmulatorSession>(resolve => { resolveReattach = resolve }))
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })   // sessão velha gen 7
      let reattachPromise!: Promise<void>
      act(() => { reattachPromise = view.result.current.attach(device.avdName) }) // reattach em voo
      await act(async () => { await Promise.resolve() })
      act(() => stateHandlers.forEach(h => h({
        generation: 8, source: 'grpc', requestedFps: 30, degraded: true, reason: 'gpuSoftware',
      })))                                                                          // chega ANTES da resposta
      await act(async () => {
        resolveReattach(nextSession)
        await reattachPromise
      })
      await waitFor(() => {
        expect(view.result.current.previewState).toMatchObject({
          generation: 8, degraded: true, reason: 'gpuSoftware',
        })
      })
      expect(view.result.current.previewMode).toBe('vaf1')
    })
    it('drops frames whose VAF1 generation diverges from the session without painting', async () => {
      // Sinal válido da sessão 7, mas o envelope cheio é da geração 999: o hook
      // revalida ANTES do paint e descarta sem pintar.
      api.readFrame.mockResolvedValue(vaf1Buffer(999, 9))
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      const push = vi.fn()
      act(() => view.result.current.bindPreviewCanvas(push))
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 9 })))
      await waitFor(() => expect(api.readFrame).toHaveBeenCalledWith(session.generation))
      expect(push).not.toHaveBeenCalled()
      expect(view.result.current.canvasSize).toBeUndefined()
      expect(view.result.current.previewMode).toBe('legacy')
    })
    it('applies a preview-state that arrived BEFORE the attach response (first-attach race)', async () => {
      let resolveAttach!: (value: AndroidEmulatorSession) => void
      api.attach.mockImplementation(() => new Promise<AndroidEmulatorSession>(resolve => { resolveAttach = resolve }))
      const view = renderHook(() => useAndroidEmulatorPanel())
      let attachPromise!: Promise<void>
      act(() => { attachPromise = view.result.current.attach(device.avdName) }) // attach em voo
      act(() => stateHandlers.forEach(h => h({
        generation: session.generation, source: 'grpc',
        requestedFps: 30, degraded: true, reason: 'gpuSoftware',
      })))
      await act(async () => { await Promise.resolve() })
      await act(async () => {
        resolveAttach(session)
        await attachPromise
      })
      await waitFor(() => {
        expect(view.result.current.previewState).toMatchObject({
          source: 'grpc', degraded: true, reason: 'gpuSoftware',
        })
      })
    })
    it('an adbFallback preview-state halts VAF1 and legacy PNG frames keep flowing', async () => {
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      const push = vi.fn()
      act(() => view.result.current.bindPreviewCanvas(push))
      act(() => stateHandlers.forEach(h => h({
        generation: session.generation, source: 'adbFallback',
        requestedFps: 60, degraded: false,
      })))
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 3 })))
      await waitFor(() => expect(api.readFrame).not.toHaveBeenCalled())
      act(() => frameHandler?.({ pngBase64: 'aGVsbG8=', width: 1080, height: 2400, generation: session.generation }))
      expect(view.result.current.frameDataUrl).toContain('data:image/png;base64,aGVsbG8=')
    })
    it('a transport-class read error halts scheduling without any reattach', async () => {
      api.readFrame.mockRejectedValue({ code: 'unauthenticated' })
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      act(() => view.result.current.bindPreviewCanvas(vi.fn()))
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 4 })))
      await waitFor(() => expect(api.readFrame).toHaveBeenCalled())
      expect(api.attach).toHaveBeenCalledTimes(1)
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 5 })))
      expect(api.readFrame).toHaveBeenCalledTimes(1)
    })
    it('WebGL terminal failure downgrades ONCE via same-avd legacyPng attach (no detach/end)', async () => {
      api.attach.mockImplementation(async (_avd: string, fps: number, fb: number, transport?: string) =>
        transport === 'legacyPng' ? { ...session, streamFps: fps, fallbackFps: fb } : session)
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      await act(async () => { view.result.current.onWebglTerminalFailure() })
      await act(async () => { view.result.current.onWebglTerminalFailure() })
      // ERRATA Task 8: decisão de contrato — downgrade consome a INTENÇÃO
      // normalizada (60), nunca o eco cru fora de 30|60. A fixture mantém
      // session.streamFps=2 (wire autoritativo cru) mas o attach do downgrade
      // envia a intenção UI normalizada.
      expect(api.attach).toHaveBeenLastCalledWith(device.avdName, 60, 1, 'legacyPng')
      expect(view.result.current.previewMode).toBe('legacy')
      expect(api.detach).not.toHaveBeenCalled()
      expect(api.end).not.toHaveBeenCalled()
    })
    it('WebGL downgrade buffers frame-ready AND preview-state during its attach (same discipline)', async () => {
      const legacySession: AndroidEmulatorSession = { ...session, generation: 8 }
      api.attach.mockResolvedValueOnce(session)                       // attach do usuário
      let resolveDowngrade!: (value: AndroidEmulatorSession) => void
      // 2ª chamada = downgrade deferred:
      api.attach.mockImplementationOnce(() =>
        new Promise<AndroidEmulatorSession>(resolve => { resolveDowngrade = resolve }))
      api.readFrame.mockResolvedValue(vaf1Buffer(session.generation, 1))
      // Spy É o push passado ao bindPreviewCanvas e DEVOLVE PaintReceipt real
      // (assinatura estrutural idêntica a RgbPaintPush/Vaf1Frame).
      const push = vi.fn((frame: {
        generation: number; seq: number; timestampUs: bigint
        width: number; height: number; pixels: Uint8Array
      }) => ({
        generation: frame.generation, seq: frame.seq, timestampUs: frame.timestampUs,
        width: frame.width, height: frame.height, paintedAtMs: performance.now(),
      }))
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      act(() => view.result.current.bindPreviewCanvas(push))
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 1 })))
      await waitFor(() => expect(push).toHaveBeenCalledTimes(1))       // pipeline vaf1 vivo

      await act(async () => { view.result.current.onWebglTerminalFailure() })
      // Durante o attach do downgrade: wakeup e preview-state são BUFFERIZADOS
      // pela MESMA disciplina attaching/epoch/pending do reattach:
      act(() => readyHandlers.forEach(h => h({ generation: legacySession.generation, seq: 9 })))
      act(() => stateHandlers.forEach(h => h({
        generation: legacySession.generation, source: 'adbFallback',
        requestedFps: 60, degraded: false,
      })))
      expect(api.readFrame).toHaveBeenCalledTimes(1)                   // nenhum read durante o voo
      await act(async () => { resolveDowngrade(legacySession) })
      await waitFor(() => {
        expect(view.result.current.previewState).toMatchObject({
          generation: 8, source: 'adbFallback', degraded: false,
        })
      })
      expect(view.result.current.previewMode).toBe('legacy')           // legado retoma pelo <img>
      act(() => frameHandler?.({
        pngBase64: 'bGVnYWN5', width: 1080, height: 2400, generation: legacySession.generation,
      }))
      expect(view.result.current.frameDataUrl).toContain('bGVnYWN5')
      // Wakeup VAF1 bufferizado morreu com o halted do adbFallback:
      const readsAfter = vi.mocked(api.readFrame.mock.calls).length
      act(() => readyHandlers.forEach(h => h({ generation: legacySession.generation, seq: 10 })))
      expect(vi.mocked(api.readFrame.mock.calls).length).toBe(readsAfter)
      expect(api.attach).toHaveBeenCalledTimes(2)                      // downgrade ÚNICO
      expect(api.detach).not.toHaveBeenCalled()
      expect(api.end).not.toHaveBeenCalled()
    })
    it('captureAnnotation stays CLOSED before a painted receipt and never touches captures', async () => {
      const inspect = vi.fn().mockResolvedValue([])
      ;(window as unknown as { verboo: unknown }).verboo = { inspectFiles: inspect }
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      expect(await view.result.current.captureAnnotation(
        { x: 0, y: 0, width: 0.5, height: 0.5 }, null)).toBeUndefined()
      api.readFrame.mockResolvedValue(vaf1Buffer(session.generation, 1))
      act(() => view.result.current.bindPreviewCanvas(() => null))   // push NUNCA pinta
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 1 })))
      await waitFor(() => expect(api.readFrame).toHaveBeenCalled())
      expect(await view.result.current.captureAnnotation(
        { x: 0, y: 0, width: 0.5, height: 0.5 }, null)).toBeUndefined()
      expect(api.captureScreen).not.toHaveBeenCalled()
      expect(inspect).not.toHaveBeenCalled()
      delete (window as unknown as { verboo?: unknown }).verboo
    })
    it('captureAnnotation returns undefined honestly when inspectFiles lacks physical dims', async () => {
      ;(window as unknown as { verboo: unknown }).verboo = {
        inspectFiles: vi.fn().mockResolvedValue([{ path: '/captures/x.png', size: 12 }]),
      }
      api.captureScreen.mockResolvedValue({ path: '/captures/x.png' })   // coerente com o inspect
      api.readFrame.mockResolvedValue(vaf1Buffer(session.generation, 1))
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      act(() => view.result.current.bindPreviewCanvas(frame => ({
        generation: frame.generation, seq: frame.seq, timestampUs: frame.timestampUs,
        width: frame.width, height: frame.height, paintedAtMs: performance.now(),
      })))
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 1 })))
      await waitFor(() => expect(view.result.current.canvasSize).toEqual({ width: 2, height: 2 }))
      await act(async () => {
        expect(await view.result.current.captureAnnotation(
          { x: 0, y: 0, width: 0.1, height: 0.1 }, null)).toBeUndefined()
      })
      expect(view.result.current.captureFailure).toBe('pngMetaUnavailable')
      const inspect = (window as unknown as { verboo: { inspectFiles: ReturnType<typeof vi.fn> } }).verboo.inspectFiles
      expect(inspect).toHaveBeenCalledWith(['/captures/x.png'])
      delete (window as unknown as { verboo?: unknown }).verboo
    })
  })

  // Pinos Task 8 (F1-pin estabilidade, F2 frameStats, F4 captureAnnotation sucesso).
  // Todos os testes aqui são load-bearing via mutação em produção (M1/M2).
  describe('Task 8 — pins (F1/F2/F4)', () => {
    // Buffer VAF1 íntegro (header 36 + payload w*h*3 para 2x2): parseVaf1 aceita.
    function vaf1Buffer(generation: number, seq: number): ArrayBuffer {
      const width = 2
      const height = 2
      const buf = new ArrayBuffer(36 + width * height * 3)
      const view = new DataView(buf)
      for (const [i, ch] of [...'VAF1'].entries()) view.setUint8(i, ch.charCodeAt(0))
      view.setBigUint64(4, BigInt(generation), true)
      view.setUint32(12, seq, true)
      view.setBigUint64(16, 1_000n, true)
      view.setUint32(24, width, true)
      view.setUint32(28, height, true)
      view.setUint8(32, 1)
      return buf
    }
    it('setStreamRate(30) NÃO recria onWebglTerminalFailure e o downgrade usa a intenção 30 (F1-pin)', async () => {
      api.readFrame.mockResolvedValue(vaf1Buffer(session.generation, 1))
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      expect(api.attach).toHaveBeenLastCalledWith(device.avdName, 60, 1, 'vaf1')

      const callbackBefore = view.result.current.onWebglTerminalFailure
      expect(callbackBefore).toBeTypeOf('function')

      // Mudança de taxa — o callback entregue à folha DEVE ser o mesmo ref.
      await act(async () => { await view.result.current.setStreamRate(30) })
      const callbackAfter = view.result.current.onWebglTerminalFailure
      expect(callbackAfter).toBe(callbackBefore)              // ← pin da estabilidade

      // Downgrade dispara o callback — attach legacyPng consome a INTENÇÃO 30.
      api.captureScreen.mockResolvedValueOnce(undefined)       // força onWebglTerminalFailure path
      await act(async () => { await callbackAfter() })
      expect(api.attach).toHaveBeenLastCalledWith(
        device.avdName, 30, expect.any(Number), 'legacyPng',  // ← pin da intenção
      )
    })

    it('pins hook→frameStats: recordWakeup via rendererDropped (F2)', async () => {
      let rafQueue: Array<() => void> = []
      const originalRaf = window.requestAnimationFrame
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        rafQueue.push(() => cb(performance.now()))
        return rafQueue.length
      }) as typeof window.requestAnimationFrame
      const flushRaf = async () => {
        const queued = rafQueue
        rafQueue = []
        for (const cb of queued) cb()
        for (let tick = 0; tick < 3; tick++) {
          await act(async () => { await Promise.resolve() })
        }
      }

      try {
        // READ em falha → handleReadError halta; 1 wakeup, 0 paints → dropped=1.
        api.readFrame.mockRejectedValueOnce({ code: 'unknown_command' })
        const view = renderHook(() => useAndroidEmulatorPanel())
        await act(async () => { await view.result.current.attach(device.avdName) })
        const push = vi.fn()
        act(() => view.result.current.bindPreviewCanvas(push))

        act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 1 })))
        await flushRaf()
        expect(api.readFrame).toHaveBeenCalledTimes(1)

        // Pin recordWakeup: sem ele wakeups=0 → rendererDropped=max(-1,0)=0 → RED.
        const snap = view.result.current.previewSnapshot()
        expect(snap.rendererDropped).toBe(1)
        expect(snap.presentedFps).toBeUndefined()
      } finally {
        window.requestAnimationFrame = originalRaf
      }
    })

    it('pins hook→frameStats: recordPaint + recordPresented + snapshot via previewSnapshot (F2)', async () => {
      let rafQueue: Array<() => void> = []
      const originalRaf = window.requestAnimationFrame
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        rafQueue.push(() => cb(performance.now()))
        return rafQueue.length
      }) as typeof window.requestAnimationFrame
      const flushRaf = async () => {
        const queued = rafQueue
        rafQueue = []
        for (const cb of queued) cb()
        for (let tick = 0; tick < 3; tick++) {
          await act(async () => { await Promise.resolve() })
        }
      }

      try {
        // Wakeups crescem em seq para passar o filtro `frame.seq > last.seq`.
        api.readFrame
          .mockResolvedValueOnce(vaf1Buffer(session.generation, 1))
          .mockResolvedValueOnce(vaf1Buffer(session.generation, 2))
        const view = renderHook(() => useAndroidEmulatorPanel())
        await act(async () => { await view.result.current.attach(device.avdName) })
        const push = vi.fn().mockImplementation((frame: Vaf1Frame) => ({
          generation: frame.generation, seq: frame.seq, timestampUs: frame.timestampUs,
          width: frame.width, height: frame.height, paintedAtMs: performance.now(),
        }))
        act(() => view.result.current.bindPreviewCanvas(push))

        // 2 wakeups + 2 paints → rendererDropped=0, presentedFps>0.
        // (Pin recordPaint — sem ele paints=0 → rendererDropped=max(2,0)=2 → RED.)
        // (Pin recordPresented — sem ele presentedFps undefined → RED.)
        // (Pin snapshot via previewSnapshot() — sem ele erro → RED.)
        act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 1 })))
        await flushRaf()                                    // drena scheduleVaf1Read → paint 1 → presentedRaf queued
        await flushRaf()                                    // drena presentedRaf → recordPresented(stamp1)
        expect(push).toHaveBeenCalledTimes(1)
        act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 2 })))
        await flushRaf()                                    // drena scheduleVaf1Read → paint 2 → presentedRaf queued
        await flushRaf()                                    // drena presentedRaf → recordPresented(stamp2)
        expect(push).toHaveBeenCalledTimes(2)

        const snap = view.result.current.previewSnapshot()
        expect(snap.rendererDropped).toBe(0)
        expect(snap.presentedFps).toBeGreaterThan(0)
      } finally {
        window.requestAnimationFrame = originalRaf
      }
    })

    it('bindActualFpsNode espelha o sink do presentedFps via rAF ACK (F2 sink)', async () => {
      let rafQueue: Array<() => void> = []
      const originalRaf = window.requestAnimationFrame
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        rafQueue.push(() => cb(performance.now()))
        return rafQueue.length
      }) as typeof window.requestAnimationFrame
      const flushRaf = async () => {
        const queued = rafQueue
        rafQueue = []
        for (const cb of queued) cb()
        for (let tick = 0; tick < 3; tick++) {
          await act(async () => { await Promise.resolve() })
        }
      }

      // Spy performance.now() para BYPASS do throttle 1s (presentedAt é a hora
      // em que o rAF ACK dispara — precisamos avançar o relógio entre paints
      // para `presentedAt - lastFpsUiFlushRef.current >= 1000` passar).
      const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0)
      try {
        api.readFrame
          .mockResolvedValueOnce(vaf1Buffer(session.generation, 1))
          .mockResolvedValueOnce(vaf1Buffer(session.generation, 2))
        const view = renderHook(() => useAndroidEmulatorPanel())
        await act(async () => { await view.result.current.attach(device.avdName) })
        const push = vi.fn().mockImplementation((frame: Vaf1Frame) => ({
          generation: frame.generation, seq: frame.seq, timestampUs: frame.timestampUs,
          width: frame.width, height: frame.height, paintedAtMs: performance.now(),
        }))
        act(() => view.result.current.bindPreviewCanvas(push))

        // Sink inicial via bindActualFpsNode: sem stamps → '—'.
        const node = document.createElement('span')
        act(() => view.result.current.bindActualFpsNode(node))
        expect(node.textContent).toBe('—')

        // Paint 1: presentedAt=100 → throttle (100-0<1000) bloqueia o sink.
        nowSpy.mockReturnValue(100)
        act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 1 })))
        await flushRaf()                                    // drena scheduleVaf1Read → paint 1 → presentedRaf queued
        await flushRaf()                                    // drena presentedRaf → recordPresented(stamp=100) → sink bloqueado
        expect(push).toHaveBeenCalledTimes(1)
        expect(node.textContent).toBe('—')                  // throttle bloqueou

        // Paint 2: presentedAt=1500 → throttle (1500-0>=1000) passa → sink escreve.
        // (Pin do sink dentro do rAF ACK — se removido, textContent permanece '—'.)
        nowSpy.mockReturnValue(1500)
        act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 2 })))
        await flushRaf()                                    // drena scheduleVaf1Read → paint 2 → presentedRaf queued
        await flushRaf()                                    // drena presentedRaf → recordPresented(stamp=1500) → 2 stamps, sink escreve
        expect(push).toHaveBeenCalledTimes(2)
        expect(node.textContent).not.toBe('—')
        expect(node.textContent).toMatch(/^\d+(\.\d+)?$/)
      } finally {
        nowSpy.mockRestore()
        window.requestAnimationFrame = originalRaf
      }
    })

    it('captureAnnotation SUCESSO retorna capture com deviceRect/dims/path/cropBytes (F4)', async () => {
      ;(window as unknown as { verboo: unknown }).verboo = {
        inspectFiles: vi.fn().mockResolvedValue([
          { path: '/captures/x.png', size: 12345, width: 720, height: 1600 },
        ]),
      }
      api.captureScreen.mockResolvedValue({ path: '/captures/x.png' })
      api.readFrame.mockResolvedValue(vaf1Buffer(session.generation, 1))
      const view = renderHook(() => useAndroidEmulatorPanel())
      await act(async () => { await view.result.current.attach(device.avdName) })
      act(() => view.result.current.bindPreviewCanvas(frame => ({
        generation: frame.generation, seq: frame.seq, timestampUs: frame.timestampUs,
        width: frame.width, height: frame.height, paintedAtMs: performance.now(),
      })))
      act(() => readyHandlers.forEach(h => h({ generation: session.generation, seq: 1 })))
      await waitFor(() => expect(view.result.current.canvasSize).toEqual({ width: 2, height: 2 }))

      const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
      const element: AndroidAccessibilityNode = {
        id: 'btn', role: 'Button', label: 'Save',
        frame: { x: 72, y: 320, width: 216, height: 640 },
        enabled: true, visible: true, actionable: true,
      }
      const capture = await act(async () => view.result.current.captureAnnotation(rect, element))
      expect(capture).toBeDefined()
      // Campos CRÍTICOS (mutação em deviceRect → RED):
      expect(capture!.cropPath).toBe('/captures/x.png')
      expect(capture!.viewportPath).toBe('/captures/x.png')
      expect(capture!.cropWidth).toBe(720)
      expect(capture!.cropHeight).toBe(1600)
      expect(capture!.viewportWidth).toBe(720)
      expect(capture!.viewportHeight).toBe(1600)
      expect(capture!.cropBytes).toBe(12345)
      expect(capture!.viewportBytes).toBe(12345)
      expect(capture!.deviceRect).toEqual({
        x: 0.1 * 720, y: 0.2 * 1600, width: 0.3 * 720, height: 0.4 * 1600,
      })
      expect(capture!.rect).toEqual(rect)
      expect(capture!.element).toEqual(element)
      expect(capture!.orientation).toBe('portrait')
      expect(capture!.deviceGeneration).toBe(session.generation)
      expect(capture!.frameGeneration).toBe(session.generation)
      expect(capture!.device.name).toBe(session.device.displayName)
      delete (window as unknown as { verboo?: unknown }).verboo
    })
  })
})
