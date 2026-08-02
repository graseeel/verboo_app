import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { CHECKLIST_FLIGHT_MS, type ChecklistPlacement } from './checklistPlacement'

/**
 * useChecklistFlight — the FLIP migration between the checklist's two
 * forms (floating card ⇄ docked window), translated from the approved
 * prototype's flyTo():
 *
 *   1. measure the element where it IS (old form, still mounted)
 *   2. render it in the NEW container in-flow for one pre-paint commit
 *      and measure the target geometry (layout effects run before
 *      paint, so this never flashes)
 *   3. pin it at the old rect with position:fixed (no transition),
 *      force a reflow, then transition left/top/width/height to the
 *      target rect — the element FLIES
 *   4. a spacer div animates the flow space in parallel (0→height when
 *      docking, height→0 when floating away) so the goal panel and the
 *      composer SLIDE instead of jumping
 *   5. commit by TIMER (anti-throttle cure: animations pause in hidden
 *      tabs, timers don't) — the panel enters flow and the spacer is
 *      removed in the SAME state update, so the swap is atomic and
 *      nothing reflows
 *
 * CHOREOGRAPHY WITH THE GOAL GENIE (single-owner rule): this hook owns
 * ONLY the form switch. It can never fire inside the goal panel's
 * 280ms genie exit window because its trigger — the placement returned
 * by resolveChecklistPlacement — takes `goalDocked` as an input, and
 * the ghost keeps that input true for the whole window. The migration
 * starts only when the ghost clears and the placement actually flips.
 *
 * prefers-reduced-motion: NO flight, NO spacer — the placement switch
 * commits instantly. The user asked for information, not theater.
 */

type Rect = { x: number; y: number; width: number; height: number }

type FlightPhase = 'measure' | 'enter' | 'move'

type Flight = {
  phase: FlightPhase
  from: Rect
  to: Rect | null
  /** Where the flight is heading — decides spacer direction. */
  toDocked: boolean
}

export type ChecklistFlight = {
  /** The placement the containers should render NOW. */
  committed: ChecklistPlacement
  /** Inline fixed geometry for the panel while flying. */
  flightStyle: CSSProperties | undefined
  flying: boolean
  /** First-appearance flag (null → form). Cleared after the entrance
   *  duration; the component suppresses it under reduced motion. */
  entering: boolean
  /** Spacer to render INSIDE the aux-stack while flying (animated
   *  height). Null when no flight involves the dock. */
  spacerHeight: number | null
  /** The panel registers its root element here so the hook can
   *  measure it across remounts (the element moves between the
   *  aux-stack and a body portal). */
  registerPanel: (el: HTMLElement | null) => void
}

const ZERO_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 }

function placementEquals(a: ChecklistPlacement, b: ChecklistPlacement): boolean {
  if (a === null || b === null) return a === b
  if (a.form !== b.form) return false
  if (a.form === 'docked' && b.form === 'docked') return a.anchor === b.anchor
  return true
}

function defaultPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

export function useChecklistFlight(
  desired: ChecklistPlacement,
  options?: { prefersReducedMotion?: () => boolean },
): ChecklistFlight {
  const [committed, setCommitted] = useState<ChecklistPlacement>(desired)
  const [flight, setFlight] = useState<Flight | null>(null)
  const [entering, setEntering] = useState(false)
  const panelElRef = useRef<HTMLElement | null>(null)
  const enterTimerRef = useRef<number | undefined>(undefined)
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })

  const reduced = () => optionsRef.current?.prefersReducedMotion?.() ?? defaultPrefersReducedMotion()

  /* Desired-placement driver: switches `committed`, starting a flight
   * for floating⇄docked transitions and an entrance for null→form. */
  useLayoutEffect(() => {
    if (placementEquals(desired, committed)) return

    if (reduced()) {
      setFlight(null)
      setCommitted(desired)
      return
    }

    if (desired === null || committed === null) {
      // Appear: entrance animation (component applies the genie-in
      // class). Disappear: instant — the list only vanishes when the
      // conversation switches or is deleted, and animating a stale
      // card over a fresh conversation would be confusing (same
      // reasoning as useGoalPanelExit).
      setFlight(null)
      setCommitted(desired)
      if (desired !== null) {
        setEntering(true)
        window.clearTimeout(enterTimerRef.current)
        enterTimerRef.current = window.setTimeout(() => setEntering(false), CHECKLIST_FLIGHT_MS + 40)
      }
      return
    }

    // Form switch: measure the element where it IS, then hand off to
    // the flight phase driver below.
    if (desired.form === committed.form) {
      // Anchor-only change (above-goal ⇄ above-composer): the docked
      // element is ALWAYS the stack's first child — the anchor is
      // semantic, nothing moves on screen. Switch SILENTLY: this is
      // also what keeps the checklist inert through the goal's genie
      // exit — the ghost clearing flips the anchor, and no flight
      // fires because no pixel needs to move.
      setCommitted(desired)
      return
    }
    const measured = panelElRef.current?.getBoundingClientRect()
    const fromRect: Rect = measured
      ? { x: measured.left, y: measured.top, width: measured.width, height: measured.height }
      : ZERO_RECT
    setCommitted(desired)
    setFlight({ phase: 'measure', from: fromRect, to: null, toDocked: desired.form === 'docked' })
  }, [desired, committed])

  /* Flight phase driver: measure → enter → move → (timer) commit. */
  useLayoutEffect(() => {
    if (!flight) return
    const el = panelElRef.current

    if (flight.phase === 'measure') {
      if (!el) {
        setFlight(null)
        return
      }
      const rect = el.getBoundingClientRect()
      setFlight({
        ...flight,
        phase: 'enter',
        to: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      })
      return
    }

    if (flight.phase === 'enter') {
      // Force the reflow that separates the from-frame from the
      // transition — without it the browser batches both and no
      // animation runs.
      if (el) void el.offsetHeight
      setFlight({ ...flight, phase: 'move' })
      return
    }

    // phase 'move': commit by timer, NEVER by transitionend (hidden
    // tabs throttle transitions; the commit must still land).
    const timer = window.setTimeout(() => setFlight(null), CHECKLIST_FLIGHT_MS + 40)
    return () => window.clearTimeout(timer)
  }, [flight])

  useLayoutEffect(() => () => window.clearTimeout(enterTimerRef.current), [])

  const flightStyle: CSSProperties | undefined = (() => {
    if (!flight || flight.phase === 'measure') return undefined
    const rect = flight.phase === 'enter' ? flight.from : (flight.to ?? flight.from)
    return {
      position: 'fixed',
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      margin: 0,
      zIndex: 60,
      pointerEvents: 'none',
      transition:
        flight.phase === 'move'
          ? `left ${CHECKLIST_FLIGHT_MS}ms var(--modal-ease), top ${CHECKLIST_FLIGHT_MS}ms var(--modal-ease), width ${CHECKLIST_FLIGHT_MS}ms var(--modal-ease), height ${CHECKLIST_FLIGHT_MS}ms var(--modal-ease)`
          : 'none',
    }
  })()

  const spacerHeight = (() => {
    if (!flight || flight.phase === 'measure') return null
    if (flight.toDocked) {
      return flight.phase === 'move' ? (flight.to?.height ?? 0) : 0
    }
    return flight.phase === 'move' ? 0 : flight.from.height
  })()

  return {
    committed,
    flightStyle,
    flying: flight !== null,
    entering,
    spacerHeight,
    registerPanel: (el: HTMLElement | null) => {
      panelElRef.current = el
    },
  }
}
