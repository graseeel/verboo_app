import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SimulatorPresenceOverlay } from './SimulatorPresenceOverlay'

describe('SimulatorPresenceOverlay', () => {
  it('fits the painted device cutout and renders tap feedback at its normalized target', () => {
    render(
      <SimulatorPresenceOverlay
        paintedRect={{ x: 42, y: 18, width: 400, height: 780 }}
        presence={{
          generation: 5,
          phase: 'start',
          action: 'tap',
          target: { x: 0.25, y: 0.75 },
        }}
        reducedMotion={false}
        label="Verboo is controlling this simulator."
        badgeLabel="Verboo at work"
      />,
    )

    const overlay = screen.getByTestId('simulator-presence-overlay')
    expect(overlay).toHaveStyle({
      left: '42px',
      top: '18px',
      width: '400px',
      height: '780px',
      borderRadius: '14px',
    })
    expect(screen.getByTestId('simulator-agent-cursor')).toHaveStyle({ left: '25%', top: '75%' })
    expect(screen.getByTestId('simulator-agent-ripple')).toBeInTheDocument()
    expect(screen.getByText('Verboo at work')).toBeInTheDocument()
  })

  it('renders the drag path and disables cursor travel for reduced motion', () => {
    render(
      <SimulatorPresenceOverlay
        paintedRect={{ x: 0, y: 0, width: 300, height: 650 }}
        presence={{
          generation: 6,
          phase: 'start',
          action: 'drag',
          start: { x: 0.1, y: 0.8 },
          end: { x: 0.9, y: 0.2 },
        }}
        reducedMotion
        label="Verboo is controlling this simulator."
        badgeLabel="Verboo at work"
      />,
    )

    const overlay = screen.getByTestId('simulator-presence-overlay')
    expect(overlay).toHaveAttribute('data-reduced-motion', 'true')
    expect(screen.getByTestId('simulator-agent-drag-path')).toHaveAttribute('x1', '10%')
    expect(screen.getByTestId('simulator-agent-drag-path')).toHaveAttribute('y2', '20%')
    expect(screen.getByTestId('simulator-agent-cursor')).not.toHaveClass('is-travelling')
  })
})
