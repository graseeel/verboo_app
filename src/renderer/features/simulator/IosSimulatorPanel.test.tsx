import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

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

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      'android_emulator_attach',
      { avdName: 'Verboo_Device_API_35', streamFps: 60, fallbackFps: 1 },
    ))
    const eventHandlers = new Map(listenMock.mock.calls.map(([name, handler]) => [name, handler]))
    act(() => {
      eventHandlers.get('android-emulator:lifecycle')?.({ payload: { stage: 'ready' } })
      eventHandlers.get('android-emulator:frame')?.({
        payload: { pngBase64: 'YW5kcm9pZA==', width: 1080, height: 2400, generation: 9 },
      })
    })

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

  it('wires Android a11y selection, annotations, media, rates and reused tooltips through real components', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
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
      if (command === 'android_emulator_set_stream_rate') return 5
      if (command === 'android_emulator_set_fallback_rate') return 2
      return undefined
    })
    renderPanel({ onAddAnnotation: addedAnnotation })

    fireEvent.click(screen.getByRole('tab', { name: 'Android' }))
    const picker = await screen.findByRole('combobox', { name: 'Buscar dispositivo Android' })
    fireEvent.focus(picker)
    fireEvent.click(screen.getByRole('option', { name: /Verboo Device API 35/ }))
    const eventHandlers = new Map(listenMock.mock.calls.map(([name, handler]) => [name, handler]))
    act(() => {
      eventHandlers.get('android-emulator:lifecycle')?.({ payload: { stage: 'ready' } })
      eventHandlers.get('android-emulator:frame')?.({
        payload: { pngBase64: 'YW5kcm9pZA==', width: 1080, height: 2400, generation: 9 },
      })
    })

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
    fireEvent.change(screen.getByLabelText('Fluidez'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Taxa do fallback econômico'), { target: { value: '2' } })
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_set_stream_rate', { fps: 5 })
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_set_fallback_rate', { fps: 2 })
    })
  })
})
