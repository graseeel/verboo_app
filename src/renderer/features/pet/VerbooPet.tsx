import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import mascotUrl from '../../../../assets/branding/verboo-mascot.png'
import { useI18n } from '../../i18n'

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
      <div className="pet-float">
        <div className="pet-body">
          <img src={mascotUrl} alt={t('pet.title')} draggable={false} />
        </div>

        {/* thinking: thought bubbles + drifting question mark */}
        <div className="pet-prop pet-prop-think" aria-hidden="true">
          <svg viewBox="0 0 44 40" width="100%" height="100%">
            <circle className="think-dot think-dot-1" cx="8" cy="34" r="2.4" fill="currentColor" />
            <circle className="think-dot think-dot-2" cx="15" cy="26" r="3.4" fill="currentColor" />
            <ellipse className="think-cloud" cx="29" cy="13" rx="13" ry="9.5" fill="currentColor" />
            <text className="think-question" x="29" y="17" textAnchor="middle" fontSize="11" fontWeight="800">?</text>
          </svg>
        </div>

        {/* editing: pencil writing sparks */}
        <div className="pet-prop pet-prop-edit" aria-hidden="true">
          <svg viewBox="0 0 44 44" width="100%" height="100%">
            <g className="edit-pencil">
              <rect x="18" y="6" width="7" height="20" rx="2" fill="currentColor" transform="rotate(38 22 16)" />
              <path d="M13.4 27.5 L18.6 31.6 L11.5 34.4 Z" fill="currentColor" />
            </g>
            <circle className="edit-spark edit-spark-1" cx="9" cy="36" r="1.6" fill="currentColor" />
            <circle className="edit-spark edit-spark-2" cx="16" cy="39" r="1.3" fill="currentColor" />
            <circle className="edit-spark edit-spark-3" cx="23" cy="37" r="1.1" fill="currentColor" />
          </svg>
        </div>

        {/* deleting: trash bin + falling scraps */}
        <div className="pet-prop pet-prop-delete" aria-hidden="true">
          <svg viewBox="0 0 44 44" width="100%" height="100%">
            <g className="delete-bin">
              <rect x="14" y="20" width="16" height="17" rx="2.5" fill="currentColor" />
              <rect className="delete-lid" x="12" y="15" width="20" height="4" rx="2" fill="currentColor" />
            </g>
            <rect className="delete-scrap delete-scrap-1" x="20" y="4" width="4.4" height="4.4" rx="1" fill="currentColor" />
            <rect className="delete-scrap delete-scrap-2" x="26" y="2" width="3.4" height="3.4" rx="1" fill="currentColor" />
          </svg>
        </div>

        {/* command: the mascot sits BEHIND an open laptop (we see the lid's
            back, like someone typing across from us); screen light spills
            over the top edge and code glyphs rise while it types. */}
        <div className="pet-prop pet-prop-laptop" aria-hidden="true">
          <svg viewBox="0 0 72 44" width="100%" height="100%">
            <text className="laptop-glyph laptop-glyph-1" x="15" y="16" textAnchor="middle" fontSize="8" fontWeight="800">{'{ }'}</text>
            <text className="laptop-glyph laptop-glyph-2" x="57" y="13" textAnchor="middle" fontSize="8" fontWeight="800">{'</>'}</text>
            <text className="laptop-glyph laptop-glyph-3" x="36" y="10" textAnchor="middle" fontSize="8" fontWeight="800">{'$_'}</text>
            <rect className="laptop-glow" x="12" y="17.5" width="48" height="5" rx="2.5" />
            <rect className="laptop-lid" x="8" y="20" width="56" height="22" rx="4.5" />
            <circle className="laptop-logo" cx="36" cy="31" r="4.2" />
          </svg>
        </div>

        {/* reading: magnifier sweep */}
        <div className="pet-prop pet-prop-read" aria-hidden="true">
          <svg viewBox="0 0 44 44" width="100%" height="100%">
            <g className="read-lens">
              <circle cx="19" cy="19" r="10" fill="none" stroke="currentColor" strokeWidth="3.4" />
              <line x1="27" y1="27" x2="36" y2="36" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
            </g>
          </svg>
        </div>

        {/* success: check pop */}
        <div className="pet-prop pet-prop-done" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="100%" height="100%">
            <circle cx="16" cy="16" r="13" fill="currentColor" opacity="0.18" />
            <path d="M9.5 16.5 L14 21 L23 11.5" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        {/* error: exclamation */}
        <div className="pet-prop pet-prop-error" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="100%" height="100%">
            <path d="M16 4 L29 27 L3 27 Z" fill="currentColor" opacity="0.2" />
            <line x1="16" y1="12" x2="16" y2="20" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
            <circle cx="16" cy="24" r="1.8" fill="currentColor" />
          </svg>
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
