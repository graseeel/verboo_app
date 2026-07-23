import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useI18n } from '../../i18n'
import { VerbooPetRig } from './VerbooPetRig'

export type PetState =
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'editing'
  | 'deleting'
  | 'command'
  | 'success'
  | 'error'

type VerbooPetProps = {
  visible: boolean
  state: PetState
  size: number
  onSizeChange: (size: number) => void
}

type Position = { x: number; y: number }

const POSITION_KEY = 'verboo:pet-position'
export const PET_MIN_SIZE = 72
export const PET_MAX_SIZE = 260

// Fluidity architecture:
// - The levitation loop lives on `.pet-float` and NEVER stops or restarts, so
//   state changes can't cause a visible hitch.
// - Each state only cross-fades an accessory layer (opacity/transform
//   transitions) and optionally layers an extra body animation whose keyframes
//   start AND end at a neutral transform — entering/leaving it never jumps.
// - Everything animates transform/opacity only (compositor), no layout props.
export function VerbooPet({ visible, state, size, onSizeChange }: VerbooPetProps) {
  const { t } = useI18n()
  const [rendered, setRendered] = useState(visible)
  const [waking, setWaking] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [position, setPosition] = useState<Position>(() => readPosition())
  const rootRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<{
    pointerId: number
    mode: 'move' | 'resize'
    startX: number
    startY: number
    origin: Position
    originSize: number
  } | null>(null)
  const leaveTimer = useRef<number>(undefined)

  useEffect(() => {
    if (visible) {
      window.clearTimeout(leaveTimer.current)
      setRendered(true)
      setLeaving(false)
      setWaking(true)
      const timer = window.setTimeout(() => setWaking(false), 700)
      return () => window.clearTimeout(timer)
    }
    if (!rendered) return
    setLeaving(true)
    leaveTimer.current = window.setTimeout(() => {
      setRendered(false)
      setLeaving(false)
    }, 420)
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function clampOnResize() {
      setPosition(current => clampPosition(current, size))
    }
    window.addEventListener('resize', clampOnResize)
    return () => window.removeEventListener('resize', clampOnResize)
  }, [size])

  if (!rendered) return null

  function beginGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    rootRef.current?.setPointerCapture(event.pointerId)
    gesture.current = {
      pointerId: event.pointerId,
      // Alt+drag resizes from the pet itself; a plain drag moves it.
      mode: event.altKey ? 'resize' : 'move',
      startX: event.clientX,
      startY: event.clientY,
      origin: position,
      originSize: size,
    }
  }

  function moveGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current
    if (!active || active.pointerId !== event.pointerId) return
    if (active.mode === 'resize') {
      const delta = Math.max(event.clientX - active.startX, event.clientY - active.startY)
      onSizeChange(Math.round(clamp(active.originSize + delta, PET_MIN_SIZE, PET_MAX_SIZE)))
      return
    }
    const next = clampPosition({
      x: active.origin.x + event.clientX - active.startX,
      y: active.origin.y + event.clientY - active.startY,
    }, size)
    setPosition(next)
  }

  function endGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId !== event.pointerId) return
    if (gesture.current.mode === 'move') persistPosition(position)
    gesture.current = null
  }

  return (
    <div
      ref={rootRef}
      className={`verboo-pet ${waking ? 'is-waking' : ''} ${leaving ? 'is-leaving' : ''}`}
      data-state={state}
      style={{ left: position.x, top: position.y, '--pet-size': `${size}px` } as React.CSSProperties}
      title={t('pet.hint')}
      onPointerDown={beginGesture}
      onPointerMove={moveGesture}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      {/* Ambient motion lives above the rig, while the body, face and props
          remain independently addressable inside the SVG. */}
      <div className="pet-float">
        <div className="pet-sway">
          <div className="pet-body">
            <VerbooPetRig label={t('pet.title')} />
          </div>
        </div>
      </div>
      <div className="pet-shadow" aria-hidden="true" />
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clampPosition(position: Position, size: number): Position {
  return {
    x: clamp(position.x, 8, Math.max(8, window.innerWidth - size - 8)),
    y: clamp(position.y, 60, Math.max(60, window.innerHeight - size - 40)),
  }
}

function readPosition(): Position {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(POSITION_KEY) ?? '') as Partial<Position>
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed as Position
  } catch {
    // first run
  }
  return { x: 26, y: Math.max(120, window.innerHeight - 240) }
}

function persistPosition(position: Position) {
  try {
    window.localStorage.setItem(POSITION_KEY, JSON.stringify(position))
  } catch {
    // localStorage unavailable
  }
}
