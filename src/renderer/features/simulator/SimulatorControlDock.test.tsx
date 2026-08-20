import { act, fireEvent, render, screen } from '@testing-library/react'
import { Bell, GalleryHorizontal, Home, RotateCw, SlidersHorizontal } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import type {
  IosSimulatorMediaFile,
  IosSimulatorRecordingState,
  IosSimulatorSystemAction,
} from './iosSimulatorApi'
import { SimulatorControlDock } from './SimulatorControlDock'

type IosDockProps = React.ComponentProps<typeof SimulatorControlDock<IosSimulatorSystemAction>>

function renderDock(overrides: Partial<IosDockProps> = {}) {
  const props: IosDockProps = {
    deviceName: 'iPhone 17 Pro',
    ownership: 'external',
    interactionReady: true,
    busy: false,
    actions: [
      { action: 'home', label: 'Início', icon: Home },
      { action: 'appSwitcher', label: 'Apps abertos', icon: GalleryHorizontal },
      { action: 'notifications', label: 'Notificações', icon: Bell },
      { action: 'controlCenter', label: 'Central de Controle', icon: SlidersHorizontal },
      { action: 'rotateClockwise', label: 'Girar aparelho', icon: RotateCw },
    ],
    recording: { state: 'idle' },
    lastMediaFile: undefined,
    onSystemAction: vi.fn<(action: IosSimulatorSystemAction) => void>(),
    onCaptureScreen: vi.fn(),
    onToggleRecording: vi.fn(),
    onDetach: vi.fn(),
    onEnd: vi.fn(),
    onShutdownExternal: vi.fn(),
    onRevealOutput: vi.fn(),
    ...overrides,
  }
  return {
    ...render(
      <I18nProvider language="pt-BR">
        <SimulatorControlDock {...props} />
      </I18nProvider>,
    ),
    props,
  }
}

describe('SimulatorControlDock', () => {
  it('exposes the compact controls and both safe external session actions', () => {
    const { props } = renderDock()
    for (const name of [
      'Início', 'Apps abertos', 'Notificações', 'Central de Controle',
      'Capturar tela', 'Iniciar gravação', 'Girar aparelho', 'Desanexar',
      'Encerrar simulador externo',
    ]) expect(screen.getByRole('button', { name })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Início' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apps abertos' }))
    expect(props.onSystemAction).toHaveBeenNthCalledWith(1, 'home')
    expect(props.onSystemAction).toHaveBeenNthCalledWith(2, 'appSwitcher')
  })

  it('disables only interaction controls before the backend reports readiness', () => {
    renderDock({ interactionReady: false })

    expect(screen.getByRole('button', { name: 'Início' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Apps abertos' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Notificações' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Central de Controle' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Girar aparelho' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Capturar tela' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Iniciar gravação' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Desanexar' })).toBeEnabled()
  })

  it('shows a visible tooltip for every icon-only dock control', () => {
    renderDock()
    for (const name of [
      'Início', 'Apps abertos', 'Notificações', 'Central de Controle',
      'Girar aparelho', 'Capturar tela', 'Iniciar gravação', 'Desanexar',
      'Encerrar simulador externo',
    ]) {
      const button = screen.getByRole('button', { name })
      fireEvent.focus(button)
      expect(screen.getByRole('tooltip')).toHaveTextContent(name)
      fireEvent.blur(button)
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    }
  })

  it('detaches an external device immediately without opening a shutdown confirmation', () => {
    const { props } = renderDock({ ownership: 'external' })

    fireEvent.click(screen.getByRole('button', { name: 'Desanexar' }))

    expect(props.onDetach).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('requires a named confirmation before shutting down an external simulator', () => {
    const { props } = renderDock({ ownership: 'external' })

    fireEvent.click(screen.getByRole('button', { name: 'Encerrar simulador externo' }))

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Encerrar o simulador externo iPhone 17 Pro?',
    )
    expect(props.onShutdownExternal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar externo' }))
    expect(props.onShutdownExternal).toHaveBeenCalledTimes(1)
  })

  it('confirms only the owned end-simulation action', () => {
    const { props } = renderDock({ ownership: 'verboo' })

    fireEvent.click(screen.getByRole('button', { name: 'Encerrar simulação' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Encerrar a simulação do iPhone 17 Pro?')
    expect(props.onEnd).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Encerrar' }))
    expect(props.onEnd).toHaveBeenCalledTimes(1)
  })

  it('cancels owned confirmation with Escape and returns focus to the end control', () => {
    renderDock({ ownership: 'verboo' })
    const end = screen.getByRole('button', { name: 'Encerrar simulação' })
    fireEvent.click(end)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(end).toHaveFocus()
  })

  it('keeps recording state visible and exposes the completed file action', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T15:00:04.000Z'))
    const file: IosSimulatorMediaFile = { path: 'desktop/clip.mov', fileName: 'clip.mov' }
    const recording: IosSimulatorRecordingState = {
      state: 'recording',
      startedAtMs: Date.now() - 4_000,
    }

    try {
      const { props } = renderDock({ recording, lastMediaFile: file })
      expect(screen.getByRole('button', { name: 'Parar gravação' })).toBeInTheDocument()
      expect(screen.getByText('00:04')).toBeInTheDocument()
      expect(screen.getByText('Salvo como clip.mov')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Revelar no Finder' }))
      expect(props.onRevealOutput).toHaveBeenCalledWith('desktop/clip.mov')

      act(() => { vi.advanceTimersByTime(1_000) })
      expect(screen.getByText('00:05')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})


// ── Android dock adapter: injected actions and capability-gated media ──────

describe('SimulatorControlDock android actions (PA-27)', () => {
  function renderAndroidDock(overrides: Record<string, unknown> = {}) {
    const props = {
      deviceName: 'Pixel 8',
      ownership: 'verboo' as const,
      interactionReady: true,
      busy: false,
      actions: [
        { action: 'back', label: 'Voltar', icon: Bell },
        { action: 'home', label: 'Início', icon: Home },
        { action: 'recents', label: 'Recentes', icon: GalleryHorizontal },
        { action: 'notifications', label: 'Notificações', icon: Bell },
        { action: 'rotate', label: 'Girar aparelho', icon: RotateCw },
      ] as const,
      mediaControls: false,
      onSystemAction: vi.fn(),
      onEnd: vi.fn(),
      ...overrides,
    }
    render(
      <I18nProvider language="pt-BR">
        <SimulatorControlDock {...props} />
      </I18nProvider>,
    )
    return props
  }

  it('renders the injected android system actions and dispatches the frozen action ids', () => {
    const props = renderAndroidDock()

    for (const name of ['Voltar', 'Início', 'Recentes', 'Notificações', 'Girar aparelho']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Recentes' }))
    expect(props.onSystemAction).toHaveBeenNthCalledWith(1, 'back')
    expect(props.onSystemAction).toHaveBeenNthCalledWith(2, 'recents')
  })

  it('hides the shared media group when mediaControls is false', () => {
    renderAndroidDock()

    expect(screen.queryByRole('button', { name: 'Capturar tela' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Iniciar gravação' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Desanexar' })).not.toBeInTheDocument()
    // The iOS default controls must NOT leak into the android dock.
    expect(screen.queryByRole('button', { name: 'Central de Controle' })).not.toBeInTheDocument()
  })

  it('keeps the owned end-session confirmation for android', () => {
    const props = renderAndroidDock()

    fireEvent.click(screen.getByRole('button', { name: 'Encerrar simulação' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Encerrar a simulação do Pixel 8?')
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar' }))
    expect(props.onEnd).toHaveBeenCalledTimes(1)
  })
})
