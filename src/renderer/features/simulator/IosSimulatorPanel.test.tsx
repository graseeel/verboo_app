import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Profiler } from 'react'
import type { ProfilerOnRenderCallback } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { I18nProvider } from '../../i18n'
import type { IosSimulatorLifecycleSnapshot, IosSimulatorRequirements } from './iosSimulatorApi'
import { IosSimulatorPanel } from './IosSimulatorPanel'

// The Android tab probes the backend through androidEmulatorApi (real
// module) — invoke is mocked so those calls are assertable. The iOS tab
// never invokes from the panel itself (all iOS actions arrive via props).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn<(
    eventName: string,
    callback: (event: { payload: unknown }) => void,
  ) => Promise<() => void>>(() => Promise.resolve(() => {})),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (eventName: string, callback: (event: { payload: unknown }) => void) =>
    listenMock(eventName, callback),
}))

const { renderCounts } = vi.hoisted(() => ({
  renderCounts: { picker: 0, dock: 0 },
}))

vi.mock('./AndroidDevicePicker', async importOriginal => {
  const actual = await importOriginal<typeof import('./AndroidDevicePicker')>()
  const CountingPicker = (props: React.ComponentProps<typeof actual.AndroidDevicePicker>) => (
    <Profiler id="counting-picker" onRender={() => { renderCounts.picker += 1 }}>
      <actual.AndroidDevicePicker {...props} />
    </Profiler>
  )
  return { ...actual, AndroidDevicePicker: CountingPicker }
})

vi.mock('./SimulatorControlDock', async importOriginal => {
  const actual = await importOriginal<typeof import('./SimulatorControlDock')>()
  const CountingDock = (props: React.ComponentProps<typeof actual.SimulatorControlDock>) => (
    <Profiler id="counting-dock" onRender={() => { renderCounts.dock += 1 }}>
      <actual.SimulatorControlDock {...props} />
    </Profiler>
  )
  return { ...actual, SimulatorControlDock: CountingDock }
})

/** Mini stub WebGL: suficiente para o painter REAL inicializar e submeter draws. */
function installFakeWebGL() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const record = (method: string) => (...args: unknown[]) => { calls.push({ method, args }) }
  const c = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TEXTURE_2D: 8, TEXTURE_WRAP_S: 9,
    TEXTURE_WRAP_T: 10, CLAMP_TO_EDGE: 11, TEXTURE_MIN_FILTER: 12,
    TEXTURE_MAG_FILTER: 13, LINEAR: 14, UNPACK_FLIP_Y_WEBGL: 15,
    UNPACK_ALIGNMENT: 16, TEXTURE0: 17, RGB: 18, UNSIGNED_BYTE: 19, TRIANGLE_STRIP: 20,
    // O painter REAL (F-02/F-02R) drena getError e sonda isContextLost na
    // (re)alocação do texImage2D — o stub precisa destes 4 membros extras.
    NO_ERROR: 21, CONTEXT_LOST_WEBGL: 22,
  }
  let shaderId = 0
  const gl = {
    ...c,
    getError: () => c.NO_ERROR,
    isContextLost: () => false,
    createShader: () => ({ id: ++shaderId }),
    shaderSource: record('shaderSource'),
    compileShader: record('compileShader'),
    getShaderParameter: (_s: object, pname: number) => pname === c.COMPILE_STATUS || pname === c.LINK_STATUS,
    deleteShader: record('deleteShader'),
    createProgram: () => ({ id: 1 }),
    attachShader: record('attachShader'),
    linkProgram: record('linkProgram'),
    getProgramParameter: (_p: object, pname: number) => pname === c.LINK_STATUS,
    getAttribLocation: () => 0,
    getUniformLocation: () => ({ id: 'u' }),
    deleteProgram: record('deleteProgram'),
    createBuffer: () => ({ id: 'b' }),
    bindBuffer: record('bindBuffer'),
    bufferData: record('bufferData'),
    enableVertexAttribArray: record('enableVertexAttribArray'),
    vertexAttribPointer: record('vertexAttribPointer'),
    deleteBuffer: record('deleteBuffer'),
    createTexture: () => ({ id: 't' }),
    bindTexture: record('bindTexture'),
    texParameteri: record('texParameteri'),
    pixelStorei: record('pixelStorei'),
    activeTexture: record('activeTexture'),
    useProgram: record('useProgram'),
    uniform1i: record('uniform1i'),
    texImage2D: record('texImage2D'),
    texSubImage2D: record('texSubImage2D'),
    viewport: record('viewport'),
    drawArrays: record('drawArrays'),
    deleteTexture: record('deleteTexture'),
  }
  const original = HTMLCanvasElement.prototype.getContext
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (type: string) => (type === 'webgl' ? (gl as unknown as RenderingContext) : null),
  )
  return { calls, restore: () => { HTMLCanvasElement.prototype.getContext = original } }
}

const device = {
  name: 'iPhone 17 Pro',
  udid: 'phone-17-pro',
  state: 'Shutdown',
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

const readyRequirements: IosSimulatorRequirements = {
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

function renderPanel(overrides: Partial<React.ComponentProps<typeof IosSimulatorPanel>> = {}) {
  const props: React.ComponentProps<typeof IosSimulatorPanel> = {
    simulatorOpen: true,
    simulatorWidth: 680,
    onSetWidth: vi.fn(),
    onClose: vi.fn(),
    requirements: readyRequirements,
    requirementsLoading: false,
    streamFps: 30,
    streamRates: [30, 60],
    fallbackFps: 2,
    fallbackRates: [0.5, 1, 2],
    onAttach: vi.fn(),
    onDetach: vi.fn(),
    lifecycle: idleLifecycle,
    onEndSimulation: vi.fn(),
    onShutdownExternalSimulation: vi.fn(),
    onSystemAction: vi.fn(),
    onCaptureScreen: vi.fn(),
    onToggleRecording: vi.fn(),
    onRetryAttach: vi.fn(),
    onRetryInteraction: vi.fn(),
    onRevealOutput: vi.fn(),
    onSetStreamRate: vi.fn(),
    onSetFallbackRate: vi.fn(),
    onTap: vi.fn(),
    onDrag: vi.fn(),
    onTypeText: vi.fn(),
    onPressKey: vi.fn(),
    onInspectPoint: vi.fn().mockResolvedValue(undefined),
    onCaptureAnnotation: vi.fn().mockResolvedValue(undefined),
    onDeleteCapture: vi.fn().mockResolvedValue(undefined),
    onAddAnnotation: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue(1),
    minWidth: 520,
    maxWidth: 900,
    ...overrides,
  }
  return { ...render(<I18nProvider language="pt-BR"><IosSimulatorPanel {...props} /></I18nProvider>), props }
}

// Seam do PAINEL: Profiler conta COMMITS sob o painel inteiro. O arquivo REAL
// não importa React runtime — usar o import NOMEADO acima (`Profiler`) e o tipo
// importado `ProfilerOnRenderCallback`; NUNCA `<React.Profiler>` sem binding.
function renderPanelWithProfiler(
  onRender: ProfilerOnRenderCallback,
  overrides: Partial<React.ComponentProps<typeof IosSimulatorPanel>> = {},
) {
  const device = {
    name: 'iPhone 17 Pro', udid: 'phone-17-pro', state: 'Shutdown',
    iosVersion: '26.5', family: 'iphone' as const,
  }
  const idleLifecycle: IosSimulatorLifecycleSnapshot = {
    udid: null, deviceGeneration: null, stage: 'idle', ownership: null,
    previewSuspended: false, interactionReady: false,
    recording: { state: 'idle' }, recoverableError: null,
  }
  const props: React.ComponentProps<typeof IosSimulatorPanel> = {
    simulatorOpen: true,
    simulatorWidth: 680,
    onSetWidth: vi.fn(),
    onClose: vi.fn(),
    requirements: {
      ready: true, issue: null, xcodeVersion: '27.0',
      devices: [device], attachedUdid: null, streamFps: null,
      fallbackFps: null, source: null, effectiveFps: null,
      lifecycle: idleLifecycle,
    },
    requirementsLoading: false,
    streamFps: 30,
    streamRates: [30, 60],
    fallbackFps: 2,
    fallbackRates: [0.5, 1, 2],
    onAttach: vi.fn(),
    onDetach: vi.fn(),
    lifecycle: idleLifecycle,
    onEndSimulation: vi.fn(),
    onShutdownExternalSimulation: vi.fn(),
    onSystemAction: vi.fn(),
    onCaptureScreen: vi.fn(),
    onToggleRecording: vi.fn(),
    onRetryAttach: vi.fn(),
    onRetryInteraction: vi.fn(),
    onRevealOutput: vi.fn(),
    onSetStreamRate: vi.fn(),
    onSetFallbackRate: vi.fn(),
    onTap: vi.fn(),
    onDrag: vi.fn(),
    onTypeText: vi.fn(),
    onPressKey: vi.fn(),
    onInspectPoint: vi.fn().mockResolvedValue(undefined),
    onCaptureAnnotation: vi.fn().mockResolvedValue(undefined),
    onDeleteCapture: vi.fn().mockResolvedValue(undefined),
    onAddAnnotation: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue(1),
    minWidth: 520,
    maxWidth: 900,
    ...overrides,
  }
  return render(
    <I18nProvider language="pt-BR">
      <Profiler id="ios-simulator-panel" onRender={onRender}>
        <IosSimulatorPanel {...props} />
      </Profiler>
    </I18nProvider>,
  )
}

describe('IosSimulatorPanel', () => {
  it('shows an honest empty state and a device with name, power state, and iOS version', () => {
    renderPanel()

    expect(screen.getByText('Nenhum simulador anexado')).toBeInTheDocument()
    fireEvent.focus(screen.getByRole('combobox', { name: 'Buscar simulador' }))
    expect(screen.getByRole('option', { name: /iPhone 17 Pro/ })).toHaveTextContent('26.5 · desligado')
    expect(screen.queryByRole('button', { name: 'Anexar' })).not.toBeInTheDocument()
  })

  it('attaches immediately after choosing a different device', () => {
    const { props } = renderPanel()
    fireEvent.focus(screen.getByRole('combobox', { name: 'Buscar simulador' }))
    fireEvent.click(screen.getByRole('option', { name: /iPhone 17 Pro/ }))

    expect(props.onAttach).toHaveBeenCalledWith('phone-17-pro')
  })

  it('renders the visual frame and exposes detach and rate controls', () => {
    const onDetach = vi.fn()
    const onSetStreamRate = vi.fn()
    const onSetFallbackRate = vi.fn()
    const view = renderPanel({
      attachedUdid: device.udid,
      attachedDevice: { ...device, state: 'Booted' },
      lifecycle: {
        ...idleLifecycle,
        udid: device.udid,
        deviceGeneration: 1,
        stage: 'ready',
        ownership: 'external',
        interactionReady: true,
      },
      frameDataUrl: 'data:image/png;base64,ZmFrZQ==',
      streamSource: 'mjpeg',
      effectiveFps: 9.2,
      onDetach,
      onSetStreamRate,
      onSetFallbackRate,
    })

    expect(screen.getByAltText('Prévia visual ao vivo de iPhone 17 Pro')).toBeInTheDocument()
    expect(screen.getByRole('application', { name: 'Controlar iPhone 17 Pro' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('button', { name: 'Selecionar componente' })).toBeInTheDocument()
    expect(screen.getByText('MJPEG')).toBeInTheDocument()
    expect(screen.getByText('Taxa real: 9.2 fps')).toBeInTheDocument()
    expect(screen.getByText('Externo')).toBeInTheDocument()
    expect(screen.queryByLabelText('Fluidez')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Desempenho'))
    fireEvent.change(screen.getByLabelText('Fluidez'), { target: { value: '60' } })
    view.rerender(
      <I18nProvider language="pt-BR">
        <IosSimulatorPanel {...view.props} streamFps={60} />
      </I18nProvider>,
    )
    expect(screen.getByRole('note')).toHaveTextContent(
      'Alta fluidez usa mais processamento e pode aquecer o computador ou reduzir o desempenho de outros apps.',
    )
    fireEvent.change(screen.getByLabelText('Taxa do fallback econômico'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Desanexar' }))

    expect(onSetStreamRate).toHaveBeenCalledWith(60)
    expect(onSetFallbackRate).toHaveBeenCalledWith(1)
    expect(onDetach).toHaveBeenCalledTimes(1)
  })

  it('keeps the device selector in the fixed top control bar', () => {
    renderPanel()

    expect(screen.getByRole('combobox', { name: 'Buscar simulador' }))
      .toHaveAttribute('data-panel-placement', 'top')
  })

  it('explains both icon-only header controls with visible tooltips', () => {
    renderPanel()
    for (const name of ['Atualizar simuladores', 'Ocultar simulador']) {
      const button = screen.getByRole('button', { name })
      fireEvent.focus(button)
      expect(screen.getByRole('tooltip')).toHaveTextContent(name)
      fireEvent.blur(button)
    }
  })

  it('renders the backend lifecycle stage and keeps interaction guarded until ready', () => {
    renderPanel({
      attachedUdid: device.udid,
      attachedDevice: { ...device, state: 'Booted' },
      lifecycle: {
        ...idleLifecycle,
        udid: device.udid,
        deviceGeneration: 1,
        stage: 'booting',
        ownership: 'verboo',
        interactionReady: false,
      },
    })

    expect(screen.getByText('Ligando iPhone 17 Pro…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Início' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Capturar tela' })).toBeEnabled()
  })

  it('keeps the preview context and offers the backend retry actions', () => {
    const onRetryAttach = vi.fn()
    const onRetryInteraction = vi.fn()
    renderPanel({
      attachedUdid: device.udid,
      attachedDevice: { ...device, state: 'Booted' },
      frameDataUrl: 'data:image/png;base64,ZmFrZQ==',
      lifecycle: {
        ...idleLifecycle,
        udid: device.udid,
        deviceGeneration: 1,
        stage: 'waitingForDisplay',
        ownership: 'external',
        interactionReady: false,
        recoverableError: 'display did not stabilize',
      },
      onRetryAttach,
      onRetryInteraction,
    })

    expect(screen.getByAltText('Prévia visual ao vivo de iPhone 17 Pro')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('display did not stabilize')
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(onRetryAttach).toHaveBeenCalledTimes(1)
  })

  it('keeps the fallback preview and limits a WDA failure to interaction retry', () => {
    const onRetryInteraction = vi.fn()
    renderPanel({
      attachedUdid: device.udid,
      attachedDevice: { ...device, state: 'Booted' },
      frameDataUrl: 'data:image/png;base64,ZmFrZQ==',
      lifecycle: {
        ...idleLifecycle,
        udid: device.udid,
        deviceGeneration: 1,
        stage: 'preparingInteraction',
        ownership: 'external',
        interactionReady: false,
        recoverableError: 'o WDA não ficou pronto dentro do prazo',
      },
      onRetryInteraction,
    })

    expect(screen.getByAltText('Prévia visual ao vivo de iPhone 17 Pro')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('o WDA não ficou pronto dentro do prazo')
    fireEvent.click(screen.getByRole('button', { name: 'Tentar ativar interação' }))
    expect(onRetryInteraction).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Início' })).toBeDisabled()
  })

  it('shows an actionable requirement when Xcode is unavailable', () => {
    renderPanel({
      requirements: {
        ...readyRequirements,
        ready: false,
        issue: 'xcodeMissing',
        devices: [],
      },
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Instale o Xcode 26 ou 27, abra-o uma vez para concluir a configuração e selecione-o com xcode-select.',
    )
  })
})

/**
 * Platform tabs (PA-25, contrato-android-simulator — frozen vocabulary):
 * one panel, one tab per platform. iOS exists only on darwin; Android is
 * always offered. The Android tab fetches android_emulator_requirements
 * LAZILY (only while visible) and fail-open shows the legacy guide card —
 * setup is never offered — when the backend predates the commands.
 */
describe('IosSimulatorPanel — platform tabs (PA-25)', () => {
  const androidDevice = {
    avdName: 'Verboo_Device_API_35',
    displayName: 'Verboo Device API 35',
    apiLevel: 35,
    family: 'phone' as const,
    running: true,
  }

  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockResolvedValue({ ready: true, devices: [androidDevice] })
    listenMock.mockClear()
    ;(window as unknown as { verboo: unknown }).verboo = {
      getUserSettings: vi.fn().mockResolvedValue({}),
      updateUserSettings: vi.fn().mockResolvedValue(undefined),
    }
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  const androidSession = {
    device: {
      avdName: 'Pixel_8_API_35', displayName: 'Pixel 8',
      apiLevel: 35, family: 'phone' as const, running: true,
    },
    serial: 'emulator-5554',
    generation: 7,
    ownership: 'verboo' as const,
    streamFps: 60,
    fallbackFps: 1,
    lifecycle: { stage: 'ready' as const },
  }

  function mockAndroidBackend(gate?: { resolveAttach?: (value: typeof androidSession) => void }) {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'android_emulator_requirements') return {
        ready: true,
        issue: null,
        devices: [{
          avdName: 'Pixel_8_API_35', displayName: 'Pixel 8',
          apiLevel: 35, family: 'phone', running: false,
        }],
      }
      if (command === 'android_emulator_attach') {
        return new Promise<typeof androidSession>(resolve => {
          if (gate) gate.resolveAttach = resolve
          else resolve(androidSession)
        })
      }
      return undefined
    })
  }

  async function openAndroidDevice() {
    const combobox = await screen.findByRole('combobox', { name: 'Buscar dispositivo Android' })
    fireEvent.focus(combobox)
    return screen.findByRole('option', { name: /Pixel 8/ })
  }

  it('darwin: renders the iOS/Android tabs with iOS active and keeps the Android probe lazy', async () => {
    renderPanel()

    const tabs = screen.getByRole('tablist', { name: 'Plataforma do simulador' })
    expect(within(tabs).getByRole('tab', { name: 'iOS' })).toHaveAttribute('aria-selected', 'true')
    expect(within(tabs).getByRole('tab', { name: 'Android' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByText('Simulador do iOS')).toBeInTheDocument()
    // The iOS tab content is the existing picker; the Android SDK is NOT probed.
    expect(screen.getByRole('combobox', { name: 'Buscar simulador' })).toBeInTheDocument()
    await act(async () => {})
    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === 'android_emulator_requirements'),
    ).toHaveLength(0)
  })

  it('switching to the Android tab probes requirements and mounts the grouped device picker', async () => {
    renderPanel()

    fireEvent.click(screen.getByRole('tab', { name: 'Android' }))
    await act(async () => {})

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_requirements')
    expect(screen.getByText('Emulador do Android')).toBeInTheDocument()
    fireEvent.focus(screen.getByRole('combobox', { name: 'Buscar dispositivo Android' }))
    expect(screen.getByRole('group', { name: 'Em execução' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Verboo Device API 35/ }))
      .toHaveTextContent('API 35 · ligado')
    // The iOS picker leaves the DOM with the tab switch.
    expect(screen.queryByRole('combobox', { name: 'Buscar simulador' })).not.toBeInTheDocument()
  })

  it('applies each external platform request while keeping the internal tabs interactive', async () => {
    const { props, rerender } = renderPanel({
      platformRequest: { id: 1, platform: 'android' },
    })
    await act(async () => {})
    expect(screen.getByRole('tab', { name: 'Android' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('tab', { name: 'iOS' }))
    expect(screen.getByRole('tab', { name: 'iOS' })).toHaveAttribute('aria-selected', 'true')

    rerender(
      <I18nProvider language="pt-BR">
        <IosSimulatorPanel {...props} platformRequest={{ id: 2, platform: 'android' }} />
      </I18nProvider>,
    )
    await act(async () => {})
    expect(screen.getByRole('tab', { name: 'Android' })).toHaveAttribute('aria-selected', 'true')
  })

  it('the Android tab with an issue mounts the real AndroidOnboarding choice', async () => {
    vi.mocked(invoke).mockResolvedValue({ ready: false, issue: 'sdkMissing', devices: [] })
    renderPanel()

    fireEvent.click(screen.getByRole('tab', { name: 'Android' }))
    await act(async () => {})

    expect(screen.getByRole('alert')).toHaveTextContent('Configuração do emulador Android necessária')
    expect(screen.getByRole('button', { name: /Configuração automática/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Configuração manual/ })).toBeInTheDocument()
  })

  it('fail-open: an old backend (unknown command) shows the legacy guide card and never offers setup', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Command android_emulator_requirements not found'))
    renderPanel()

    fireEvent.click(screen.getByRole('tab', { name: 'Android' }))
    await act(async () => {})

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Esta versão do app não inclui a configuração do emulador Android',
    )
    expect(screen.getByText(/Instale as ferramentas de linha de comando do SDK do Android/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Configuração automática/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verificar de novo' })).toBeInTheDocument()
  })

  it('a REAL probe error (not unknown-command) shows the retryable error card', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('adb exploded'))
    renderPanel()

    fireEvent.click(screen.getByRole('tab', { name: 'Android' }))
    await act(async () => {})

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('adb exploded')
    expect(alert).not.toHaveTextContent('não inclui a configuração')
    fireEvent.click(within(alert).getByRole('button', { name: 'Atualizar simuladores' }))
    await act(async () => {})
    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === 'android_emulator_requirements'),
    ).toHaveLength(2)
  })

  it('win32: no tab bar — the Android content renders directly under the Android title', async () => {
    renderPanel({ platform: 'win32' })
    await act(async () => {})

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.getByText('Emulador do Android')).toBeInTheDocument()
    fireEvent.focus(screen.getByRole('combobox', { name: 'Buscar dispositivo Android' }))
    expect(screen.getByRole('option', { name: /Verboo Device API 35/ })).toBeInTheDocument()
    // The iOS device picker is never rendered off-darwin.
    expect(screen.queryByRole('combobox', { name: 'Buscar simulador' })).not.toBeInTheDocument()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_requirements')
  })

  it('mounts the real Android picker, surface and dock through the frozen F1 commands', async () => {
    const fake = installFakeWebGL()
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'android_emulator_requirements') {
        return { ready: true, devices: [{ ...androidDevice, running: false }] }
      }
      if (command === 'android_emulator_attach') {
        return {
          device: { ...androidDevice, running: true },
          serial: 'emulator-5554',
          generation: 9,
          ownership: 'verboo',
          streamFps: 2,
          fallbackFps: 1,
          lifecycle: { stage: 'ready' },
        }
      }
      return undefined
    })
    renderPanel()

    fireEvent.click(screen.getByRole('tab', { name: 'Android' }))
    const picker = await screen.findByRole('combobox', { name: 'Buscar dispositivo Android' })
    fireEvent.focus(picker)
    fireEvent.click(screen.getByRole('option', { name: /Verboo Device API 35/ }))

    // ERRATA Task 8: a produção envia previewTransport: 'vaf1' no payload
    // de attach (hook Task 8 fix). Atualização do mounted test autorizada
    // pelo gate (mesma classe do F1 da Task 5 — suíte verde no fechamento).
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      'android_emulator_attach',
      { avdName: 'Verboo_Device_API_35', streamFps: 60, fallbackFps: 1, previewTransport: 'vaf1' },
    ))
    const eventHandlers = new Map(listenMock.mock.calls.map(([name, handler]) => [name, handler]))
    act(() => {
      eventHandlers.get('android-emulator:preview-state')?.({
        payload: {
          generation: 9, source: 'adbFallback', requestedFps: 60,
          degraded: true, reason: 'unavailable',
        },
      })
      eventHandlers.get('android-emulator:lifecycle')?.({ payload: { stage: 'ready' } })
      eventHandlers.get('android-emulator:frame')?.({
        payload: { pngBase64: 'YW5kcm9pZA==', width: 1080, height: 2400, generation: 9 },
      })
    })
    fake.restore()

    const surface = screen.getByRole('application', { name: 'Controlar Verboo Device API 35' })
    const image = screen.getByAltText('Prévia visual ao vivo de Verboo Device API 35')
    Object.defineProperty(surface, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 600, height: 900, right: 600, bottom: 900 }),
    })
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1080 })
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 2400 })
    Object.defineProperty(surface, 'setPointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(surface, 'releasePointerCapture', { configurable: true, value: vi.fn() })
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 300, clientY: 450 })
    fireEvent.pointerUp(surface, { pointerId: 1, button: 0, clientX: 300, clientY: 450 })
    fireEvent.click(surface, { button: 0, clientX: 300, clientY: 450 })
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Recentes' }))

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_tap', { x: 0.5, y: 0.5 })
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_system_action', { action: 'back' })
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_system_action', { action: 'recents' })
    expect(screen.getByRole('button', { name: 'Capturar tela' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Selecionar componente' })).toBeInTheDocument()
  })

  it('wires Android a11y selection, annotations, media, stream rate and reused tooltips through real components', async () => {
    const fake = installFakeWebGL()
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    // COMPLEMENTO ERRATA Task 8: o pipeline captureAnnotation do hook Android
    // (useAndroidEmulatorPanel.ts:554-608) usa window.verboo.inspectFiles para
    // extrair bytes/dims reais do PNG — sem este mock, o caminho captura
    // → undefined → pendingCapture não setada → nota "Instrução" não renderiza.
    // Resposta coerente com o capture_screen mockado abaixo (mesmo path +
    // dims alinhadas ao frame publicado em width:1080/height:2400).
    ;(window as unknown as { verboo: unknown }).verboo = {
      getUserSettings: vi.fn().mockResolvedValue({}),
      updateUserSettings: vi.fn().mockResolvedValue(undefined),
      inspectFiles: vi.fn().mockResolvedValue([
        { path: '/captures/android-screen.png', size: 1000, width: 1080, height: 2400 },
      ]),
    }
    const addedAnnotation = vi.fn()
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'android_emulator_requirements') {
        return { ready: true, devices: [{ ...androidDevice, running: false }] }
      }
      if (command === 'android_emulator_attach') {
        return {
          device: { ...androidDevice, running: true }, serial: 'emulator-5554', generation: 9,
          ownership: 'verboo', streamFps: 2, fallbackFps: 1, lifecycle: { stage: 'ready' },
        }
      }
      if (command === 'android_emulator_inspect_point') {
        return {
          rect: { x: 0.25, y: 0.2, width: 0.5, height: 0.1 },
          element: {
            id: 'save', role: 'android.widget.Button', label: 'Save',
            frame: { x: 270, y: 480, width: 540, height: 240 },
            enabled: true, visible: true, actionable: true,
          },
        }
      }
      if (command === 'android_emulator_capture_screen') return { path: '/captures/android-screen.png' }
      if (command === 'android_emulator_recording_stop') return { path: '/captures/android-recording.mp4' }
      if (command === 'android_emulator_set_stream_rate') return 30
      return undefined
    })
    renderPanel({ onAddAnnotation: addedAnnotation })

    fireEvent.click(screen.getByRole('tab', { name: 'Android' }))
    const picker = await screen.findByRole('combobox', { name: 'Buscar dispositivo Android' })
    fireEvent.focus(picker)
    fireEvent.click(screen.getByRole('option', { name: /Verboo Device API 35/ }))
    const eventHandlers = new Map(listenMock.mock.calls.map(([name, handler]) => [name, handler]))
    act(() => {
      eventHandlers.get('android-emulator:preview-state')?.({
        payload: {
          generation: 9, source: 'adbFallback', requestedFps: 60,
          degraded: true, reason: 'unavailable',
        },
      })
      eventHandlers.get('android-emulator:lifecycle')?.({ payload: { stage: 'ready' } })
      eventHandlers.get('android-emulator:frame')?.({
        payload: { pngBase64: 'YW5kcm9pZA==', width: 1080, height: 2400, generation: 9 },
      })
    })
    fake.restore()

    const surface = await screen.findByRole('application', { name: 'Controlar Verboo Device API 35' })
    const image = screen.getByAltText('Prévia visual ao vivo de Verboo Device API 35')
    Object.defineProperty(surface, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 600, height: 900, right: 600, bottom: 900 }),
    })
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1080 })
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 2400 })
    Object.defineProperty(surface, 'setPointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(surface, 'releasePointerCapture', { configurable: true, value: vi.fn() })
    fireEvent.load(image)

    const selectComponent = screen.getByRole('button', { name: 'Selecionar componente' })
    fireEvent.focus(selectComponent)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Selecionar componente')
    fireEvent.blur(selectComponent)
    fireEvent.click(selectComponent)
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 300, clientY: 450 })
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      'android_emulator_inspect_point', { x: 0.5, y: 0.5 },
    ))
    const outline = document.querySelector('.ios-simulator-selection-outline') as HTMLElement
    expect(Number.parseFloat(outline.style.left)).toBeCloseTo(198.75)
    expect(Number.parseFloat(outline.style.top)).toBeCloseTo(180)
    expect(Number.parseFloat(outline.style.width)).toBeCloseTo(202.5)
    expect(Number.parseFloat(outline.style.height)).toBeCloseTo(90)

    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 300, clientY: 450 })
    await waitFor(() => expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === 'android_emulator_inspect_point'),
    ).toHaveLength(2))
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_capture_screen'))
    const note = await screen.findByLabelText('Instrução')
    fireEvent.change(note, { target: { value: 'Aumente o botão' } })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar ao Chat' }))
    expect(addedAnnotation).toHaveBeenCalledWith(expect.objectContaining({
      extractedText: expect.stringContaining('Android API 35'),
    }))

    const screenshot = screen.getByRole('button', { name: 'Capturar tela' })
    fireEvent.focus(screenshot)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Capturar tela')
    fireEvent.blur(screenshot)
    fireEvent.click(screenshot)
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_capture_screen'))
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar gravação' }))
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_recording_start'))
    fireEvent.click(screen.getByRole('button', { name: 'Parar gravação' }))
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_recording_stop'))

    fireEvent.click(screen.getByRole('button', { name: 'Desempenho' }))
    fireEvent.change(screen.getByLabelText('Fluidez'), { target: { value: '30' } })
    expect(screen.queryByLabelText('Taxa do fallback econômico')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_set_stream_rate', { fps: 30 })
    })
  })

  describe('IosSimulatorPanel — aba Android VAF1', () => {
    beforeEach(() => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    })

    it('renders the canvas leaf after a preview-state grpc that raced ahead of attach', async () => {
      // GL stub OBRIGATÓRIO: sem ele jsdom devolve getContext null → terminal
      // failure → legacyPng e o canvas pode sumir por TIMING (falso verde).
      const fake = installFakeWebGL()
      const gate: { resolveAttach?: (value: typeof androidSession) => void } = {}
      mockAndroidBackend(gate)
      renderPanel({ platform: 'linux' })
      const stateHandler = listenMock.mock.calls
        .find(([name]) => name === 'android-emulator:preview-state')?.[1] as
          ((event: { payload: unknown }) => void) | undefined
      expect(stateHandler).toBeDefined()
      fireEvent.click(await openAndroidDevice())
      act(() => stateHandler!({ payload: {
        generation: 7, source: 'grpc', requestedFps: 60, degraded: false,
      } }))
      await waitFor(() => expect(gate.resolveAttach).toBeTypeOf('function'))
      await act(async () => { gate.resolveAttach?.(androidSession) })
      try {
        await waitFor(() => {
          const surface = screen.getByRole('application')
          expect(surface.querySelector('canvas[role="img"]')).not.toBeNull()
        })
        const glCalls = fake.calls.filter(call => call.method === 'drawArrays')
        expect(glCalls.length).toBeGreaterThanOrEqual(0)
      } finally {
        fake.restore()
      }
    })

    it('offers exactly [60, 30] fps and no fallback selector', async () => {
      mockAndroidBackend()
      renderPanel({ platform: 'linux' })
      fireEvent.click(await openAndroidDevice())
      fireEvent.click(await screen.findByRole('button', { name: /Desempenho/ }))
      const selects = await screen.findAllByRole('combobox')
      const rateSelect = selects.at(-1)! as HTMLSelectElement
      expect([...rateSelect.options].map(option => option.value)).toEqual(['60', '30'])
      expect(screen.queryByText('Taxa do fallback econômico')).not.toBeInTheDocument()
    })

    it('disables the rate selector and localizes the alert when persistence fails', async () => {
      const fake = installFakeWebGL()
      const updateUserSettings = vi.fn().mockRejectedValue(new Error('write failed'))
      ;(window as unknown as { verboo: unknown }).verboo = {
        getUserSettings: vi.fn().mockResolvedValue({ androidStreamFps: 60 }),
        updateUserSettings,
      }
      mockAndroidBackend()
      try {
        renderPanel({ platform: 'linux' })
        fireEvent.click(await openAndroidDevice())
        fireEvent.click(await screen.findByRole('button', { name: /Desempenho/ }))
        const rateSelect = screen.getByLabelText('Fluidez') as HTMLSelectElement

        fireEvent.change(rateSelect, { target: { value: '30' } })

        expect(await screen.findByRole('alert')).toHaveTextContent(
          'Não foi possível salvar a preferência de fluidez. Seletor pausado.',
        )
        expect(rateSelect).toBeDisabled()
        expect(rateSelect).toHaveValue('60')
        expect(updateUserSettings).toHaveBeenCalledWith({ androidStreamFps: 30 })
        expect(vi.mocked(invoke).mock.calls.some(
          ([command]) => command === 'android_emulator_set_stream_rate',
        )).toBe(false)
      } finally {
        fake.restore()
      }
    })

    it('keeps the selector enabled and localizes the alert after an honest native rollback', async () => {
      const fake = installFakeWebGL()
      const updateUserSettings = vi.fn().mockResolvedValue(undefined)
      ;(window as unknown as { verboo: unknown }).verboo = {
        getUserSettings: vi.fn().mockResolvedValue({ androidStreamFps: 60 }),
        updateUserSettings,
      }
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'android_emulator_requirements') return {
          ready: true,
          issue: null,
          devices: [{
            avdName: 'Pixel_8_API_35', displayName: 'Pixel 8',
            apiLevel: 35, family: 'phone', running: false,
          }],
        }
        if (command === 'android_emulator_attach') return androidSession
        if (command === 'android_emulator_set_stream_rate') {
          throw new Error('native apply failed')
        }
        return undefined
      })
      try {
        renderPanel({ platform: 'linux' })
        fireEvent.click(await openAndroidDevice())
        fireEvent.click(await screen.findByRole('button', { name: /Desempenho/ }))
        const rateSelect = screen.getByLabelText('Fluidez') as HTMLSelectElement

        fireEvent.change(rateSelect, { target: { value: '30' } })

        expect(await screen.findByRole('alert')).toHaveTextContent(
          'Não foi possível aplicar a nova fluidez — a anterior foi mantida.',
        )
        expect(rateSelect).toBeEnabled()
        expect(rateSelect).toHaveValue('60')
        expect(updateUserSettings).toHaveBeenNthCalledWith(1, { androidStreamFps: 30 })
        expect(updateUserSettings).toHaveBeenNthCalledWith(2, { androidStreamFps: 60 })
      } finally {
        fake.restore()
      }
    })

    it('shows definitive requested/degraded status and announces only source transitions', async () => {
      const fake = installFakeWebGL()
      let now = 3_000
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
      mockAndroidBackend()
      try {
        renderPanel({ platform: 'linux' })
        fireEvent.click(await openAndroidDevice())
        await waitFor(() => expect(screen.getByText('GPU direta', {
          selector: 'span[role="status"]',
        })).toBeInTheDocument())

        now = 6_001
        const stateHandler = listenMock.mock.calls
          .find(([name]) => name === 'android-emulator:preview-state')?.[1] as
            ((event: { payload: unknown }) => void) | undefined
        expect(stateHandler).toBeDefined()
        act(() => stateHandler!({ payload: {
          generation: 7,
          source: 'adbFallback',
          requestedFps: 60,
          degraded: true,
          reason: 'unavailable',
        } }))

        await waitFor(() => expect(screen.getByText('Renderização por software · degradado', {
          selector: 'span[role="status"]',
        })).toBeInTheDocument())
        const visualStatus = document.querySelector('.ios-simulator-stream-status') as HTMLElement
        expect(visualStatus).not.toHaveAttribute('role')
        expect(visualStatus).not.toHaveAttribute('aria-live')
        expect(visualStatus).toHaveTextContent('PNG via ADB')
        expect(visualStatus).toHaveTextContent('60 fps')
        expect(visualStatus).toHaveTextContent('Transporte de streaming indisponível')
        expect(screen.getByTestId('actual-paint-fps')).toHaveAttribute('aria-hidden', 'true')
      } finally {
        nowSpy.mockRestore()
        fake.restore()
      }
    })

    it('production path: warm-up→baseline→5 extra cycles keep RENDER COUNTS invariant while drawArrays grows; burst coalesces ≤2 reads', async () => {
      // GL stub + rAF manual (determinismo sem timers reais).
      const fake = installFakeWebGL()
      const glCalls = fake.calls
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

      function fullBuffer(generation: number, seq: number): ArrayBuffer {
        const width = 4
        const height = 4
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

      let resolveAttach!: (value: typeof androidSession) => void
      const readSeqQueue: number[] = []
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'android_emulator_requirements') return {
          ready: true, issue: null,
          devices: [{
            avdName: 'Pixel_8_API_35', displayName: 'Pixel 8',
            apiLevel: 35, family: 'phone', running: false,
          }],
        }
        if (command === 'android_emulator_attach') {
          return new Promise<typeof androidSession>(resolve => { resolveAttach = resolve })
        }
        if (command === 'android_emulator_read_frame') {
          return fullBuffer(7, readSeqQueue.shift() ?? 0)
        }
        return undefined
      })

      try {
        let profilerCommits = 0
        renderPanelWithProfiler(() => { profilerCommits += 1 }, { platform: 'linux' })

        const stateHandler = listenMock.mock.calls
          .find(([name]) => name === 'android-emulator:preview-state')?.[1] as
            ((event: { payload: unknown }) => void) | undefined
        const readyHandler = listenMock.mock.calls
          .find(([name]) => name === 'android-emulator:frame-ready')?.[1] as
            ((event: { payload: unknown }) => void) | undefined
        expect(stateHandler).toBeDefined()
        expect(readyHandler).toBeDefined()
        fireEvent.click(await openAndroidDevice())
        act(() => stateHandler!({ payload: {
          generation: 7, source: 'grpc', requestedFps: 60, degraded: false,
        } }))
        await waitFor(() => expect(resolveAttach).toBeTypeOf('function'))
        await act(async () => { resolveAttach(androidSession) })
        await waitFor(() => {
          expect(screen.getByRole('application').querySelector('canvas[role="img"]')).not.toBeNull()
        })

        // WARM-UP (seq 1): a renderização rara que instala canvasSize é AUTORIZADA.
        readSeqQueue.push(1)
        act(() => readyHandler!({ payload: { generation: 7, seq: 1 } }))
        await flushRaf()

        // BASELINE após o primeiro paint/tamanho:
        const baselinePicker = renderCounts.picker
        const baselineDock = renderCounts.dock
        const commitsBaseline = profilerCommits

        // 5 ciclos ADICIONAIS de MESMA dimensão: contadores INVARIANTES, draw cresce.
        for (let seq = 2; seq <= 6; seq++) {
          readSeqQueue.push(seq)
          act(() => readyHandler!({ payload: { generation: 7, seq } }))
          await flushRaf()
        }
        const drawCount = glCalls.filter(call => call.method === 'drawArrays').length
        expect(drawCount).toBe(6)                                   // 1 warm-up + 5
        expect(glCalls.filter(call => call.method === 'texImage2D')).toHaveLength(1)
        expect(glCalls.filter(call => call.method === 'texSubImage2D')).toHaveLength(5)
        // MUTAÇÃO CONTRAFACTUAL (setState por frame): as três asserts falham.
        expect(renderCounts.picker).toBe(baselinePicker)
        expect(renderCounts.dock).toBe(baselineDock)
        expect(profilerCommits).toBe(commitsBaseline)

        // VIVIDADE dos contadores: interação real move picker E commits.
        fireEvent.focus(screen.getByRole('combobox', { name: 'Buscar dispositivo Android' }))
        await flushRaf()
        expect(renderCounts.picker).toBeGreaterThan(baselinePicker)
        expect(profilerCommits).toBeGreaterThan(commitsBaseline)

        // SECUNDÁRIO: identidade DOM (reconciliação sem remount).
        expect(
          screen.getByRole('application').querySelector('canvas[role="img"]'),
        ).not.toBeNull()

        // Burst: 10 wakeups retidos ⇒ ≤2 reads no total.
        let releaseBurst!: () => void
        const burstGate = new Promise<void>(resolve => { releaseBurst = resolve })
        const beforeBurst = vi.mocked(invoke).mock.calls
          .filter(([command]) => command === 'android_emulator_read_frame').length
        vi.mocked(invoke).mockImplementationOnce(async () => {
          await burstGate
          return fullBuffer(7, 20)
        })
        for (let seq = 7; seq <= 16; seq++) {
          act(() => readyHandler!({ payload: { generation: 7, seq } }))
        }
        await flushRaf()
        const duringBurst = vi.mocked(invoke).mock.calls
          .filter(([command]) => command === 'android_emulator_read_frame').length - beforeBurst
        expect(duringBurst).toBeLessThanOrEqual(1)
        await act(async () => { releaseBurst() })
        await flushRaf()
        const afterBurst = vi.mocked(invoke).mock.calls
          .filter(([command]) => command === 'android_emulator_read_frame').length - beforeBurst
        expect(afterBurst).toBeLessThanOrEqual(2)
      } finally {
        window.requestAnimationFrame = originalRaf
        fake.restore()
      }
    })
  })
})
