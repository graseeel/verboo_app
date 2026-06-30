import { useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { SlotText } from 'slot-text/react'
import mascotUrl from '../../../../assets/branding/verboo-mascot.png'

export type PetReaction = 'idle' | 'wake' | 'pet' | 'inspect' | 'thinking' | 'coding' | 'success' | 'error'

type PetSpriteProps = {
  visible: boolean
  reaction: PetReaction
  speech?: string
  promptText?: string
}

type Position = {
  x: number
  y: number
}

const SLOT_TEXT: Record<PetReaction, string> = {
  idle: 'pronto',
  wake: 'oi',
  pet: 'a postos',
  inspect: 'lendo pedido',
  thinking: 'pensando',
  coding: 'codando',
  success: 'feito',
  error: 'ops',
}

export function PetSprite({ visible, reaction, speech, promptText = '' }: PetSpriteProps) {
  const drag = useRef<{
    pointerId: number
    startX: number
    startY: number
    origin: Position
  } | null>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const [rendered, setRendered] = useState(visible)
  const [closing, setClosing] = useState(false)
  const [position, setPosition] = useState<Position>(() => ({
    x: 24,
    y: Math.max(96, window.innerHeight - 176),
  }))

  useEffect(() => {
    if (visible) {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
      setRendered(true)
      setClosing(false)
      return
    }
    if (!rendered) return
    setClosing(true)
    closeTimer.current = window.setTimeout(() => {
      setRendered(false)
      setClosing(false)
    }, 180)
  }, [visible, rendered])

  useEffect(() => {
    function clampOnResize() {
      setPosition(current => clampPosition(current))
    }

    window.addEventListener('resize', clampOnResize)
    return () => {
      window.removeEventListener('resize', clampOnResize)
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    }
  }, [])

  if (!rendered) return null

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: position,
    }
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return
    setPosition(clampPosition({
      x: drag.current.origin.x + event.clientX - drag.current.startX,
      y: drag.current.origin.y + event.clientY - drag.current.startY,
    }))
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) {
      drag.current = null
    }
  }

  return (
    <div
      className={`pet-sprite ${closing || !visible ? 'is-closing' : 'is-open'}`}
      data-reaction={reaction}
      style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
      aria-label="Pet Verboo"
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="pet-stage">
        <img className="pet-body" src={mascotUrl} alt="" draggable={false} />
        <span className="pet-prop pet-prop--magnifier" aria-hidden="true" />
        <span className="pet-prop pet-prop--laptop" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="pet-thought" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="pet-success" aria-hidden="true">
          <svg viewBox="0 0 22 22" fill="none">
            <path d="M5 11.2 9.1 15 17 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="pet-action-lines" aria-hidden="true" />
        <span className="pet-bubble" role="status" aria-live="polite">
          <PetSlotText text={speech || SLOT_TEXT[reaction]} />
          {reaction === 'inspect' && promptText && (
            <small className="pet-scan-text">{shorten(promptText)}</small>
          )}
        </span>
      </div>
    </div>
  )
}

function PetSlotText({ text }: { text: string }) {
  return (
    <SlotText
      className="pet-slot-text"
      text={text}
      options={{ direction: 'up', duration: 180, stagger: 16 }}
    />
  )
}

function clampPosition(position: Position): Position {
  const maxX = Math.max(0, window.innerWidth - 132)
  const maxY = Math.max(0, window.innerHeight - 132)
  return {
    x: Math.min(Math.max(0, position.x), maxX),
    y: Math.min(Math.max(0, position.y), maxY),
  }
}

function shorten(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 34 ? `${compact.slice(0, 31)}...` : compact
}
