/**
 * androidEmulatorApi tests (PA-25, contract `contrato-android-simulator` —
 * frozen vocabulary 2026-08-19, refined with the `awaiting` protocol;
 * names verbatim, do not rename).
 *
 * Same pattern as iosSimulatorApi.test.ts: invoke + listen mocked,
 * __TAURI_INTERNALS__ toggled per case. What is pinned:
 *   - every frozen command name and its exact payload (the cross-fence
 *     contract with Rust — a rename on either side fails here);
 *   - the `awaiting` resume protocol: setup_start re-invoked with the same
 *     mode plus acceptedLicenses/confirmDownload=true;
 *   - every frozen event channel name and payload forwarding;
 *   - listeners are no-ops outside the Tauri runtime (tests, web preview).
 *
 * FRONTIER: these commands land on the Rust side in PA-24/26/28 — the
 * cross-fence pin (tauriInvokeContract.test.ts) stays RED until then. That
 * is the expected boundary state, declared in the PA-25 report.
 */

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

import { androidEmulatorApi, parseFrameError, parsePreviewState, type AndroidFrameReady } from './androidEmulatorApi'

function defineTauriRuntime() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
}

describe('androidEmulatorApi — frozen setup commands (F0)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('maps requirements and the fresh setup start/cancel verbatim', async () => {
    await androidEmulatorApi.requirements()
    await androidEmulatorApi.setupStart('full')
    await androidEmulatorApi.setupCancel()

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['android_emulator_requirements'],
      ['android_emulator_setup_start', { mode: 'full' }],
      ['android_emulator_setup_cancel'],
    ])
  })

  it('resumes a worker paused at acceptLicenses with acceptedLicenses=true (awaiting protocol)', async () => {
    await androidEmulatorApi.setupStart('full', { acceptedLicenses: true })

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_setup_start', {
      mode: 'full',
      acceptedLicenses: true,
    })
  })

  it('resumes a worker paused before a large download with confirmDownload=true (awaiting protocol)', async () => {
    await androidEmulatorApi.setupStart('toolchain', { confirmDownload: true })

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_setup_start', {
      mode: 'toolchain',
      confirmDownload: true,
    })
  })
})

describe('androidEmulatorApi — frozen F1/F2 command surface', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('maps the session lifecycle commands verbatim', async () => {
    await androidEmulatorApi.attach('Verboo_Device_API_35', 30, 2)
    await androidEmulatorApi.detach()
    await androidEmulatorApi.end()
    await androidEmulatorApi.setVisible(false)

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['android_emulator_attach', { avdName: 'Verboo_Device_API_35', streamFps: 30, fallbackFps: 2 }],
      ['android_emulator_detach'],
      ['android_emulator_end'],
      ['android_emulator_set_visible', { visible: false }],
    ])
  })

  it('maps the stream-rate commands verbatim', async () => {
    await androidEmulatorApi.setStreamRate(15)
    await androidEmulatorApi.setFallbackRate(1)

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['android_emulator_set_stream_rate', { fps: 15 }],
      ['android_emulator_set_fallback_rate', { fps: 1 }],
    ])
  })

  it('maps the input commands verbatim (flat coordinates, frozen key names)', async () => {
    await androidEmulatorApi.tap(120, 340)
    await androidEmulatorApi.drag(10, 20, 300, 400, 250)
    await androidEmulatorApi.typeText('hello android')
    await androidEmulatorApi.pressKey('arrowUp')

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['android_emulator_tap', { x: 120, y: 340 }],
      ['android_emulator_drag', { fromX: 10, fromY: 20, toX: 300, toY: 400, durationMs: 250 }],
      ['android_emulator_type_text', { text: 'hello android' }],
      ['android_emulator_press_key', { key: 'arrowUp' }],
    ])
  })

  it('adds origin manual to every explicit panel input payload', async () => {
    await androidEmulatorApi.tap(120, 340, 'manual')
    await androidEmulatorApi.drag(10, 20, 300, 400, 250, 'manual')
    await androidEmulatorApi.typeText('hello android', 'manual')
    await androidEmulatorApi.pressKey('arrowUp', 'manual')

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['android_emulator_tap', { x: 120, y: 340, origin: 'manual' }],
      ['android_emulator_drag', {
        fromX: 10, fromY: 20, toX: 300, toY: 400, durationMs: 250, origin: 'manual',
      }],
      ['android_emulator_type_text', { text: 'hello android', origin: 'manual' }],
      ['android_emulator_press_key', { key: 'arrowUp', origin: 'manual' }],
    ])
  })

  it('maps system actions verbatim (back|home|recents|notifications|rotate)', async () => {
    await androidEmulatorApi.systemAction('back')
    await androidEmulatorApi.systemAction('notifications')

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['android_emulator_system_action', { action: 'back' }],
      ['android_emulator_system_action', { action: 'notifications' }],
    ])
  })

  it('maps the accessibility and media commands verbatim', async () => {
    vi.mocked(invoke).mockResolvedValue({ path: '/tmp/capture.png' })

    await androidEmulatorApi.accessibilitySnapshot()
    await androidEmulatorApi.inspectPoint(0.5, 0.25)
    await androidEmulatorApi.captureScreen()
    await androidEmulatorApi.recordingStart()
    await androidEmulatorApi.recordingStop()

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['android_emulator_accessibility_snapshot'],
      ['android_emulator_inspect_point', { x: 0.5, y: 0.25 }],
      ['android_emulator_capture_screen'],
      ['android_emulator_recording_start'],
      ['android_emulator_recording_stop'],
    ])
  })
})

describe('androidEmulatorApi — frozen event channels', () => {
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
    const unlisten = await androidEmulatorApi.onFrame(() => {})

    expect(listenMock).not.toHaveBeenCalled()
    expect(() => unlisten()).not.toThrow()
  })

  it('subscribes frame/lifecycle/error/presence channels verbatim and forwards payloads', async () => {
    defineTauriRuntime()
    const frame = vi.fn()
    const lifecycle = vi.fn()
    const error = vi.fn()
    const presence = vi.fn()
    const openRequested = vi.fn()

    await androidEmulatorApi.onFrame(frame)
    await androidEmulatorApi.onLifecycle(lifecycle)
    await androidEmulatorApi.onError(error)
    await androidEmulatorApi.onPresence(presence)
    await androidEmulatorApi.onOpenRequested(openRequested)

    expect(listenMock.mock.calls.map(([name]) => name)).toEqual([
      'android-emulator:frame',
      'android-emulator:lifecycle',
      'android-emulator:error',
      'android-emulator:presence',
      'android-emulator:open-requested',
    ])
    const framePayload = { pngBase64: 'aGVsbG8=', width: 1080, height: 2400, generation: 3 }
    listenMock.mock.calls[0]?.[1]({ payload: framePayload })
    expect(frame).toHaveBeenCalledWith(framePayload)
    const lifecyclePayload = { stage: 'generatingFirstPreview' }
    listenMock.mock.calls[1]?.[1]({ payload: lifecyclePayload })
    expect(lifecycle).toHaveBeenCalledWith(lifecyclePayload)
    const errorPayload = { message: 'adb died' }
    listenMock.mock.calls[2]?.[1]({ payload: errorPayload })
    expect(error).toHaveBeenCalledWith(errorPayload)
    const presencePayload = { generation: 7, phase: 'start', action: 'tap', target: { x: 0.5, y: 0.5 } }
    listenMock.mock.calls[3]?.[1]({ payload: presencePayload })
    expect(presence).toHaveBeenCalledWith(presencePayload)
    listenMock.mock.calls[4]?.[1]({ payload: presencePayload })
    expect(openRequested).toHaveBeenCalledWith(presencePayload)
  })

  it('subscribes the setup channels verbatim and forwards the awaiting field untouched', async () => {
    defineTauriRuntime()
    const progress = vi.fn()
    const done = vi.fn()

    await androidEmulatorApi.onSetupProgress(progress)
    await androidEmulatorApi.onSetupDone(done)

    expect(listenMock).toHaveBeenCalledWith('android-emulator:setup-progress', expect.any(Function))
    expect(listenMock).toHaveBeenCalledWith('android-emulator:setup-done', expect.any(Function))
    const pausePayload = {
      step: 'acceptLicenses',
      awaiting: 'licenses',
      message: 'Android SDK license text…',
    }
    listenMock.mock.calls[0]?.[1]({ payload: pausePayload })
    expect(progress).toHaveBeenCalledWith(pausePayload)
    const donePayload = { ready: false, issue: 'accelMissing' }
    listenMock.mock.calls[1]?.[1]({ payload: donePayload })
    expect(done).toHaveBeenCalledWith(donePayload)
  })
})

describe('androidEmulatorApi — VAF1 wire vocabulary', () => {
  let originalInternals: PropertyDescriptor | undefined

  beforeEach(() => {
    originalInternals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    listenMock.mockClear()
    vi.mocked(invoke).mockClear()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (originalInternals) {
      Object.defineProperty(window, '__TAURI_INTERNALS__', originalInternals)
    } else {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
  })

  it('parses every unit error and degrades malformed envelopes to unavailable', () => {
    for (const code of ['no_frame', 'unavailable', 'unauthenticated', 'unsupported'] as const) {
      expect(parseFrameError({ code })).toEqual({ code })
    }
    expect(parseFrameError({ code: 'no_frame', currentGeneration: 1 })).toEqual({ code: 'unavailable' })
    expect(parseFrameError({ code: 'unavailable', foo: 'bar' })).toEqual({ code: 'unavailable' })
    expect(parseFrameError({ code: 'stale_generation' })).toEqual({ code: 'unavailable' })
    expect(parseFrameError({ code: 'stale_generation', currentGeneration: 2, seq: 9 }))
      .toEqual({ code: 'unavailable' })
    expect(parseFrameError({ code: 'stale_generation', currentGeneration: 0 }))
      .toEqual({ code: 'unavailable' })
    expect(parseFrameError('boom')).toEqual({ code: 'unavailable' })
    expect(parseFrameError(null)).toEqual({ code: 'unavailable' })
  })
  it('keeps stale_generation safe-bound (>=1) and drops anything else', () => {
    expect(parseFrameError({ code: 'stale_generation', currentGeneration: 42 }))
      .toEqual({ code: 'stale_generation', currentGeneration: 42 })
    expect(parseFrameError({
      code: 'stale_generation', currentGeneration: Number.MAX_SAFE_INTEGER,
    })).toEqual({ code: 'stale_generation', currentGeneration: Number.MAX_SAFE_INTEGER })
  })
  it('preview-state guard accepts the frozen shape and rejects extras/zero/unknown', () => {
    const base = { generation: 1, source: 'grpc', requestedFps: 60, degraded: false }
    const parsed = parsePreviewState(base)
    expect(parsed && Object.keys(parsed).sort())
      .toEqual(['degraded', 'generation', 'requestedFps', 'source'])
    expect(parsePreviewState({ ...base, degraded: true, reason: 'gpuSoftware' }))
      .toMatchObject({ degraded: true, reason: 'gpuSoftware' })
    // Pin F-01 (falso positivo no gate): 30 pertence ao domínio congelado 30|60.
    expect(parsePreviewState({ ...base, requestedFps: 30 }))
      .toMatchObject({ requestedFps: 30 })
    expect(parsePreviewState({ ...base, seq: 3 })).toBeNull()
    expect(parsePreviewState({ ...base, generation: 0 })).toBeNull()
    expect(parsePreviewState({ ...base, source: 'vnc' })).toBeNull()
    expect(parsePreviewState({ ...base, requestedFps: 45 })).toBeNull()
    expect(parsePreviewState({ ...base, reason: null, seq: 1 })).toBeNull()
    expect(parsePreviewState(null)).toBeNull()
  })
  it('attach keeps the legacy payload byte-a-byte without previewTransport', async () => {
    await androidEmulatorApi.attach('Verboo_Device_API_35', 30, 2)
    const [, payload] = vi.mocked(invoke).mock.calls.at(-1) as unknown as [string, Record<string, unknown>]
    expect(payload).toEqual({ avdName: 'Verboo_Device_API_35', streamFps: 30, fallbackFps: 2 })
    expect('previewTransport' in payload).toBe(false)
    await androidEmulatorApi.attach('AVD', 60, 1, 'vaf1')
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('android_emulator_attach',
      { avdName: 'AVD', streamFps: 60, fallbackFps: 1, previewTransport: 'vaf1' })
    await androidEmulatorApi.attach('AVD', 60, 1, 'legacyPng')
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('android_emulator_attach',
      { avdName: 'AVD', streamFps: 60, fallbackFps: 1, previewTransport: 'legacyPng' })
  })
  it('subscribes frame-ready/preview-state channels verbatim and maps readFrame', async () => {
    defineTauriRuntime()
    const ready = vi.fn<(ready: AndroidFrameReady) => void>()
    const state = vi.fn()
    await androidEmulatorApi.onFrameReady(ready)
    await androidEmulatorApi.onPreviewState(state)
    expect(listenMock.mock.calls.map(([name]) => name))
      .toEqual(['android-emulator:frame-ready', 'android-emulator:preview-state'])
    listenMock.mock.calls[0]?.[1]({ payload: { generation: 3, seq: 5 } })
    expect(ready).toHaveBeenCalledWith({ generation: 3, seq: 5 })
    vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(48))
    await androidEmulatorApi.readFrame(3)
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('android_emulator_read_frame', { generation: 3 })
  })
})
