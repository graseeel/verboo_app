import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import type { IosSimulatorLifecycleSnapshot, IosSimulatorRequirements } from './iosSimulatorApi'
import { IosSimulatorPanel } from './IosSimulatorPanel'

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
    onCaptureAnnotation: vi.fn().mockResolvedValue(undefined),
    onDeleteCapture: vi.fn().mockResolvedValue(undefined),
    onAddAnnotation: vi.fn(),
    onRefresh: vi.fn(),
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
    expect(screen.getByRole('button', { name: 'Anexar' })).toBeInTheDocument()
  })

  it('executes attachment from the empty state after choosing a device', () => {
    const { props } = renderPanel()
    const attach = screen.getByRole('button', { name: 'Anexar' })

    expect(attach).toBeDisabled()
    fireEvent.focus(screen.getByRole('combobox', { name: 'Buscar simulador' }))
    fireEvent.click(screen.getByRole('option', { name: /iPhone 17 Pro/ }))
    expect(attach).toBeEnabled()

    fireEvent.click(attach)

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
    expect(screen.getByText('MJPEG')).toBeInTheDocument()
    expect(screen.getByText('Taxa real: 9.2 fps')).toBeInTheDocument()
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

    expect(screen.getByRole('alert')).toHaveTextContent('Instale o Xcode 26 ou 27')
  })
})
