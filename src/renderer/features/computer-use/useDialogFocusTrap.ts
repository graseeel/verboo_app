import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

type DialogFocusTrapOptions = {
  initialFocusRef?: RefObject<HTMLElement | null>
  onEscape: () => void
  enabled?: boolean
}

export function useDialogFocusTrap<T extends HTMLElement>({
  initialFocusRef,
  onEscape,
  enabled = true,
}: DialogFocusTrapOptions) {
  const dialogRef = useRef<T>(null)
  const onEscapeRef = useRef(onEscape)

  useEffect(() => {
    onEscapeRef.current = onEscape
  }, [onEscape])

  useEffect(() => {
    if (!enabled) return undefined
    const dialog = dialogRef.current
    if (!dialog) return undefined
    const mountedDialog: T = dialog

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const initialTarget = initialFocusRef?.current
    if (initialTarget && !initialTarget.matches(':disabled')) {
      initialTarget.focus()
    } else {
      focusableElements(mountedDialog)[0]?.focus() ?? mountedDialog.focus()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onEscapeRef.current()
        return
      }

      if (event.key !== 'Tab') return

      const focusables = focusableElements(mountedDialog)
      if (focusables.length === 0) {
        event.preventDefault()
        mountedDialog.focus()
        return
      }

      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement

      if (event.shiftKey && (active === first || !mountedDialog.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !mountedDialog.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [enabled, initialFocusRef])

  return dialogRef
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}
