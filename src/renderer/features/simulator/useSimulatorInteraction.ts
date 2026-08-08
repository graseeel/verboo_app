import { useEffect, useRef, type RefObject } from 'react'
import type { IosSimulatorKey, IosSimulatorPoint } from './iosSimulatorApi'
import { clientPointToNormalized, paintedContainRect } from './simulatorGeometry'

export type SimulatorInteractionMode = 'interact' | 'select-area'

export type SimulatorInteractionHandlers = {
  onPointerDown: React.PointerEventHandler<HTMLDivElement>
  onPointerMove: React.PointerEventHandler<HTMLDivElement>
  onPointerUp: React.PointerEventHandler<HTMLDivElement>
  onPointerCancel: React.PointerEventHandler<HTMLDivElement>
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>
  onPaste: React.ClipboardEventHandler<HTMLDivElement>
  onCompositionStart: React.CompositionEventHandler<HTMLDivElement>
  onCompositionEnd: React.CompositionEventHandler<HTMLDivElement>
}

type Options = {
  surfaceRef: RefObject<HTMLDivElement | null>
  imageRef: RefObject<HTMLImageElement | null>
  mode: SimulatorInteractionMode
  interactive: boolean
  onTap: (point: IosSimulatorPoint) => void
  onDrag: (from: IosSimulatorPoint, to: IosSimulatorPoint, durationMs: number) => void
  onTypeText: (text: string) => void
  onPressKey: (key: IosSimulatorKey) => void
}

type PointerStart = {
  pointerId: number
  clientX: number
  clientY: number
  normalized: IosSimulatorPoint
  target: HTMLDivElement
}

const TAP_MOVEMENT_PX = 6

export function simulatorKeyForKeyboardEvent(event: Pick<KeyboardEvent, 'key'>): IosSimulatorKey | null {
  switch (event.key) {
    case 'Enter': return 'enter'
    case 'Backspace': return 'backspace'
    case 'Tab': return 'tab'
    case 'ArrowUp': return 'arrowUp'
    case 'ArrowDown': return 'arrowDown'
    case 'ArrowLeft': return 'arrowLeft'
    case 'ArrowRight': return 'arrowRight'
    default: return null
  }
}

export function useSimulatorInteraction(options: Options): SimulatorInteractionHandlers {
  const pointerRef = useRef<PointerStart | null>(null)
  const composingRef = useRef(false)

  function normalizedAt(clientX: number, clientY: number) {
    const surface = options.surfaceRef.current
    const image = options.imageRef.current
    if (!surface || !image) return null
    const bounds = surface.getBoundingClientRect()
    const painted = paintedContainRect(
      { width: bounds.width, height: bounds.height },
      { width: image.naturalWidth, height: image.naturalHeight },
    )
    return clientPointToNormalized(
      { x: clientX - bounds.left, y: clientY - bounds.top },
      painted,
    )
  }

  function clearPointer() {
    const pointer = pointerRef.current
    pointerRef.current = null
    if (!pointer) return
    try {
      if (pointer.target.hasPointerCapture?.(pointer.pointerId)) {
        pointer.target.releasePointerCapture(pointer.pointerId)
      }
    } catch {
      // The browser already released capture during cancellation.
    }
  }

  useEffect(() => {
    const cancel = () => clearPointer()
    window.addEventListener('blur', cancel)
    return () => window.removeEventListener('blur', cancel)
  })

  const ownsInteraction = () => options.interactive && options.mode === 'interact'

  return {
    onPointerDown(event) {
      if (
        !ownsInteraction()
        || event.button !== 0
        || (event.isPrimary === false && Boolean(event.pointerType))
      ) return
      const normalized = normalizedAt(event.clientX, event.clientY)
      if (!normalized) return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture is optional in synthetic/test environments.
      }
      pointerRef.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        normalized,
        target: event.currentTarget,
      }
    },
    onPointerMove(event) {
      if (pointerRef.current?.pointerId === event.pointerId) event.preventDefault()
    },
    onPointerUp(event) {
      const start = pointerRef.current
      if (!start || start.pointerId !== event.pointerId) return
      event.preventDefault()
      const end = normalizedAt(event.clientX, event.clientY)
      clearPointer()
      if (!end || !ownsInteraction()) return
      const distance = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY)
      if (distance <= TAP_MOVEMENT_PX) options.onTap(start.normalized)
      else options.onDrag(start.normalized, end, 180)
    },
    onPointerCancel(event) {
      if (pointerRef.current?.pointerId === event.pointerId) clearPointer()
    },
    onKeyDown(event) {
      if (!ownsInteraction()) return
      if (event.key === 'Escape') {
        event.preventDefault()
        clearPointer()
        event.currentTarget.blur()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (composingRef.current || event.nativeEvent.isComposing) return
      const special = simulatorKeyForKeyboardEvent(event.nativeEvent)
      if (special) {
        event.preventDefault()
        options.onPressKey(special)
        return
      }
      if (event.key.length === 1) {
        event.preventDefault()
        options.onTypeText(event.key)
      }
    },
    onPaste(event) {
      if (!ownsInteraction()) return
      const text = event.clipboardData.getData('text/plain')
      if (!text) return
      event.preventDefault()
      options.onTypeText(text)
    },
    onCompositionStart() {
      composingRef.current = true
    },
    onCompositionEnd(event) {
      composingRef.current = false
      if (ownsInteraction() && event.data) options.onTypeText(event.data)
    },
  }
}
