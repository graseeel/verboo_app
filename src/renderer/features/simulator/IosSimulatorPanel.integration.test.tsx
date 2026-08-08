/**
 * Hook+panel integration: drives useIosSimulatorPanel against a mocked bridge
 * and asserts on the rendered DOM. This is the seam where backend pushes
 * (frames, stream errors, lifecycle events) meet dock actions — and where
 * field defects D1 (failures wiped before they can be seen) and D2 (zombie
 * panel after detach) lived while props-only and hook-only suites stayed
 * green.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import type {
  IosSimulatorFrame,
  IosSimulatorLifecycleSnapshot,
  IosSimulatorPresenceEvent,
  IosSimulatorRequirements,
  IosSimulatorSession,
} from './iosSimulatorApi'
import { IosSimulatorPanel } from './IosSimulatorPanel'
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
  deleteTempFiles: vi.fn(),
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

type HookApi = ReturnType<typeof useIosSimulatorPanel>

function Harness({ hookRef }: { hookRef: { current: HookApi | undefined } }) {
  const simulator = useIosSimulatorPanel()
  hookRef.current = simulator
  return (
    <IosSimulatorPanel
      simulatorOpen={simulator.simulatorOpen}
      simulatorWidth={680}
      onSetWidth={() => {}}
      onClose={simulator.close}
      requirements={simulator.requirements}
      requirementsLoading={simulator.requirementsLoading}
      attachedUdid={simulator.attachedUdid}
      attachedDevice={simulator.attachedDevice}
      frameDataUrl={simulator.frameDataUrl}
      streamSource={simulator.streamSource}
      effectiveFps={simulator.effectiveFps}
      streamFps={simulator.streamFps}
      streamRates={simulator.streamRates}
      fallbackFps={simulator.fallbackFps}
      fallbackRates={simulator.fallbackRates}
      busyUdid={simulator.busyUdid}
      error={simulator.error}
      onAttach={udid => { void simulator.attach(udid) }}
      onDetach={() => { void simulator.detach() }}
      lifecycle={simulator.lifecycle}
      lastMediaFile={simulator.lastMediaFile}
      onEndSimulation={() => { void simulator.endSimulation() }}
      onSystemAction={action => { void simulator.runSystemAction(action) }}
      onCaptureScreen={() => { void simulator.captureScreen() }}
      onToggleRecording={() => { void simulator.toggleRecording() }}
      onRetryAttach={() => { void simulator.retryAttach() }}
      onRetryInteraction={() => { void simulator.retryInteraction() }}
      onRevealOutput={path => { void simulator.revealOutput(path) }}
      onSetStreamRate={fps => { void simulator.setStreamRate(fps) }}
      onSetFallbackRate={fps => { void simulator.setFallbackRate(fps) }}
      onTap={point => { void simulator.tap(point) }}
      onDrag={(from, to, durationMs) => { void simulator.drag(from, to, durationMs) }}
      onTypeText={text => { void simulator.typeText(text) }}
      onPressKey={key => { void simulator.pressKey(key) }}
      onCaptureAnnotation={(_kind, rect) => simulator.captureAnnotation(rect)}
      onDeleteCapture={simulator.deleteCapture}
      onAddAnnotation={() => {}}
      agentPresence={simulator.agentPresence}
      onRefresh={() => { void simulator.refresh() }}
      minWidth={520}
      maxWidth={900}
    />
  )
}

function mjpegFrame(frameGeneration: number): IosSimulatorFrame {
  return {
    udid: 'phone-17-pro',
    dataUrl: `data:image/jpeg;base64,frame-${frameGeneration}`,
    deviceGeneration: 1,
    frameGeneration,
    capturedAtMs: frameGeneration,
    source: 'mjpeg',
    effectiveFps: 29.3,
  }
}

describe('IosSimulatorPanel integration', () => {
  const hookRef: { current: HookApi | undefined } = { current: undefined }
  let frameHandler: ((frame: IosSimulatorFrame) => void) | undefined
  let errorHandler: ((error: { udid: string; message: string }) => void) | undefined
  let lifecycleHandler: ((snapshot: IosSimulatorLifecycleSnapshot) => void) | undefined
  let animationFrames: FrameRequestCallback[]

  function flushAnimationFrames() {
    const pending = animationFrames.splice(0)
    for (const callback of pending) act(() => callback(16))
  }

  async function renderAttachedPanel() {
    render(
      <I18nProvider language="pt-BR">
        <Harness hookRef={hookRef} />
      </I18nProvider>,
    )
    await act(async () => { await hookRef.current?.open() })
    await act(async () => { await hookRef.current?.attach('phone-17-pro') })
    await screen.findByRole('button', { name: 'Início' })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    hookRef.current = undefined
    frameHandler = undefined
    errorHandler = undefined
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
    // every session-end path. The mock emits exactly that payload.
    api.detach.mockImplementation(async () => {
      lifecycleHandler?.(idleLifecycle)
    })
    api.setVisible.mockResolvedValue(undefined)
    api.end.mockImplementation(async () => {
      lifecycleHandler?.(idleLifecycle)
    })
    api.systemAction.mockResolvedValue(undefined)
    api.captureScreen.mockResolvedValue({ path: '/Desktop/screenshot.png', fileName: 'screenshot.png' })
    api.onFrame.mockImplementation((handler: typeof frameHandler) => {
      frameHandler = handler
      return Promise.resolve(() => {})
    })
    api.onError.mockImplementation((handler: typeof errorHandler) => {
      errorHandler = handler
      return Promise.resolve(() => {})
    })
    api.onPresence.mockImplementation(() => Promise.resolve(() => {}))
    api.onOpenRequested.mockImplementation(() => Promise.resolve(() => {}))
    api.onLifecycle.mockImplementation((handler: typeof lifecycleHandler) => {
      lifecycleHandler = handler
      return Promise.resolve(() => {})
    })
  })

  it('keeps a failed dock system action visible while MJPEG frames flow', async () => {
    api.systemAction.mockRejectedValue('o WDA recusou a operação (unknown error): home indisponível')
    await renderAttachedPanel()
    act(() => frameHandler?.(mjpegFrame(1)))
    flushAnimationFrames()

    fireEvent.click(screen.getByRole('button', { name: 'Início' }))
    await waitFor(() => expect(screen.getByRole('alert'))
      .toHaveTextContent('o WDA recusou a operação (unknown error): home indisponível'))

    // The stream keeps flowing at full rate after the failure.
    for (let frameGeneration = 2; frameGeneration <= 40; frameGeneration += 1) {
      act(() => frameHandler?.(mjpegFrame(frameGeneration)))
    }
    flushAnimationFrames()

    expect(screen.getByRole('alert'))
      .toHaveTextContent('o WDA recusou a operação (unknown error): home indisponível')
  })

  it('keeps a failed screenshot capture visible while MJPEG frames flow', async () => {
    api.captureScreen.mockRejectedValue('não foi possível usar a Mesa: permissão negada')
    await renderAttachedPanel()
    act(() => frameHandler?.(mjpegFrame(1)))
    flushAnimationFrames()

    fireEvent.click(screen.getByRole('button', { name: 'Capturar tela' }))
    await waitFor(() => expect(screen.getByRole('alert'))
      .toHaveTextContent('não foi possível usar a Mesa: permissão negada'))

    for (let frameGeneration = 2; frameGeneration <= 40; frameGeneration += 1) {
      act(() => frameHandler?.(mjpegFrame(frameGeneration)))
    }
    flushAnimationFrames()

    expect(screen.getByRole('alert'))
      .toHaveTextContent('não foi possível usar a Mesa: permissão negada')
  })

  it('still auto-clears a stream error once MJPEG frames resume', async () => {
    await renderAttachedPanel()

    act(() => errorHandler?.({ udid: 'phone-17-pro', message: 'stream caiu' }))
    expect(screen.getByRole('alert')).toHaveTextContent('stream caiu')

    act(() => frameHandler?.(mjpegFrame(1)))
    flushAnimationFrames()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('returns to a clean empty state when the end-of-session event arrives after detach', async () => {
    await renderAttachedPanel()
    act(() => frameHandler?.(mjpegFrame(1)))
    flushAnimationFrames()
    expect(screen.getByText('Pronto')).toBeInTheDocument()
    expect(api.detach).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Capturar tela' }))
    await screen.findByText('Salvo como screenshot.png')

    fireEvent.click(screen.getByRole('button', { name: 'Desanexar' }))

    await waitFor(() => expect(screen.getByText('Nenhum simulador anexado')).toBeInTheDocument())
    expect(api.detach).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Pronto')).not.toBeInTheDocument()
    expect(screen.queryByText('Aguardando a primeira captura…')).not.toBeInTheDocument()
    expect(screen.queryByText('Salvo como screenshot.png')).not.toBeInTheDocument()
    expect(screen.getByText('Escolha um simulador')).toBeInTheDocument()

    // The chip unmounts with the dock either way; the stale-state check is
    // that it must NOT resurface on the next session's dock.
    await act(async () => { await hookRef.current?.attach('phone-17-pro') })
    await screen.findByRole('button', { name: 'Início' })
    expect(screen.queryByText('Salvo como screenshot.png')).not.toBeInTheDocument()
  })

  it('surfaces a failed detach instead of leaving a half-cleared panel', async () => {
    api.detach.mockRejectedValue('falha ao interromper o stream')
    await renderAttachedPanel()
    act(() => frameHandler?.(mjpegFrame(1)))
    flushAnimationFrames()

    fireEvent.click(screen.getByRole('button', { name: 'Desanexar' }))

    await waitFor(() => expect(screen.getByRole('alert'))
      .toHaveTextContent('falha ao interromper o stream'))
    // The session is likely still alive: no fake empty state, frame stays.
    expect(screen.queryByText('Nenhum simulador anexado')).not.toBeInTheDocument()
    expect(screen.getByAltText('Prévia visual ao vivo de iPhone 17 Pro')).toBeInTheDocument()
  })
})
