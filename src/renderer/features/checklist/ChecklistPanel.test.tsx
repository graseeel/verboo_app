import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../../i18n'
import { ChecklistPanel } from './ChecklistPanel'
import {
  CHECKLIST_CARD_MARGIN,
  CHECKLIST_CARD_WIDTH,
  checklistCardHome,
  type ChecklistViewport,
} from './checklistPlacement'
import type { TodoItem } from '../../../shared/types'

/**
 * ChecklistPanel render tests — REAL DOM (jsdom), asserting EXHIBITION,
 * not construction. Every test asks: does the information REACH THE
 * SCREEN, or was it merely assembled? (The project paid for six
 * produced-but-unconsumed defects; render tests are the anti-pattern
 * breaker.)
 *
 * Geometry is injected via measureViewport so the drag assertions are
 * deterministic. Drag positions are computed by the SAME pure module
 * the App uses — what is proven here is that the PANEL wires pointer
 * events to those functions correctly (disparo + efeito), not the
 * functions themselves (covered in checklistPlacement.test.ts).
 */

afterEach(cleanup)

const VIEWPORT: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 0, topClearance: 0 }
const measureViewport = () => VIEWPORT

const item = (content: string, status: TodoItem['status'], activeForm = ''): TodoItem => ({
  content,
  status,
  activeForm,
})

const FIVE: TodoItem[] = [
  item('Mapear reasonIds', 'completed'),
  item('Pausar com motivo legível', 'completed'),
  item('Carimbar blocked', 'in_progress', 'Carimbando a tarefa como blocked'),
  item('Reidratar a sessão', 'pending'),
  item('Retomar ao responder', 'pending'),
]

function renderPanel(overrides: Partial<Parameters<typeof ChecklistPanel>[0]> = {}) {
  const props: Parameters<typeof ChecklistPanel>[0] = {
    todos: FIVE,
    form: 'docked',
    cardPos: null,
    onCardPosChange: () => {},
    onToggleForm: () => {},
    measureViewport,
    ...overrides,
  }
  return render(
    <I18nProvider language="en-US">
      <ChecklistPanel {...props} />
    </I18nProvider>,
  )
}

describe('ChecklistPanel: docked form (condensed, quiet)', () => {
  it('shows the window of 3 rows around the current item — never the whole list', () => {
    const { container } = renderPanel()
    const rows = container.querySelectorAll('.checklist-row')
    expect(rows).toHaveLength(3)
    // last done, current, next — indices 1, 2, 3 of FIVE
    expect(screen.getByText('Pausar com motivo legível')).toBeTruthy()
    expect(screen.getByText('Carimbando a tarefa como blocked')).toBeTruthy()
    expect(screen.getByText('Reidratar a sessão')).toBeTruthy()
    // Out-of-window items must NOT reach the screen
    expect(screen.queryByText('Mapear reasonIds')).toBeNull()
    expect(screen.queryByText('Retomar ao responder')).toBeNull()
  })

  it('rides the fraction on the CURRENT row (no separate header)', () => {
    const { container } = renderPanel()
    const current = container.querySelector('.checklist-row.is-current')
    expect(current).not.toBeNull()
    expect(current!.querySelector('.checklist-frac')?.textContent).toBe('2/5')
    // And the header element must NOT exist in the docked form
    expect(container.querySelector('.checklist-card-head')).toBeNull()
  })

  it('in_progress shows activeForm; pending and completed show content', () => {
    renderPanel()
    expect(screen.getByText('Carimbando a tarefa como blocked')).toBeTruthy()
    expect(screen.queryByText('Carimbar blocked')).toBeNull()
  })

  it('collapses to a SINGLE row when everything is completed', () => {
    const allDone = FIVE.map(i => ({ ...i, status: 'completed' as const }))
    const { container } = renderPanel({ todos: allDone })
    const rows = container.querySelectorAll('.checklist-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].classList.contains('done-all')).toBe(true)
    expect(screen.getByText('All done')).toBeTruthy()
    expect(rows[0].querySelector('.checklist-frac')?.textContent).toBe('5/5')
  })

  it('offers the float toggle riding the current row and FIRES onToggleForm', () => {
    const onToggleForm = vi.fn()
    const { container } = renderPanel({ onToggleForm })
    const current = container.querySelector('.checklist-row.is-current')!
    const toggle = current.querySelector('button.checklist-toggle')!
    fireEvent.click(toggle)
    expect(onToggleForm).toHaveBeenCalledTimes(1)
  })
})

describe('ChecklistPanel: floating card (mini-modal)', () => {
  it('shows the FULL list with header, fraction and a real progressbar', () => {
    const { container } = renderPanel({ form: 'floating' })
    expect(container.querySelectorAll('.checklist-card-rows .checklist-row')).toHaveLength(5)
    expect(screen.getByText('Task checklist')).toBeTruthy()
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('2')
    expect(bar.getAttribute('aria-valuemax')).toBe('5')
    // The card is positioned at the home corner (no dragged position)
    const card = container.querySelector<HTMLElement>('.checklist-panel.floating')!
    const home = checklistCardHome(VIEWPORT, CHECKLIST_CARD_WIDTH)
    expect(card.style.left).toBe(`${home.x}px`)
    expect(card.style.top).toBe(`${home.y}px`)
    expect(card.style.width).toBe(`${CHECKLIST_CARD_WIDTH}px`)
  })

  it('a persisted dragged position is honored as the resting position', () => {
    const { container } = renderPanel({ form: 'floating', cardPos: { x: 976, y: 300 } })
    const card = container.querySelector<HTMLElement>('.checklist-panel.floating')!
    expect(card.style.left).toBe('976px')
    expect(card.style.top).toBe('300px')
  })

  it('offers the dock toggle in the header and FIRES onToggleForm', () => {
    const onToggleForm = vi.fn()
    renderPanel({ form: 'floating', onToggleForm })
    fireEvent.click(screen.getByRole('button', { name: 'Dock above the composer' }))
    expect(onToggleForm).toHaveBeenCalledTimes(1)
  })
})

describe('ChecklistPanel: drag — USER RULE: never rests over the transcript', () => {
  const stripX = checklistCardHome(VIEWPORT, CHECKLIST_CARD_WIDTH).x

  it('a drop over the transcript resolves to the right strip, keeping y', () => {
    const onCardPosChange = vi.fn()
    const { container } = renderPanel({ form: 'floating', onCardPosChange })
    const card = container.querySelector('.checklist-panel.floating')!
    fireEvent.pointerDown(card, { pointerId: 1, clientX: stripX + 20, clientY: 36 })
    // Drag far left, over the transcript. The candidate follows the
    // DELTA from the drag start: home.y(16) + (500 − 36) = 480.
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 120, clientY: 500 })
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 120, clientY: 500 })
    expect(onCardPosChange).toHaveBeenCalledTimes(1)
    const resolved = onCardPosChange.mock.calls[0][0]
    expect(resolved.x).toBe(stripX)
    expect(resolved.y).toBe(16 + (500 - 36))
  })

  it('the return is FLUID: the gliding class carries the transition (not reduced motion)', () => {
    const { container } = renderPanel({ form: 'floating', prefersReducedMotion: () => false })
    const card = container.querySelector('.checklist-panel.floating')!
    fireEvent.pointerDown(card, { pointerId: 1, clientX: stripX + 20, clientY: 36 })
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 300, clientY: 300 })
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 300, clientY: 300 })
    expect(card.classList.contains('is-gliding')).toBe(true)
  })

  it('REDUCED MOTION: the return is instant — no gliding class, position still resolved', () => {
    const onCardPosChange = vi.fn()
    const { container } = renderPanel({
      form: 'floating',
      onCardPosChange,
      prefersReducedMotion: () => true,
    })
    const card = container.querySelector('.checklist-panel.floating')!
    fireEvent.pointerDown(card, { pointerId: 1, clientX: stripX + 20, clientY: 36 })
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 300, clientY: 300 })
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 300, clientY: 300 })
    // Delta math: home.y(16) + (300 − 36) = 280; x always returns to the strip.
    expect(onCardPosChange).toHaveBeenCalledWith({ x: stripX, y: 280 })
    expect(card.classList.contains('is-gliding')).toBe(false)
  })

  it('during the drag the card follows the pointer but stays INSIDE the window', () => {
    const { container } = renderPanel({ form: 'floating' })
    const card = container.querySelector<HTMLElement>('.checklist-panel.floating')!
    fireEvent.pointerDown(card, { pointerId: 1, clientX: stripX + 20, clientY: 36 })
    // Way past the top-left corner — must clamp to the window edge
    fireEvent.pointerMove(card, { pointerId: 1, clientX: -5000, clientY: -5000 })
    expect(card.style.left).toBe('8px')
    // y clamps to the RAIL TOP, not the window edge: with no clearance
    // measured the rail floor is the home margin (16) — the card never
    // parks inside the titlebar strip again (latent defect fixed with
    // the field collision).
    expect(card.style.top).toBe('16px')
  })

  it('clicking the toggle does NOT start a drag', () => {
    const onCardPosChange = vi.fn()
    renderPanel({ form: 'floating', onCardPosChange })
    const toggle = screen.getByRole('button', { name: 'Dock above the composer' })
    fireEvent.pointerDown(toggle, { pointerId: 1, clientX: 100, clientY: 20 })
    fireEvent.pointerUp(toggle, { pointerId: 1, clientX: 100, clientY: 20 })
    expect(onCardPosChange).not.toHaveBeenCalled()
  })
})

describe('ChecklistPanel: check micro-interaction', () => {
  it('items completed on first render are SETTLED — the draw animation does not replay', () => {
    const { container } = renderPanel({ form: 'floating' })
    const settled = container.querySelectorAll('.checklist-check.settled')
    // The 2 items that arrived completed render settled; the rest don't.
    expect(settled).toHaveLength(2)
  })
})

describe('ChecklistPanel: ORDER — the goal always stays closer to the composer', () => {
  it('in a real DOM aux-stack the checklist renders ABOVE the goal, the composer BELOW the goal', () => {
    // The approved hierarchy: list → goal → composer. Asserted with
    // compareDocumentPosition on real nodes, not by reading JSX.
    const { container } = render(
      <I18nProvider language="en-US">
        <div className="composer-aux-stack">
          <ChecklistPanel
            todos={FIVE}
            form="docked"
            cardPos={null}
            onCardPosChange={() => {}}
            onToggleForm={() => {}}
            measureViewport={measureViewport}
          />
          <div className="goal-panel-double">goal panel</div>
          <div className="composer-double">composer</div>
        </div>
      </I18nProvider>,
    )
    const checklist = container.querySelector('.checklist-panel.docked')!
    const goal = container.querySelector('.goal-panel-double')!
    const composer = container.querySelector('.composer-double')!
    expect(checklist.compareDocumentPosition(goal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(goal.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('ChecklistPanel: SHARED TOP-RIGHT RAIL — the card yields to the subagent chip', () => {
  // Field defect (2026-07-31): the floating subagent indicator chip
  // OVERLAPPED the card in the top-right corner. The corner is shared
  // space with a stacking order, not the card's property: chip first,
  // card below. The chip's geometry arrives via measureViewport's
  // topClearance (108 = chip bottom + gap, as measured live).
  const CHIP_VIEWPORT: ChecklistViewport = { ...VIEWPORT, topClearance: 108 }
  const stripX = checklistCardHome(VIEWPORT, CHECKLIST_CARD_WIDTH).x

  it('with the chip present the card parks BELOW it — never overlapping', () => {
    const { container } = renderPanel({ form: 'floating', measureViewport: () => CHIP_VIEWPORT })
    const card = container.querySelector<HTMLElement>('.checklist-panel.floating')!
    expect(card.style.top).toBe('108px')
  })

  it('CONTRAFACTUAL: without the clearance the card parks at the plain margin — the overlap would be back', () => {
    // Same render, no chip: y drops to the home margin. If the rail
    // math regressed, BOTH cases would park at 16 and the first test
    // above would pass vacuously — this pair is what makes it proof.
    const { container } = renderPanel({ form: 'floating' })
    const card = container.querySelector<HTMLElement>('.checklist-panel.floating')!
    expect(card.style.top).toBe('16px')
  })

  it('a drop ABOVE the chip may be visited during the drag but never RESTS there', () => {
    const onCardPosChange = vi.fn()
    const { container } = renderPanel({
      form: 'floating',
      onCardPosChange,
      measureViewport: () => CHIP_VIEWPORT,
    })
    const card = container.querySelector('.checklist-panel.floating')!
    // Home is y=108 with the chip; drag upward into the chip strip and drop.
    fireEvent.pointerDown(card, { pointerId: 1, clientX: stripX + 20, clientY: 128 })
    fireEvent.pointerMove(card, { pointerId: 1, clientX: stripX + 20, clientY: 30 })
    fireEvent.pointerUp(card, { pointerId: 1, clientX: stripX + 20, clientY: 30 })
    const resolved = onCardPosChange.mock.calls[0][0]
    expect(resolved.y).toBe(108)
    expect(resolved.x).toBe(stripX)
  })

  it('a persisted position parked over the chip is re-contained on mount', () => {
    const onCardPosChange = vi.fn()
    renderPanel({
      form: 'floating',
      cardPos: { x: 976, y: 30 },
      onCardPosChange,
      measureViewport: () => CHIP_VIEWPORT,
    })
    expect(onCardPosChange).toHaveBeenCalledWith({ x: 976, y: 108 })
  })
})

describe('ChecklistPanel: long steps stay LEGIBLE (field truncation fix)', () => {
  // Field defect (2026-07-31): real TodoWrite items are whole sentences
  // and the single-line ellipsis made steps illegible ("Create
  // lista1.txt with…"). jsdom has no layout, so what is proven here is
  // that the FULL text reaches the DOM and the tooltip carries it
  // verbatim; the two-line wrap itself is a CSS pin in
  // checklistContract.test.ts. DECLARED: the rendered pixel of the
  // wrap stays unproven until the next packaged field run.
  const LONG =
    'Create lista1.txt with the complete sentence an agent writes in a real field run, not a short label'
  const LONG_LIST: TodoItem[] = [item(LONG, 'in_progress'), item('Segunda etapa curta', 'pending')]

  it('floating: the full sentence reaches the DOM AND the title tooltip, verbatim', () => {
    const { container } = renderPanel({ form: 'floating', todos: LONG_LIST })
    const textEl = container.querySelector('.checklist-card-rows .checklist-row-text')!
    expect(textEl.textContent).toBe(LONG)
    expect(textEl.getAttribute('title')).toBe(LONG)
  })

  it('docked: the compact single line keeps the full text one hover away', () => {
    const { container } = renderPanel({ todos: LONG_LIST })
    const textEl = container.querySelector('.checklist-row.is-current .checklist-row-text')!
    expect(textEl.textContent).toBe(LONG)
    expect(textEl.getAttribute('title')).toBe(LONG)
  })
})
