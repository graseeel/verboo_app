import { useEffect, useRef, type RefObject } from 'react'
import type { AndroidEmulatorKey } from './androidEmulatorApi'
import type { IosSimulatorKey, IosSimulatorPoint } from './iosSimulatorApi'
import { pointToNormalizedOnSurface, type Size } from './simulatorGeometry'

export type SimulatorInteractionMode = 'interact' | 'select-element' | 'select-area'

export type SimulatorInteractionHandlers = {
  onPointerDown: React.PointerEventHandler<HTMLDivElement>
  onPointerMove: React.PointerEventHandler<HTMLDivElement>
  onPointerUp: React.PointerEventHandler<HTMLDivElement>
  onPointerCancel: React.PointerEventHandler<HTMLDivElement>
  onClick: React.MouseEventHandler<HTMLDivElement>
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>
  onPaste: React.ClipboardEventHandler<HTMLDivElement>
  onCompositionStart: React.CompositionEventHandler<HTMLDivElement>
  onCompositionEnd: React.CompositionEventHandler<HTMLDivElement>
}

/** Maps a DOM keyboard event to the platform's special-key vocabulary. */
export type SimulatorKeyMapper<K> = (event: Pick<KeyboardEvent, 'key'>) => K | null

type Options<K extends string> = {
  surfaceRef: RefObject<HTMLDivElement | null>
  imageRef: RefObject<HTMLImageElement | null>
  mode: SimulatorInteractionMode
  interactive: boolean
  onTap: (point: IosSimulatorPoint) => void
  onDrag: (from: IosSimulatorPoint, to: IosSimulatorPoint, durationMs: number) => void
  onTypeText: (text: string) => void
  onPressKey: (key: K) => void
  /** Injectable per-platform key mapper (PA-27 adapter parametrization);
   *  defaults to the iOS mapper. */
  keyMapper?: SimulatorKeyMapper<K>
  /** Dimensões EXPLÍCITAS do header VAF1 no modo canvas Android — ausente no
   *  iOS, onde o tamanho vem do naturalWidth/Height do <img>. */
  mediaSize?: Size
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

/** Android press_key mapper (contract `contrato-android-simulator` §key map —
 *  all nine frozen names map to adb keycodes in the native adapter). */
export function androidEmulatorKeyForKeyboardEvent(
  event: Pick<KeyboardEvent, 'key'>,
): AndroidEmulatorKey | null {
  switch (event.key) {
    case 'Enter': return 'enter'
    case 'Backspace': return 'backspace'
    case 'Tab': return 'tab'
    case 'Escape': return 'escape'
    case 'ArrowUp': return 'arrowUp'
    case 'ArrowDown': return 'arrowDown'
    case 'ArrowLeft': return 'arrowLeft'
    case 'ArrowRight': return 'arrowRight'
    case ' ': return 'space'
    default: return null
  }
}

export function useSimulatorInteraction<K extends string = IosSimulatorKey>(
  options: Options<K>,
): SimulatorInteractionHandlers {
  const keyMapper = (options.keyMapper ?? simulatorKeyForKeyboardEvent) as SimulatorKeyMapper<K>
  const pointerRef = useRef<PointerStart | null>(null)
  const suppressClickRef = useRef(false)
  const composingRef = useRef(false)

  function normalizedAt(clientX: number, clientY: number) {
    const surface = options.surfaceRef.current
    if (!surface) return null
    const size = options.mediaSize
      ?? (options.imageRef.current
        ? {
            width: options.imageRef.current.naturalWidth,
            height: options.imageRef.current.naturalHeight,
          }
        : null)
    if (!size) return null
    return pointToNormalizedOnSurface(surface, size, clientX, clientY)
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
        || pointerRef.current !== null
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
      suppressClickRef.current = false
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
      if (distance > TAP_MOVEMENT_PX) {
        suppressClickRef.current = true
        options.onDrag(start.normalized, end, 180)
      }
    },
    onPointerCancel(event) {
      if (pointerRef.current?.pointerId === event.pointerId) clearPointer()
    },
    onClick(event) {
      if (!ownsInteraction() || event.button !== 0) return
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        return
      }
      const point = normalizedAt(event.clientX, event.clientY)
      if (!point) return
      event.preventDefault()
      options.onTap(point)
    },
    onKeyDown(event) {
      if (!ownsInteraction()) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (composingRef.current || event.nativeEvent.isComposing) return
      const special = keyMapper(event.nativeEvent)
      if (special) {
        event.preventDefault()
        options.onPressKey(special)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        clearPointer()
        event.currentTarget.blur()
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
