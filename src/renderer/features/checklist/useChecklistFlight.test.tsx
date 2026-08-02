import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useChecklistFlight } from './useChecklistFlight'
import { CHECKLIST_FLIGHT_MS, type ChecklistPlacement } from './checklistPlacement'

/**
 * useChecklistFlight — the FLIP migration choreography. These tests
 * prove FIRING and EFFECT (committed switches, flight starts, spacer
 * exists during flight, commit lands by timer), never CSS form — in
 * jsdom every rect is zero, so geometry assertions would be theater.
 *
 * The choreography guarantees under test:
 *   - null → form: entrance flag (the genie-in), NO flight
 *   - floating ⇄ docked: flight runs, spacer handles the flow space,
 *     commit lands BY TIMER (anti-throttle cure)
 *   - docked anchor-only change (above-goal ⇄ above-composer): SILENT
 *     switch — this is what keeps the checklist inert through the
 *     goal panel's 280ms genie exit window (single choreography owner)
 *   - prefers-reduced-motion: NO flight, NO spacer, instant switch
 */

afterEach(cleanup)
beforeEach(() => {
  vi.useFakeTimers()
})

function Harness({
  placement,
  reduced = false,
}: {
  placement: ChecklistPlacement
  reduced?: boolean
}) {
  const flight = useChecklistFlight(placement, { prefersReducedMotion: () => reduced })
  return (
    <div>
      <div data-testid="committed">
        {flight.committed === null
          ? 'null'
          : flight.committed.form === 'floating'
            ? 'floating'
            : `docked:${flight.committed.anchor}`}
      </div>
      <div data-testid="flying">{String(flight.flying)}</div>
      <div data-testid="entering">{String(flight.entering)}</div>
      <div data-testid="spacer">{flight.spacerHeight === null ? 'null' : 'present'}</div>
      <div data-testid="flightstyle">{flight.flightStyle ? 'present' : 'null'}</div>
      {flight.committed !== null && <div ref={flight.registerPanel as React.Ref<HTMLDivElement>} />}
    </div>
  )
}

function read(get: (testId: string) => HTMLElement) {
  return {
    committed: get('committed').textContent,
    flying: get('flying').textContent === 'true',
    entering: get('entering').textContent === 'true',
    spacer: get('spacer').textContent,
    flightStyle: get('flightstyle').textContent,
  }
}

describe('useChecklistFlight', () => {
  it('null → floating: commits the form, flags the entrance, starts NO flight', () => {
    const { getByTestId, rerender } = render(<Harness placement={null} />)
    rerender(<Harness placement={{ form: 'floating' }} />)
    const state = read(getByTestId)
    expect(state.committed).toBe('floating')
    expect(state.entering).toBe(true)
    expect(state.flying).toBe(false)
    expect(state.spacer).toBe('null')
    // The entrance flag clears after the entrance window
    act(() => { vi.advanceTimersByTime(CHECKLIST_FLIGHT_MS + 60) })
    expect(read(getByTestId).entering).toBe(false)
  })

  it('floating → docked: FLIES with a spacer, commits by timer, ends clean', () => {
    const { getByTestId, rerender } = render(<Harness placement={{ form: 'floating' }} />)
    rerender(<Harness placement={{ form: 'docked', anchor: 'above-composer' }} />)
    const during = read(getByTestId)
    expect(during.committed).toBe('docked:above-composer')
    expect(during.flying).toBe(true)
    expect(during.spacer).toBe('present')
    expect(during.flightStyle).toBe('present')
    // Commit lands BY TIMER (hidden tabs throttle transitions; timers run)
    act(() => { vi.advanceTimersByTime(CHECKLIST_FLIGHT_MS + 60) })
    const after = read(getByTestId)
    expect(after.flying).toBe(false)
    expect(after.spacer).toBe('null')
    expect(after.flightStyle).toBe('null')
    expect(after.committed).toBe('docked:above-composer')
  })

  it('docked → floating: FLIES and ends as a floating card', () => {
    const { getByTestId, rerender } = render(
      <Harness placement={{ form: 'docked', anchor: 'above-goal' }} />,
    )
    rerender(<Harness placement={{ form: 'floating' }} />)
    expect(read(getByTestId).flying).toBe(true)
    act(() => { vi.advanceTimersByTime(CHECKLIST_FLIGHT_MS + 60) })
    const after = read(getByTestId)
    expect(after.committed).toBe('floating')
    expect(after.flying).toBe(false)
  })

  it('anchor-only change (above-goal → above-composer) is SILENT — no flight, no spacer', () => {
    // THE choreography guarantee: when the goal's genie exit ghost
    // clears, goalDocked flips and the anchor changes — and NOTHING
    // animates, because the docked checklist is always the stack's
    // first child and no pixel needs to move.
    const { getByTestId, rerender } = render(
      <Harness placement={{ form: 'docked', anchor: 'above-goal' }} />,
    )
    rerender(<Harness placement={{ form: 'docked', anchor: 'above-composer' }} />)
    const state = read(getByTestId)
    expect(state.committed).toBe('docked:above-composer')
    expect(state.flying).toBe(false)
    expect(state.spacer).toBe('null')
  })

  it('REDUCED MOTION: a form switch commits instantly — no flight, no spacer, ever', () => {
    const { getByTestId, rerender } = render(<Harness placement={{ form: 'floating' }} reduced />)
    rerender(<Harness placement={{ form: 'docked', anchor: 'above-goal' }} reduced />)
    const state = read(getByTestId)
    expect(state.committed).toBe('docked:above-goal')
    expect(state.flying).toBe(false)
    expect(state.spacer).toBe('null')
    expect(state.flightStyle).toBe('null')
  })

  it('disappear (form → null) is instant — no flight over a stale conversation', () => {
    const { getByTestId, rerender } = render(<Harness placement={{ form: 'floating' }} />)
    rerender(<Harness placement={null} />)
    const state = read(getByTestId)
    expect(state.committed).toBe('null')
    expect(state.flying).toBe(false)
  })
})
