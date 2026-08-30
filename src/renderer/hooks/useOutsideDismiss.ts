import { useEffect } from 'react'
import type { RefObject } from 'react'

export function useOutsideDismiss<T extends HTMLElement>(
  ref: RefObject<T | null>,
  open: boolean,
  onDismiss: () => void,
  /** Node(s) whose pointerdown should NOT trigger dismiss. Use when the
   *  trigger element sits outside the dismissed panel — e.g. a button that
   *  toggles a popover. Without this, the pointerdown fires dismiss before
   *  the click toggles the panel back open (race condition). */
  ignoreRefs?: RefObject<HTMLElement | null>[],
) {
  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (ref.current?.contains(target)) return
      if (ignoreRefs?.some(r => r.current?.contains(target))) return
      onDismiss()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onDismiss()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open, onDismiss, ref, ignoreRefs])
}
