import { useEffect, useRef, useState } from 'react'
import type { GoalState, GoalStatus } from '../../../shared/types'

/**
 * useGoalPanelExit — keeps the goal panel mounted for a beat AFTER the
 * goal reaches a terminal state so it can play its "genie back into the
 * composer" exit animation (user request: the panel rises from the
 * composer on start and sinks back on finish, macOS-genie style).
 *
 * How it works: while the goal is LIVE (active/evaluating/continuing/
 * paused) we snapshot it. The moment it turns terminal (completed/
 * blocked) we expose that snapshot as `exitGoal` for `durationMs` —
 * the parent renders <GoalActivePanel goal={exitGoal} leaving /> so the
 * CSS exit animation plays, then the hook clears it and the panel
 * unmounts. The animation only transforms opacity/transform, so the
 * conversation never reflows.
 *
 * Honest limits, by design:
 * - `paused` is NOT an exit: the batch can pause (K-guard, needsUser,
 *   user) and the panel must STAY visible — exit is for terminal only.
 * - Clear/cancel and conversation switches set goal to `undefined`:
 *   those unmount instantly, no animation. An explicit cancel already
 *   has immediate feedback (the panel disappears on the user's own
 *   click), and animating a stale panel over a freshly-switched
 *   conversation would be confusing — the two signals are
 *   indistinguishable at this level, so neither animates.
 * - `prefers-reduced-motion`: no exit window at all — the panel
 *   unmounts immediately, exactly as before this hook existed. The CSS
 *   genie must never play under reduced motion.
 */
export function useGoalPanelExit(
  goal: GoalState | undefined,
  options?: {
    /** Exit-window length. Must EXCEED the CSS exit animation (240ms)
     *  so the node is not unmounted before the last frame paints. */
    durationMs?: number
    /** Injectable for tests; defaults to the live matchMedia query. */
    prefersReducedMotion?: () => boolean
  },
): { exitGoal: GoalState | undefined } {
  const [exitGoal, setExitGoal] = useState<GoalState | undefined>(undefined)
  const lastLiveGoalRef = useRef<GoalState | undefined>(undefined)
  // Options via ref so inline call-site lambdas don't retrigger the
  // effect (which would restart the exit timer on every render).
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  useEffect(() => {
    if (goal && !TERMINAL_STATUSES.has(goal.status)) {
      // Live goal: refresh the snapshot and cancel any pending exit —
      // covers "resume from blocked" (goal leaves terminal back to
      // active) and "new goal started" (different id, content swaps).
      lastLiveGoalRef.current = goal
      setExitGoal(undefined)
      return
    }

    if (goal && TERMINAL_STATUSES.has(goal.status)) {
      const snapshot = lastLiveGoalRef.current
      // No snapshot (app reopened on an already-terminal goal), a stale
      // snapshot from a DIFFERENT goal, or reduced motion: no exit
      // window — the panel simply never was / disappears at once.
      if (!snapshot || snapshot.id !== goal.id) return
      if (optionsRef.current?.prefersReducedMotion?.() ?? defaultPrefersReducedMotion()) return

      setExitGoal(snapshot)
      const durationMs = optionsRef.current?.durationMs ?? EXIT_WINDOW_MS
      const timer = setTimeout(() => setExitGoal(undefined), durationMs)
      return () => clearTimeout(timer)
    }

    // goal === undefined (clear/cancel, conversation switch): drop any
    // pending exit ghost immediately — no animation on this path.
    lastLiveGoalRef.current = undefined
    setExitGoal(undefined)
  }, [goal])

  return { exitGoal }
}

/** 240ms CSS exit animation + 40ms paint buffer. */
const EXIT_WINDOW_MS = 280

const TERMINAL_STATUSES: ReadonlySet<GoalStatus> = new Set(['completed', 'blocked', 'cancelled'])

function defaultPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}
