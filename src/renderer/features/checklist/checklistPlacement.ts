import type { TodoItem } from '../../../shared/types'

/**
 * checklistPlacement — PURE core of the task checklist (TodoWrite list).
 *
 * Every decision about WHERE the checklist lives and WHERE the floating
 * card rests is computed here, with zero DOM access, so the full matrix
 * of states can be tested without opening the app (the user required:
 * the UI must not break in ANY combination of sidebar × terminal ×
 * review × web × goal × preference × dragged position).
 *
 * THE TWO FORMS (approved in PROTOTYPE-checklist-b-v3.html):
 *   - floating: compact mini-modal card, top-right, draggable, height
 *     of its own content, full list visible.
 *   - docked: condensed 3-row window riding the composer aux-stack,
 *     NO header, NO border — quieter than the goal panel; collapses to
 *     a single row when every item is completed.
 *
 * ANCHORING (approved hierarchy):
 *   - The GOAL always stays closest to the composer; the checklist
 *     rides ABOVE it when docked (order: list → goal → composer).
 *   - preference 'float' + right lane FREE  → floating.
 *   - preference 'float' + right lane BUSY  → docked anyway (Maestro's
 *     ratification: the preference is "float WHEN POSSIBLE", not
 *     "float always" — the right side is physically occupied). When
 *     the lane frees up, the list migrates back to floating.
 *   - preference 'dock' → always docked.
 *   - NO goal + right lane free → floating as well (inference ratified
 *     by the Maestro in the v2 round: the right side is the preferred
 *     home whenever it is free; there is no dock conflict to resolve).
 *
 * SIDEBAR IS AN INVARIANT INPUT BY CONSTRUCTION: the card anchors to
 * the RIGHT edge of the viewport and the docked form follows the
 * composer lane. The sidebar lives on the LEFT and only changes the
 * available width — never the decision. It is still crossed in the
 * exhaustive matrix to PROVE the invariance, not assumed.
 *
 * SINGLE OWNER OF THE CHOREOGRAPHY (CADINHO's trap): the goal panel
 * has a 280ms genie exit window (useGoalPanelExit). The checklist
 * migration must NEVER fire inside that window, or the two animations
 * fight. The owner is the `goalDocked` INPUT: the caller computes it
 * as "any goal element occupying the aux-stack" — live panel, exit
 * ghost, or terminal status bar. During the exit window the input is
 * UNCHANGED, so this function returns the same placement and no
 * migration starts; only when the ghost clears does the placement
 * flip and the FLIP flight run. The checklist derives from committed
 * state only, never from transitions.
 */

export type ChecklistFormPreference = 'float' | 'dock'

export type ChecklistPlacementInput = {
  /** There is a checklist for the ACTIVE conversation (possession gate
   *  is applied by the caller — this flag must already be scoped). */
  hasList: boolean
  /** Any goal element occupying the composer aux-stack: live panel,
   *  genie exit ghost, or terminal status bar. See the choreography
   *  note above — this input is what serializes the two animations. */
  goalDocked: boolean
  terminalOpen: boolean
  reviewOpen: boolean
  webOpen: boolean
  /** Invariant by construction (see header) — crossed to prove it. */
  sidebarOpen: boolean
  preference: ChecklistFormPreference
  /** Extension beyond the literal order: the subagent thread panel is
   *  ALSO a right-lane surface. The rule's spirit is "the right side
   *  is physically occupied" — an overlapping floating card over an
   *  open lane panel is the exact defect the rule exists to prevent.
   *  Optional; defaults to false. */
  otherRightLaneOpen?: boolean
}

export type ChecklistDockAnchor = 'above-goal' | 'above-composer'

export type ChecklistPlacement =
  | { form: 'floating' }
  | { form: 'docked'; anchor: ChecklistDockAnchor }
  | null

export function resolveChecklistPlacement(input: ChecklistPlacementInput): ChecklistPlacement {
  if (!input.hasList) return null

  const rightOccupied =
    input.terminalOpen || input.reviewOpen || input.webOpen || input.otherRightLaneOpen === true

  const wantsFloat = input.preference === 'float' && !rightOccupied
  if (wantsFloat) return { form: 'floating' }

  return { form: 'docked', anchor: input.goalDocked ? 'above-goal' : 'above-composer' }
}

/* ── Floating-card geometry ─────────────────────────────────────────
 * USER RULE (new, non-negotiable): the card NEVER rests over the
 * transcript. If the user drags it there, it returns BY ITSELF and
 * FLUIDLY to the right side. So the ONLY legal resting zone is the
 * right strip: x is always the strip's home x; only y is free
 * (clamped). During the drag the card follows the pointer anywhere
 * (fluid feedback), and on release the component animates from the
 * drop point to the resolved resting position — the "volta sozinho".
 */

/** Card width in px (fixed, like the approved prototype). */
export const CHECKLIST_CARD_WIDTH = 288
/** Distance from the right edge / top when parked at home. */
export const CHECKLIST_CARD_MARGIN = 16
/** Minimum clearance to any window edge, in px. */
export const CHECKLIST_WINDOW_EDGE = 8
/** Magnetic snap radius around the home corner, in px. */
export const CHECKLIST_SNAP = 48
/** FLIP migration duration (prototype --flight-dur). */
export const CHECKLIST_FLIGHT_MS = 300

export type ChecklistViewport = {
  width: number
  height: number
  /** Measured AT RUNTIME as outerWidth − clientWidth style math
   *  (window.innerWidth − document.documentElement.clientWidth):
   *  on Windows the scrollbar OCCUPIES layout space (~17px), on macOS
   *  it overlays (0). Never assume a value — see the multiplatform
   *  note in ChecklistPanel. */
  scrollbarWidth: number
}

export type ChecklistCardSize = { width: number; height: number }
export type ChecklistCardPos = { x: number; y: number }

function clamp(value: number, min: number, max: number): number {
  // Tiny viewports can make max < min — fall back to min so the card
  // never gets a negative/NaN position (the clamp must be total).
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/** The right-strip home position (top-right corner, clear of the
 *  OS scrollbar lane). Pure: all geometry arrives as arguments. */
export function checklistCardHome(
  viewport: ChecklistViewport,
  cardWidth: number = CHECKLIST_CARD_WIDTH,
): ChecklistCardPos {
  return {
    x: Math.max(
      CHECKLIST_WINDOW_EDGE,
      viewport.width - viewport.scrollbarWidth - CHECKLIST_CARD_MARGIN - cardWidth,
    ),
    y: CHECKLIST_CARD_MARGIN,
  }
}

/** Keeps a position fully inside the window with the edge clearance.
 *  Applied when RESTORING a persisted position and on every RESIZE —
 *  a position saved on a large monitor is off-screen on a smaller one
 *  (multiplatform guard; the CADINHO's construction requirement). */
export function clampCardPosition(
  pos: ChecklistCardPos,
  viewport: ChecklistViewport,
  card: ChecklistCardSize,
): ChecklistCardPos {
  return {
    x: clamp(pos.x, CHECKLIST_WINDOW_EDGE, viewport.width - viewport.scrollbarWidth - card.width - CHECKLIST_WINDOW_EDGE),
    y: clamp(pos.y, CHECKLIST_WINDOW_EDGE, viewport.height - card.height - CHECKLIST_WINDOW_EDGE),
  }
}

/** Resolves where the card RESTS after a drop (user rule: never over
 *  the transcript). x ALWAYS returns to the right strip; y survives
 *  the drop (clamped into the window), with the magnetic snap pulling
 *  to the home corner when the drop lands near it. The glide back is
 *  the component's job — this function only computes the target. */
export function resolveCardDrop(
  candidate: ChecklistCardPos,
  viewport: ChecklistViewport,
  card: ChecklistCardSize,
): ChecklistCardPos {
  const home = checklistCardHome(viewport, card.width)
  const y = clamp(candidate.y, CHECKLIST_WINDOW_EDGE, viewport.height - card.height - CHECKLIST_WINDOW_EDGE)
  const nearHome = Math.abs(y - home.y) <= CHECKLIST_SNAP
  return { x: home.x, y: nearHome ? home.y : y }
}

/* ── Checklist state semantics ──────────────────────────────────────
 * Each TodoWrite call carries the WHOLE list and REPLACES it — never
 * accumulate. State is kept PER CONVERSATION (possession): a turn
 * belongs to its owner conversation, so a background conversation's
 * TodoWrite updates ITS OWN entry and never touches the card of the
 * conversation the user is looking at (the render gate is the
 * caller's; this module only keeps the records honest).
 */

/** Applies one TodoWrite event to the per-conversation record.
 *  `todos === undefined` means the key was ABSENT on the wire
 *  (skip_serializing_if) — absence is NOT a clear, the previous list
 *  stands. A present array replaces the entry wholesale. */
export function applyTodoWrite(
  prev: Record<string, TodoItem[]>,
  conversationId: string,
  todos: TodoItem[] | undefined,
): Record<string, TodoItem[]> {
  if (!todos) return prev
  const current = prev[conversationId]
  // Referential stability: an identical re-send keeps the same array
  // reference so React memoization downstream does not re-render.
  if (current && current.length === todos.length && current.every((item, i) => item === todos[i])) {
    return prev
  }
  return { ...prev, [conversationId]: todos }
}

/** Drops a conversation's checklist (conversation deleted). */
export function removeChecklistForConversation(
  prev: Record<string, TodoItem[]>,
  conversationId: string,
): Record<string, TodoItem[]> {
  if (!(conversationId in prev)) return prev
  const next = { ...prev }
  delete next[conversationId]
  return next
}
