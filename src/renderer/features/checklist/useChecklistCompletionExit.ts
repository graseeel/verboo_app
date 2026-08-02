import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TodoItem } from '../../../shared/types'

/**
 * useChecklistCompletionExit — the completed list LEAVES (user order,
 * 2026-08-01: "o checklist deve sumir assim que for completado, NÃO
 * deve permanecer na tela, com animação suave de saída").
 *
 * THE SEQUENCE, in this exact order:
 *   1. the last item completes → the collapsed "All done" row / the
 *      fully-checked card stays visible for the DWELL (1600ms);
 *   2. the exit animation plays (260ms — the exact reverse of the
 *      genie-in, same motion family);
 *   3. ONLY THEN the list is removed from state (the caller clears the
 *      conversation entry → placement null → unmount).
 *
 * WHY 1600ms (design decision, with emil-design-eng): the dwell is the
 * user's CONFIRMATION that the work ended — remove it and the last
 * check drawing is stolen from the screen before the eye registers it;
 * stretch it and the completed list becomes exactly the lingering noise
 * the user vetoed twice this cycle. ~1.6s is one comfortable glance at
 * "All done"; the 260ms exit matches the entrance duration so arrival
 * and departure feel like the same object moving.
 *
 * prefers-reduced-motion: the dwell STILL applies (it is confirmation
 * content, not motion) and the removal is INSTANT — no exit animation,
 * no fade. The user asked for information to leave, not theater.
 *
 * IDENTITY GUARD (the new-list race, same care as the goal genie pin):
 * the timers belong to the (conversationId, todos REFERENCE) pair.
 * applyTodoWrite keeps referential stability, so an identical re-send
 * never restarts the dwell; a genuinely NEW list (or a conversation
 * switch) cancels the pending dwell/exit/removal synchronously — a
 * stale timer can never delete a list that replaced the completed one.
 *
 * SCOPE DECISION (declared): the watcher runs on the ACTIVE
 * conversation's VISIBLE list only. A list that completes in a
 * background conversation keeps its completed state until viewed — the
 * dwell then runs on first sight, so the confirmation is never consumed
 * invisibly. Possession discipline: no invisible mutation of another
 * conversation's UI state.
 */

/** How long the completed state stays readable before leaving. */
export const CHECKLIST_DONE_DWELL_MS = 1600
/** The exit animation duration — mirrors the entrance (genie family). */
export const CHECKLIST_EXIT_MS = 260

function defaultPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

export function useChecklistCompletionExit(
  conversationId: string | undefined,
  todos: TodoItem[] | undefined,
  onRemove: (conversationId: string) => void,
  options?: { prefersReducedMotion?: () => boolean },
): { exiting: boolean } {
  const [exiting, setExiting] = useState(false)
  const onRemoveRef = useRef(onRemove)
  useLayoutEffect(() => {
    onRemoveRef.current = onRemove
  })
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })

  useEffect(() => {
    // Any identity change (new list, pending item, conversation switch)
    // drops the exit state and, via the cleanup, cancels the timers.
    setExiting(false)
    if (!conversationId || !todos || todos.length === 0) return
    if (!todos.every(item => item.status === 'completed')) return

    const reduced = optionsRef.current?.prefersReducedMotion?.() ?? defaultPrefersReducedMotion()
    let exitTimer: number | undefined
    const dwellTimer = window.setTimeout(() => {
      if (reduced) {
        onRemoveRef.current(conversationId)
        return
      }
      setExiting(true)
      exitTimer = window.setTimeout(() => {
        onRemoveRef.current(conversationId)
      }, CHECKLIST_EXIT_MS)
    }, CHECKLIST_DONE_DWELL_MS)

    return () => {
      window.clearTimeout(dwellTimer)
      window.clearTimeout(exitTimer)
    }
  }, [conversationId, todos])

  return { exiting }
}
