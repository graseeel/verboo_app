import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimulatorTooltipButton } from './SimulatorTooltip'

describe('SimulatorTooltipButton', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('portals its tooltip outside clipped simulator controls after a short hover delay', () => {
    vi.useFakeTimers()
    render(
      <div data-testid="clipped-dock" style={{ overflow: 'hidden' }}>
        <SimulatorTooltipButton label="Início">H</SimulatorTooltipButton>
      </div>,
    )

    const button = screen.getByRole('button', { name: 'Início' })
    fireEvent.pointerEnter(button.parentElement!)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(450) })

    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Início')
    expect(tooltip.parentElement).toBe(document.body)
    expect(button).toHaveAttribute('aria-describedby', tooltip.id)
  })

  it('appears immediately for keyboard focus and closes with Escape', () => {
    render(<SimulatorTooltipButton label="Capturar tela">C</SimulatorTooltipButton>)

    const button = screen.getByRole('button', { name: 'Capturar tela' })
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Capturar tela')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('still explains a disabled control when the pointer rests over it', () => {
    vi.useFakeTimers()
    render(
      <SimulatorTooltipButton label="Início indisponível" disabled>
        H
      </SimulatorTooltipButton>,
    )

    const button = screen.getByRole('button', { name: 'Início indisponível' })
    expect(button).toBeDisabled()
    fireEvent.pointerEnter(button.parentElement!)
    act(() => { vi.advanceTimersByTime(450) })

    expect(screen.getByRole('tooltip')).toHaveTextContent('Início indisponível')
  })

  it('keeps the fixed tooltip anchor inside the viewport edge', () => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 240 })
    try {
      render(<SimulatorTooltipButton label="Encerrar simulação">E</SimulatorTooltipButton>)
      const button = screen.getByRole('button', { name: 'Encerrar simulação' })
      vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
        x: 230,
        y: 100,
        top: 100,
        right: 250,
        bottom: 120,
        left: 230,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      })

      fireEvent.focus(button)

      expect(screen.getByRole('tooltip')).toHaveStyle({
        '--simulator-tooltip-left': '168px',
      })
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
  })
})
