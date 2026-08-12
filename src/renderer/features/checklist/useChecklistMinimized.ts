import { useRef, useState } from 'react'

/**
 * useChecklistMinimized — the floating checklist card's compact-bar
 * state, OWNED by the active conversation.
 *
 * POSSE (gate da Sonda, 2026-08-12): the checklist itself is
 * per-conversation (todosByConversation), so this state obeys the same
 * owner. A single App-level boolean leaked across conversations —
 * minimize in A and B opened minimized. Here the owner conversation id
 * is an INPUT: when it changes, the state resets to expanded DURING the
 * render that observes the change (React's "adjusting state when props
 * change" pattern), so the new conversation's list never paints a
 * stale minimized frame.
 *
 * DECISION: reset semantics, NOT per-conversation memory — returning
 * to conversation A does not restore the bar (see the test file for the
 * rationale). Deliberately not in localStorage either: minimizing is a
 * per-session focus gesture, unlike the form or the parked position.
 */
export function useChecklistMinimized(conversationId: string | undefined): {
  minimized: boolean
  toggleMinimized: () => void
} {
  const [minimized, setMinimized] = useState(false)
  const ownerRef = useRef(conversationId)
  if (ownerRef.current !== conversationId) {
    ownerRef.current = conversationId
    if (minimized) setMinimized(false)
  }
  return {
    minimized,
    toggleMinimized: () => setMinimized(value => !value),
  }
}
