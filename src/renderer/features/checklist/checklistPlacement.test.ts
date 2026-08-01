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
 * sidebar × terminal × review × web × goal × preference × dragged
 * position. A pure function is the only way to PROVE that without
 * opening the app thirty times — so every combination of the six
 * binary inputs is crossed here (2^6 = 64), with the dragged position
 * crossed as geometry invariants over the same matrix.
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
              for (const preference of ['float', 'dock'] as ChecklistFormPreference[])
                inputs.push({
                  hasList,
                  goalDocked,
                  terminalOpen,
                  reviewOpen,
                  webOpen,
                  sidebarOpen,
                  preference,
                })
  return inputs
}

const MATRIX = everyCombination()

describe('checklistPlacement: exhaustive matrix (128 combinations of 7 binary inputs)', () => {
  it('crosses every binary input exactly 128 times (2^7)', () => {
    expect(MATRIX).toHaveLength(128)
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
    const viewport: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 0 }
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
      expect(resolved.y).toBeGreaterThanOrEqual(CHECKLIST_WINDOW_EDGE)
      expect(resolved.y).toBeLessThanOrEqual(viewport.height - card.height - CHECKLIST_WINDOW_EDGE)
    }
  })
})

describe('checklistPlacement: card geometry (pure)', () => {
  const viewport: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 0 }

  it('home is the top-right corner clear of margin and scrollbar', () => {
    expect(checklistCardHome(viewport, CHECKLIST_CARD_WIDTH)).toEqual({
      x: 1280 - 0 - CHECKLIST_CARD_MARGIN - CHECKLIST_CARD_WIDTH,
      y: CHECKLIST_CARD_MARGIN,
    })
  })

  it('home never goes left of the window edge on a tiny viewport', () => {
    const tiny: ChecklistViewport = { width: 200, height: 300, scrollbarWidth: 0 }
    expect(checklistCardHome(tiny, CHECKLIST_CARD_WIDTH).x).toBe(CHECKLIST_WINDOW_EDGE)
  })

  it('clamp keeps an in-bounds position untouched', () => {
    const pos = { x: 900, y: 200 }
    expect(clampCardPosition(pos, viewport, { width: 288, height: 220 })).toEqual(pos)
  })

  it('clamp pulls an off-screen position back into bounds (restore/resize rule)', () => {
    const clamped = clampCardPosition({ x: 4000, y: -120 }, viewport, { width: 288, height: 220 })
    expect(clamped).toEqual({ x: 1280 - 0 - 288 - CHECKLIST_WINDOW_EDGE, y: CHECKLIST_WINDOW_EDGE })
  })

  it('clamp is total on degenerate viewports (max < min falls back to the edge, never NaN)', () => {
    const degenerate: ChecklistViewport = { width: 100, height: 100, scrollbarWidth: 0 }
    const clamped = clampCardPosition({ x: 50, y: 50 }, degenerate, { width: 288, height: 220 })
    expect(clamped).toEqual({ x: CHECKLIST_WINDOW_EDGE, y: CHECKLIST_WINDOW_EDGE })
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
    const win: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 17 }
    expect(checklistCardHome(win, 288).x).toBe(1280 - 17 - CHECKLIST_CARD_MARGIN - 288)
  })

  it('WINDOWS SIM: a position saved on a larger monitor is re-contained on restore', () => {
    const savedOnBigMonitor = { x: 2400, y: 60 }
    const win: ChecklistViewport = { width: 1280, height: 800, scrollbarWidth: 17 }
    const clamped = clampCardPosition(savedOnBigMonitor, win, { width: 288, height: 220 })
    expect(clamped.x).toBe(1280 - 17 - 288 - CHECKLIST_WINDOW_EDGE)
    expect(clamped.y).toBe(60)
  })

  it('WINDOWS SIM: 1.1× font metric grows the card — drop still lands in the strip', () => {
    // The docked rows are em-sized in CSS (font-metric guard); here the
    // taller CARD that a larger font produces is simulated as geometry.
    const win: ChecklistViewport = { width: 1366, height: 768, scrollbarWidth: 17 }
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
