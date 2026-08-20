import { useEffect, useRef } from 'react'
import type { IosSimulatorPoint } from './iosSimulatorApi'
import type { Rect } from './simulatorGeometry'

/** Platform-neutral presence shape (PA-27): the iOS and Android presence
 *  events share this structure (contract §Eventos — "shape idêntico ao iOS");
 *  `action` stays a plain string so an iOS-side union refactor cannot drift
 *  the Android contract. */
export type SimulatorPresence = {
  generation: number
  phase: 'start' | 'clear'
  action?: string | null
  target?: IosSimulatorPoint | null
  start?: IosSimulatorPoint | null
  end?: IosSimulatorPoint | null
}

type SimulatorPresenceOverlayProps = {
  paintedRect: Rect
  presence?: SimulatorPresence
  reducedMotion?: boolean
  label: string
  badgeLabel: string
}

const DEFAULT_CURSOR_POINT: IosSimulatorPoint = { x: 0.5, y: 0.5 }

export function SimulatorPresenceOverlay({
  paintedRect,
  presence,
  reducedMotion = prefersReducedMotion(),
  label,
  badgeLabel,
}: SimulatorPresenceOverlayProps) {
  const cursorRef = useRef<HTMLDivElement | null>(null)
  const animationRef = useRef<Animation | null>(null)
  const previousPointRef = useRef<IosSimulatorPoint>(DEFAULT_CURSOR_POINT)
  const visible = presence?.phase === 'start' && paintedRect.width > 0 && paintedRect.height > 0
  const point = presence
    ? clampPoint(presence.target ?? presence.end ?? presence.start ?? DEFAULT_CURSOR_POINT)
    : DEFAULT_CURSOR_POINT
  const dragStart = presence?.action === 'drag' && presence.start ? clampPoint(presence.start) : undefined
  const dragEnd = presence?.action === 'drag' && presence.end ? clampPoint(presence.end) : undefined

  useEffect(() => {
    animationRef.current?.cancel()
    animationRef.current = null
    if (!visible) return

    const cursor = cursorRef.current
    const previous = previousPointRef.current
    previousPointRef.current = point
    if (!cursor || reducedMotion || typeof cursor.animate !== 'function') {
      if (cursor) cursor.style.transform = 'translate3d(0, 0, 0)'
      return
    }

    const deltaX = (previous.x - point.x) * paintedRect.width
    const deltaY = (previous.y - point.y) * paintedRect.height
    const bend = Math.min(44, Math.max(12, Math.hypot(deltaX, deltaY) * 0.14))
    animationRef.current = cursor.animate(
      [
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
        { transform: `translate3d(${deltaX * 0.46}px, ${(deltaY * 0.46) - bend}px, 0)`, offset: 0.55 },
        { transform: 'translate3d(0, 0, 0)' },
      ],
      { duration: 760, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
    )

    return () => {
      animationRef.current?.cancel()
      animationRef.current = null
    }
  }, [paintedRect.height, paintedRect.width, point.x, point.y, presence?.generation, reducedMotion, visible])

  if (!visible || !presence) return null

  const radius = Number(Math.min(24, Math.max(10, paintedRect.width * 0.035)).toFixed(2))
  return (
    <div
      className={`ios-simulator-presence ${reducedMotion ? '' : 'is-animated'}`}
      style={{
        left: paintedRect.x,
        top: paintedRect.y,
        width: paintedRect.width,
        height: paintedRect.height,
        borderRadius: radius,
      }}
      data-testid="simulator-presence-overlay"
      data-generation={presence.generation}
      data-reduced-motion={String(reducedMotion)}
      role="status"
      aria-label={label}
    >
      <div className="ios-simulator-agent-badge" aria-hidden="true">
        <span />
        {badgeLabel}
      </div>
      {dragStart && dragEnd && (
        <svg
          className="ios-simulator-agent-drag"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line
            data-testid="simulator-agent-drag-path"
            x1={`${dragStart.x * 100}%`}
            y1={`${dragStart.y * 100}%`}
            x2={`${dragEnd.x * 100}%`}
            y2={`${dragEnd.y * 100}%`}
          />
        </svg>
      )}
      {presence.action === 'tap' && (
        <span
          className="ios-simulator-agent-ripple"
          style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
          data-testid="simulator-agent-ripple"
        />
      )}
      <div
        ref={cursorRef}
        className={`ios-simulator-agent-cursor ${reducedMotion ? '' : 'is-travelling'}`}
        style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
        data-testid="simulator-agent-cursor"
      >
        <svg width="30" height="30" viewBox="0 0 34 34" aria-hidden="true">
          <path
            fill="#a468ff"
            stroke="#fff"
            strokeWidth="1.25"
            strokeLinejoin="round"
            d="M4.4 3.8 L6.1 26.4 L12.05 20.34 L16.64 29.25 L20.64 27.19 L16.05 18.28 L24.58 17.42 Z"
          />
          <path
            fill="#7f48eb"
            fillOpacity=".52"
            d="M5.25 4.7 L15.98 18.24 L11.94 20.1 L6.25 25.45 Z"
          />
          <path
            fill="none"
            stroke="#fff"
            strokeOpacity=".5"
            strokeWidth="1"
            strokeLinecap="round"
            d="M7.1 7.1 L7.9 20.2"
          />
        </svg>
      </div>
    </div>
  )
}

function clampPoint(point: IosSimulatorPoint): IosSimulatorPoint {
  return {
    x: Math.min(1, Math.max(0, point.x)),
    y: Math.min(1, Math.max(0, point.y)),
  }
}

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
