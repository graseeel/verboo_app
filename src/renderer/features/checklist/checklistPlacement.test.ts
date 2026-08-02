import { describe, expect, it } from 'vitest'
import type { TodoItem } from '../../../shared/types'
import {
  CHECKLIST_CARD_MARGIN,
  CHECKLIST_CARD_WIDTH,
  CHECKLIST_SNAP,
  CHECKLIST_WINDOW_EDGE,
  applyTodoWrite,
  checklistCardHome,
  clampCardPosition,
  removeChecklistForConversation,
  resolveCardDrop,
  resolveChecklistPlacement,
  type ChecklistFormPreference,
  type ChecklistPlacementInput,
  type ChecklistViewport,
} from './checklistPlacement'

/**
 * checklistPlacement — EXHAUSTIVE MATRIX.
 *
 * The user required: the UI must not break in ANY combination of
 * sidebar × terminal × review × web × goal × subagent chip ×
 * preference × dragged position. A pure function is the only way to
 * PROVE that without opening the app thirty times — so every
 * combination of the eight binary inputs is crossed here (2^8 = 256),
 * with the dragged position crossed as geometry invariants over the
 * same matrix.
 *
 * Decision table under test (approved hierarchy):
 *   no list                       → null
 *   preference 'dock'             → docked (anchor by goalDocked)
 *   preference 'float' + rightBusy→ docked (Maestro: float WHEN
 *                                   POSSIBLE — the lane is physically
 *                                   occupied; it migrates back when
 *                                   the lane frees)
 *   preference 'float' + rightFree→ floating (with or without goal —
 *                                   ratified inference: the right side
 *                                   is the preferred home when free)
 *   sidebar                       → INVARIANT (left-side input, the
 *                                   card anchors to the right edge)
 *   subagent chip                 → INVARIANT for the form, GEOMETRY
 *                                   only (the card yields below it in
 *                                   the shared top-right rail — see
 *                                   the rail suite at the bottom)
 */

const BOOLEANS = [false, true]

function everyCombination(): ChecklistPlacementInput[] {
  const inputs: ChecklistPlacementInput[] = []
  for (const hasList of BOOLEANS)
    for (const goalDocked of BOOLEANS)
      for (const terminalOpen of BOOLEANS)
        for (const reviewOpen of BOOLEANS)
          for (const webOpen of BOOLEANS)
            for (const sidebarOpen of BOOLEANS)
              for (const subagentChipPresent of BOOLEANS)
                for (const preference of ['float', 'dock'] as ChecklistFormPreference[])
                  inputs.push({
                    hasList,
                    goalDocked,
                    terminalOpen,
                    reviewOpen,
                    webOpen,
                    sidebarOpen,
                    subagentChipPresent,
                    preference,
                  })
  return inputs
}

const MATRIX = everyCombination()

describe('checklistPlacement: exhaustive matrix (256 combinations of 8 binary inputs)', () => {
  it('crosses every binary input exactly 256 times (2^8)', () => {
    expect(MATRIX).toHaveLength(256)
  })

  it('NEVER returns a placement when there is no list', () => {
    for (const input of MATRIX.filter(i => !i.hasList)) {
      expect(resolveChecklistPlacement(input)).toBeNull()
    }
  })

  it("preference 'dock' is ALWAYS docked, anchored by goalDocked — regardless of everything else", () => {
    for (const input of MATRIX.filter(i => i.hasList && i.preference === 'dock')) {
      const placement = resolveChecklistPlacement(input)
      expect(placement).not.toBeNull()
      expect(placement!.form).toBe('docked')
      if (placement!.form === 'docked') {
        expect(placement!.anchor).toBe(input.goalDocked ? 'above-goal' : 'above-composer')
      }
    }
  })

  it("preference 'float' + ANY right lane open is docked (float WHEN POSSIBLE, not always)", () => {
    const busy = MATRIX.filter(
      i => i.hasList && i.preference === 'float' && (i.terminalOpen || i.reviewOpen || i.webOpen),
    )
    expect(busy.length).toBeGreaterThan(0)
    for (const input of busy) {
      const placement = resolveChecklistPlacement(input)
      expect(placement!.form).toBe('docked')
      if (placement!.form === 'docked') {
        expect(placement!.anchor).toBe(input.goalDocked ? 'above-goal' : 'above-composer')
      }
    }
  })

  it("preference 'float' + right lane FREE is floating — with OR without a goal", () => {
    const free = MATRIX.filter(
      i => i.hasList && i.preference === 'float' && !i.terminalOpen && !i.reviewOpen && !i.webOpen,
    )
    expect(free.some(i => i.goalDocked)).toBe(true)
    expect(free.some(i => !i.goalDocked)).toBe(true)
    for (const input of free) {
      expect(resolveChecklistPlacement(input)).toEqual({ form: 'floating' })
    }
  })

  it('the subagent thread panel counts as right-lane occupation (extension, same spirit)', () => {
    const base: ChecklistPlacementInput = {
      hasList: true,
      goalDocked: true,
      terminalOpen: false,
      reviewOpen: false,
      webOpen: false,
      sidebarOpen: true,
      preference: 'float',
    }
    expect(resolveChecklistPlacement(base)).toEqual({ form: 'floating' })
    expect(resolveChecklistPlacement({ ...base, otherRightLaneOpen: true })!.form).toBe('docked')
  })

  it('SIDEBAR INVARIANCE: flipping sidebarOpen NEVER changes the placement', () => {
    // The sidebar lives on the LEFT; the card anchors to the RIGHT edge
    // and the docked form follows the composer lane. The input is
    // crossed to PROVE the invariance, not assumed.
    for (const input of MATRIX) {
      const flipped = { ...input, sidebarOpen: !input.sidebarOpen }
      expect(resolveChecklistPlacement(flipped)).toEqual(resolveChecklistPlacement(input))
    }
  })

  it('DRAGGED-POSITION invariance over the matrix: any drop resolves into the right strip', () => {
    // The dragged position is geometry, not a placement input — so it
    // is crossed HERE: for a representative viewport, every candidate
    // drop (including over the transcript) must land on the strip x,
    // in-bounds, for BOTH possible outcomes of any matrix cell.
    const viewport: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 0, topClearance: 0, bottomClearance: 0 }
    const card = { width: CHECKLIST_CARD_WIDTH, height: 220 }
    const stripX = checklistCardHome(viewport, card.width).x
    const candidates = [
      { x: 0, y: 0 }, // far transcript corner
      { x: 400, y: 370 }, // mid transcript
      { x: 5000, y: 5000 }, // off-screen
      { x: -800, y: -200 }, // negative
      { x: stripX, y: CHECKLIST_CARD_MARGIN }, // already home
    ]
    for (const candidate of candidates) {
      const resolved = resolveCardDrop(candidate, viewport, card)
      expect(resolved.x).toBe(stripX)
      expect(resolved.y).toBeGreaterThanOrEqual(CHECKLIST_CARD_MARGIN)
      expect(resolved.y).toBeLessThanOrEqual(viewport.height - card.height - CHECKLIST_WINDOW_EDGE)
    }
  })
})

describe('checklistPlacement: card geometry (pure)', () => {
  const viewport: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 0, topClearance: 0, bottomClearance: 0 }

  it('home is the top-right corner clear of margin and scrollbar', () => {
    expect(checklistCardHome(viewport, CHECKLIST_CARD_WIDTH)).toEqual({
      x: 1280 - 0 - CHECKLIST_CARD_MARGIN - CHECKLIST_CARD_WIDTH,
      y: CHECKLIST_CARD_MARGIN,
    })
  })

  it('home never goes left of the window edge on a tiny viewport', () => {
    const tiny: ChecklistViewport = { width: 200, height: 300, scrollbarWidth: 0, topClearance: 0, bottomClearance: 0 }
    expect(checklistCardHome(tiny, CHECKLIST_CARD_WIDTH).x).toBe(CHECKLIST_WINDOW_EDGE)
  })

  it('clamp keeps an in-bounds position untouched', () => {
    const pos = { x: 900, y: 200 }
    expect(clampCardPosition(pos, viewport, { width: 288, height: 220 })).toEqual(pos)
  })

  it('clamp pulls an off-screen position back into bounds (restore/resize rule)', () => {
    const clamped = clampCardPosition({ x: 4000, y: -120 }, viewport, { width: 288, height: 220 })
    expect(clamped).toEqual({ x: 1280 - 0 - 288 - CHECKLIST_WINDOW_EDGE, y: CHECKLIST_CARD_MARGIN })
  })

  it('clamp is total on degenerate viewports (max < min falls back to the edge, never NaN)', () => {
    const degenerate: ChecklistViewport = { width: 100, height: 100, scrollbarWidth: 0, topClearance: 0, bottomClearance: 0 }
    const clamped = clampCardPosition({ x: 50, y: 50 }, degenerate, { width: 288, height: 220 })
    expect(clamped).toEqual({ x: CHECKLIST_WINDOW_EDGE, y: CHECKLIST_CARD_MARGIN })
    expect(Number.isFinite(clamped.x)).toBe(true)
    expect(Number.isFinite(clamped.y)).toBe(true)
  })

  it('drop over the transcript returns to the strip but KEEPS the dropped y (clamped)', () => {
    const resolved = resolveCardDrop({ x: 120, y: 500 }, viewport, { width: 288, height: 220 })
    expect(resolved).toEqual({ x: checklistCardHome(viewport, 288).x, y: 500 })
  })

  it('magnetic snap: a drop near the home corner lands EXACTLY home', () => {
    const home = checklistCardHome(viewport, 288)
    const resolved = resolveCardDrop(
      { x: 300, y: home.y + CHECKLIST_SNAP - 10 },
      viewport,
      { width: 288, height: 220 },
    )
    expect(resolved).toEqual(home)
  })

  /* WINDOWS SIMULATION — DECLARED, not proof. These tests feed
   * Windows-like geometry (17px scrollbar occupying layout space,
   * narrower effective width) into the pure functions. They simulate;
   * the real pixel on Windows/Linux stays unproven until a field run
   * — no local gate covers the WebView there. */
  it('WINDOWS SIM: home clears a 17px scrollbar lane', () => {
    const win: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 17, topClearance: 50, bottomClearance: 0 }
    expect(checklistCardHome(win, 288).x).toBe(1280 - 17 - CHECKLIST_CARD_MARGIN - 288)
  })

  it('WINDOWS SIM: a position saved on a larger monitor is re-contained on restore', () => {
    const savedOnBigMonitor = { x: 2400, y: 60 }
    const win: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 17, topClearance: 50, bottomClearance: 0 }
    const clamped = clampCardPosition(savedOnBigMonitor, win, { width: 288, height: 220 })
    expect(clamped.x).toBe(1280 - 17 - 288 - CHECKLIST_WINDOW_EDGE)
    expect(clamped.y).toBe(60) // above the rail top (50), untouched
  })

  it('WINDOWS SIM: 1.1× font metric grows the card — drop still lands in the strip', () => {
    // The docked rows are em-sized in CSS (font-metric guard); here the
    // taller CARD that a larger font produces is simulated as geometry.
    const win: ChecklistViewport = { width: 1366, height: 768, scrollbarWidth: 17, topClearance: 50, bottomClearance: 0 }
    const tallerCard = { width: 288, height: Math.round(220 * 1.1) }
    const resolved = resolveCardDrop({ x: 500, y: 900 }, win, tallerCard)
    expect(resolved.x).toBe(1366 - 17 - CHECKLIST_CARD_MARGIN - 288)
    expect(resolved.y).toBe(768 - tallerCard.height - CHECKLIST_WINDOW_EDGE)
  })
})

describe('checklistPlacement: TodoWrite state semantics', () => {
  const item = (content: string, status: TodoItem['status'] = 'pending'): TodoItem => ({
    content,
    status,
    activeForm: '',
  })

  it('REPLACES the conversation list wholesale — never accumulates', () => {
    const first = [item('a'), item('b')]
    const second = [item('a', 'completed'), item('b', 'in_progress'), item('c')]
    const afterFirst = applyTodoWrite({}, 'conv-1', first)
    const afterSecond = applyTodoWrite(afterFirst, 'conv-1', second)
    expect(afterSecond['conv-1']).toBe(second)
    expect(afterSecond['conv-1']).toHaveLength(3)
  })

  it('POSSESSION: a TodoWrite for one conversation never touches another', () => {
    const mine = [item('mine')]
    const theirs = [item('theirs')]
    const state = applyTodoWrite(applyTodoWrite({}, 'conv-1', mine), 'conv-2', theirs)
    expect(state['conv-1']).toBe(mine)
    expect(state['conv-2']).toBe(theirs)
    const replaced = applyTodoWrite(state, 'conv-2', [item('theirs', 'completed')])
    expect(replaced['conv-1']).toBe(mine)
  })

  it('ABSENCE is not a clear: todos === undefined leaves the entry standing', () => {
    // skip_serializing_if drops the key when there is no list — a
    // non-todowrite activity must not wipe the visible checklist.
    const state = applyTodoWrite({}, 'conv-1', [item('a')])
    expect(applyTodoWrite(state, 'conv-1', undefined)).toBe(state)
  })

  it('referential stability: re-sending the identical array keeps the record reference', () => {
    const list = [item('a')]
    const state = applyTodoWrite({}, 'conv-1', list)
    expect(applyTodoWrite(state, 'conv-1', list)).toBe(state)
  })

  it('removeChecklistForConversation drops only that conversation', () => {
    const state = applyTodoWrite(applyTodoWrite({}, 'conv-1', [item('a')]), 'conv-2', [item('b')])
    const next = removeChecklistForConversation(state, 'conv-1')
    expect(next['conv-1']).toBeUndefined()
    expect(next['conv-2']).toEqual([item('a'.replace('a', 'b'))])
    // Missing key: same reference, no churn.
    expect(removeChecklistForConversation(state, 'conv-9')).toBe(state)
  })
})

describe('checklistPlacement: THE SHARED TOP-RIGHT RAIL (field collision fix)', () => {
  it('CHIP INVARIANCE on the FORM: subagentChipPresent NEVER changes floating vs docked', () => {
    // The chip is small and transient and appears in exactly the runs
    // where the checklist matters most (subagent-heavy batches).
    // Banishing the card to docked would punish the common case — so
    // the chip shifts GEOMETRY (topClearance), never the form. Crossed
    // over the whole matrix to PROVE the invariance, not assume it.
    for (const input of MATRIX) {
      const flipped = { ...input, subagentChipPresent: !(input.subagentChipPresent === true) }
      expect(resolveChecklistPlacement(flipped)).toEqual(resolveChecklistPlacement(input))
    }
  })

  const viewport: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 0, topClearance: 0, bottomClearance: 0 }

  it('without clearance the rail top is the plain home margin', () => {
    expect(checklistCardHome(viewport, 288).y).toBe(CHECKLIST_CARD_MARGIN)
  })

  it('with the subagent chip present the card home sits BELOW the chip', () => {
    // Chip at titlebar(56)+14, ~30px tall, +8px gap → clearance 108.
    const withChip: ChecklistViewport = { ...viewport, topClearance: 108 }
    expect(checklistCardHome(withChip, 288).y).toBe(108)
  })

  it('a drop ABOVE the rail can visit during the drag but CANNOT rest there', () => {
    // Contrafactual: if the rail clamp did not exist, this drop would
    // rest at y=20 — INSIDE the chip strip — and the field collision
    // would be back. The resolved rest must be the rail top.
    const withChip: ChecklistViewport = { ...viewport, topClearance: 108 }
    const resolved = resolveCardDrop({ x: 300, y: 20 }, withChip, { width: 288, height: 220 })
    expect(resolved.y).toBe(108)
    expect(resolved.x).toBe(checklistCardHome(withChip, 288).x)
  })

  it('a persisted position parked over the chip is re-contained on restore', () => {
    const withChip: ChecklistViewport = { ...viewport, topClearance: 108 }
    const clamped = clampCardPosition({ x: 976, y: 30 }, withChip, { width: 288, height: 220 })
    expect(clamped.y).toBe(108)
  })

  it('the titlebar strip itself is a clearance: the card never parks at y=16 again', () => {
    // Latent defect fixed along the way: y=16 parked the card INSIDE
    // the 36px Windows/Linux titlebar (window controls sit top-right
    // there). Rail origin = titlebar(36) + 14 = 50.
    const win: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 17, topClearance: 50, bottomClearance: 0 }
    expect(checklistCardHome(win, 288).y).toBe(50)
    const resolved = resolveCardDrop({ x: 400, y: 10 }, win, { width: 288, height: 220 })
    expect(resolved.y).toBe(50)
  })
})

describe('checklistPlacement: THE BOTTOM RAIL — the card never enters the composer band', () => {
  /* Field defect (2026-08-01, measured in the packaged app): the
   * composer dock (.bottom-dock, position:fixed z120) draws OVER the
   * floating card (z40) and hid the list's bottom rows (overlap band
   * x 1000-1090, y 700-745). The fix is GEOMETRIC, not stacking — the
   * composer is where the user writes and must never be covered, and
   * the goal keeps the near-composer slot — so the lane's usable bottom
   * discounts the dock's REAL measured height (bottomClearance), the
   * symmetric of the top rail. Proven here by RECTANGLE INTERSECTION,
   * never by CSS existence. */

  const card = { width: CHECKLIST_CARD_WIDTH, height: 220 }

  /** Axis-aligned rectangle overlap area — the honest geometric proof. */
  function overlapArea(
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ): number {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    return Math.max(0, w) * Math.max(0, h)
  }

  const SHORT_COMPOSER: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 0, topClearance: 0, bottomClearance: 116 }
  const TALL_COMPOSER: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 0, topClearance: 0, bottomClearance: 300 }

  /** The band the dock occupies: its top to the viewport bottom, full
   *  width (the composer is centered but the user measured the overlap
   *  inside the card's x range — the strip is what matters). */
  function composerBand(viewport: ChecklistViewport) {
    return { x: 0, y: viewport.height - viewport.bottomClearance, w: viewport.width, h: viewport.bottomClearance }
  }

  function cardRect(pos: { x: number; y: number }) {
    return { x: pos.x, y: pos.y, w: card.width, h: card.height }
  }

  it('GEOMETRIC PROOF: a drop inside the SHORT composer band resolves with ZERO overlap', () => {
    const resolved = resolveCardDrop({ x: 1050, y: 700 }, SHORT_COMPOSER, card)
    expect(resolved.y).toBe(800 - 116 - 220 - CHECKLIST_WINDOW_EDGE)
    expect(overlapArea(cardRect(resolved), composerBand(SHORT_COMPOSER))).toBe(0)
  })

  it('GEOMETRIC PROOF: a drop inside the TALL composer band resolves with ZERO overlap', () => {
    const resolved = resolveCardDrop({ x: 1050, y: 600 }, TALL_COMPOSER, card)
    expect(overlapArea(cardRect(resolved), composerBand(TALL_COMPOSER))).toBe(0)
    expect(resolved.y + card.height).toBeLessThanOrEqual(TALL_COMPOSER.height - TALL_COMPOSER.bottomClearance)
  })

  it('CONTRAFACTUAL: with zero bottom clearance even the deepest LEGAL rest overlaps the band', () => {
    // The pre-fix math: the drop clamps to the old bottom bound (572)
    // and STILL crosses the composer band by 108px — exactly what the
    // user measured in the packaged app. If the rail math regressed to
    // zero, this is what would come back.
    const noRail: ChecklistViewport = { ...SHORT_COMPOSER, bottomClearance: 0 }
    const resolved = resolveCardDrop({ x: 1050, y: 700 }, noRail, card)
    expect(resolved.y).toBe(800 - 0 - 220 - CHECKLIST_WINDOW_EDGE)
    expect(overlapArea(cardRect(resolved), composerBand(SHORT_COMPOSER))).toBeGreaterThan(0)
  })

  it('a parked position inside the band is re-contained ABOVE it on restore/resize', () => {
    const clamped = clampCardPosition({ x: 976, y: 700 }, SHORT_COMPOSER, card)
    expect(overlapArea(cardRect(clamped), composerBand(SHORT_COMPOSER))).toBe(0)
  })

  it('the clamp stays total when the composer eats the whole lane: degenerate, never NaN', () => {
    const eaten: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 0, topClearance: 0, bottomClearance: 790 }
    const clamped = clampCardPosition({ x: 976, y: 400 }, eaten, card)
    expect(Number.isFinite(clamped.y)).toBe(true)
    expect(clamped.y).toBe(CHECKLIST_CARD_MARGIN) // falls back to the rail top
  })

  it('WINDOWS SIM: a 1.1× composer metric grows the band — still zero overlap', () => {
    // DECLARED simulation, not proof: Windows font metrics grow the
    // dock; here the grown band is fed as geometry. The real pixel on
    // Windows/Linux stays unproven until a field run — no local gate
    // covers the WebView there.
    const winTall: ChecklistViewport = {
      width: 1366,
      height: 768,
      scrollbarWidth: 17,
      topClearance: 50,
      bottomClearance: Math.round(116 * 1.1),
    }
    const resolved = resolveCardDrop({ x: 1000, y: 700 }, winTall, card)
    expect(overlapArea(cardRect(resolved), composerBand(winTall))).toBe(0)
  })
})
