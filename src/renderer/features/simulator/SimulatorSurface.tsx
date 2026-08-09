import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Hand, MousePointer2, Scan } from 'lucide-react'
import type { AttachmentMeta } from '../../../shared/types'
import type {
  IosSimulatorAccessibilityNode,
  IosSimulatorAnnotationCapture,
  IosSimulatorElementHit,
  IosSimulatorKey,
  IosSimulatorPoint,
  IosSimulatorPresenceEvent,
  IosSimulatorRect,
} from './iosSimulatorApi'
import {
  clientPointToNormalized,
  normalizedRectToCss,
  paintedContainRect,
  type Rect,
} from './simulatorGeometry'
import { createSimulatorAnnotationAttachment } from './simulatorAnnotations'
import { SimulatorPresenceOverlay } from './SimulatorPresenceOverlay'
import {
  useSimulatorInteraction,
  type SimulatorInteractionMode,
} from './useSimulatorInteraction'

type Labels = {
  interact: string
  selectElement: string
  selectArea: string
  interaction: string
  keyboardHint: string
  unavailable: string
  note: string
  notePlaceholder: string
  addToChat: string
  cancel: string
  capturing: string
  selectionTooSmall: string
  elementUnavailable: string
  agentActive: string
  agentBadge: string
}

type SimulatorSurfaceProps = {
  frameDataUrl?: string
  streamUrl?: string
  deviceName: string
  previewAlt: string
  mode: SimulatorInteractionMode
  interactive: boolean
  labels: Labels
  onModeChange: (mode: SimulatorInteractionMode) => void
  onTap: (point: IosSimulatorPoint) => void
  onDrag: (from: IosSimulatorPoint, to: IosSimulatorPoint, durationMs: number) => void
  onTypeText: (text: string) => void
  onPressKey: (key: IosSimulatorKey) => void
  onInspectPoint: (point: IosSimulatorPoint) => Promise<IosSimulatorElementHit | undefined>
  onCaptureAnnotation: (
    kind: 'element' | 'area',
    rect: IosSimulatorRect,
    element?: IosSimulatorAccessibilityNode | null,
  ) => Promise<IosSimulatorAnnotationCapture | undefined>
  onDeleteCapture: (paths: string[]) => Promise<void>
  onAddAnnotation: (attachment: AttachmentMeta) => void
  agentPresence?: IosSimulatorPresenceEvent
}

type AreaPointer = { pointerId: number; start: IosSimulatorPoint }
type PendingCapture = {
  kind: 'element' | 'area'
  capture: IosSimulatorAnnotationCapture
}

const ELEMENT_INSPECTION_INTERVAL_MS = 100

export function SimulatorSurface({
  frameDataUrl,
  streamUrl,
  deviceName,
  previewAlt,
  mode,
  interactive,
  labels,
  onModeChange,
  onTap,
  onDrag,
  onTypeText,
  onPressKey,
  onInspectPoint,
  onCaptureAnnotation,
  onDeleteCapture,
  onAddAnnotation,
  agentPresence,
}: SimulatorSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const areaPointerRef = useRef<AreaPointer | null>(null)
  const modeRef = useRef(mode)
  const inspectionRef = useRef<{
    timer?: number
    inFlight: boolean
    queued?: IosSimulatorPoint
    sequence: number
    lastStartedAt: number
  }>({ inFlight: false, sequence: 0, lastStartedAt: 0 })
  const hintId = useId()
  const [selectionRect, setSelectionRect] = useState<IosSimulatorRect | undefined>()
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | undefined>()
  const [note, setNote] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [selectionError, setSelectionError] = useState<string | undefined>()
  const [hoveredElement, setHoveredElement] = useState<IosSimulatorElementHit | undefined>()
  const [failedStreamUrl, setFailedStreamUrl] = useState<string | undefined>()
  const paintedRectRef = useRef<Rect>({ x: 0, y: 0, width: 0, height: 0 })
  const [stablePaintedRect, setStablePaintedRect] = useState<Rect>(paintedRectRef.current)
  const interactionHandlers = useSimulatorInteraction({
    surfaceRef,
    imageRef,
    mode,
    interactive,
    onTap,
    onDrag,
    onTypeText,
    onPressKey,
  })
  const previewSource = streamUrl && streamUrl !== failedStreamUrl ? streamUrl : frameDataUrl

  useEffect(() => {
    setFailedStreamUrl(undefined)
  }, [streamUrl])

  const updatePaintedRect = useCallback(() => {
    const next = paintedSurfaceRect(surfaceRef.current, imageRef.current)
    if (next.width <= 0 || next.height <= 0 || sameRect(paintedRectRef.current, next)) return
    paintedRectRef.current = next
    setStablePaintedRect(next)
  }, [])

  useEffect(() => {
    updatePaintedRect()
    const surface = surfaceRef.current
    if (!surface) return undefined
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updatePaintedRect)
      observer.observe(surface)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', updatePaintedRect)
    return () => window.removeEventListener('resize', updatePaintedRect)
  }, [updatePaintedRect])

  useEffect(() => {
    modeRef.current = mode
    inspectionRef.current.sequence += 1
    inspectionRef.current.queued = undefined
    if (inspectionRef.current.timer !== undefined) {
      window.clearTimeout(inspectionRef.current.timer)
      inspectionRef.current.timer = undefined
    }
    setSelectionRect(undefined)
    setSelectionError(undefined)
    setHoveredElement(undefined)
    areaPointerRef.current = null
  }, [mode])

  useEffect(() => () => {
    inspectionRef.current.sequence += 1
    if (inspectionRef.current.timer !== undefined) {
      window.clearTimeout(inspectionRef.current.timer)
    }
  }, [])

  const modes: Array<{ value: SimulatorInteractionMode; label: string; icon: React.ReactNode }> = [
    { value: 'interact', label: labels.interact, icon: <Hand size={13} aria-hidden="true" /> },
    { value: 'select-element', label: labels.selectElement, icon: <MousePointer2 size={13} aria-hidden="true" /> },
    { value: 'select-area', label: labels.selectArea, icon: <Scan size={13} aria-hidden="true" /> },
  ]
  const selectionStyle = selectionRect ? normalizedRectToCss(selectionRect, stablePaintedRect) : undefined
  const frameStyle = stablePaintedRect.width > 0 && stablePaintedRect.height > 0
    ? {
        left: stablePaintedRect.x,
        top: stablePaintedRect.y,
        width: stablePaintedRect.width,
        height: stablePaintedRect.height,
      }
    : undefined

  function normalizedAt(clientX: number, clientY: number): IosSimulatorPoint | null {
    const surface = surfaceRef.current
    const image = imageRef.current
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

  async function captureSelection(
    kind: 'element' | 'area',
    rect: IosSimulatorRect,
    element: IosSimulatorAccessibilityNode | null = null,
  ) {
    if (capturing || pendingCapture) return
    setCapturing(true)
    setSelectionError(undefined)
    try {
      const capture = await onCaptureAnnotation(kind, rect, element)
      if (capture) {
        setSelectionRect(capture.rect)
        setPendingCapture({ kind, capture })
        setNote('')
      }
    } finally {
      setCapturing(false)
    }
  }

  function scheduleElementInspection(point: IosSimulatorPoint) {
    const inspection = inspectionRef.current
    inspection.queued = point
    if (inspection.inFlight || inspection.timer !== undefined) return
    const wait = Math.max(
      0,
      ELEMENT_INSPECTION_INTERVAL_MS - (performance.now() - inspection.lastStartedAt),
    )
    inspection.timer = window.setTimeout(() => {
      inspection.timer = undefined
      void runElementInspection()
    }, wait)
  }

  async function runElementInspection() {
    const inspection = inspectionRef.current
    const point = inspection.queued
    if (!point || inspection.inFlight || modeRef.current !== 'select-element') return
    inspection.queued = undefined
    inspection.inFlight = true
    inspection.lastStartedAt = performance.now()
    const sequence = inspection.sequence
    try {
      const hit = await onInspectPoint(point)
      if (sequence !== inspection.sequence || modeRef.current !== 'select-element') return
      setHoveredElement(hit)
      setSelectionRect(hit?.rect)
      setSelectionError(undefined)
    } finally {
      inspection.inFlight = false
      if (inspection.queued && modeRef.current === 'select-element') {
        scheduleElementInspection(inspection.queued)
      }
    }
  }

  async function selectElementAt(point: IosSimulatorPoint) {
    if (capturing || pendingCapture) return
    // Re-inspect the exact click point. The last hover result may belong to a
    // neighbouring control while a newer throttled inspection is still queued.
    const hit = await onInspectPoint(point)
    if (!hit) {
      setSelectionRect(undefined)
      setSelectionError(labels.elementUnavailable)
      return
    }
    setHoveredElement(hit)
    setSelectionRect(hit.rect)
    await captureSelection('element', hit.rect, hit.element)
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    interactionHandlers.onPointerDown(event)
    if (mode === 'select-element' && event.button === 0) {
      const point = normalizedAt(event.clientX, event.clientY)
      if (!point) return
      event.preventDefault()
      void selectElementAt(point)
      return
    }
    if (mode !== 'select-area' || event.button !== 0) return
    const point = normalizedAt(event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    areaPointerRef.current = { pointerId: event.pointerId, start: point }
    setSelectionRect({ x: point.x, y: point.y, width: 0, height: 0 })
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* optional */ }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    interactionHandlers.onPointerMove(event)
    if (pendingCapture) return
    const point = normalizedAt(event.clientX, event.clientY)
    if (!point) return
    if (mode === 'select-element') {
      scheduleElementInspection(point)
      return
    }
    const area = areaPointerRef.current
    if (mode === 'select-area' && area?.pointerId === event.pointerId) {
      event.preventDefault()
      setSelectionRect(rectFromPoints(area.start, point))
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    interactionHandlers.onPointerUp(event)
    if (pendingCapture) return
    const point = normalizedAt(event.clientX, event.clientY)
    if (!point) return
    const area = areaPointerRef.current
    if (mode !== 'select-area' || area?.pointerId !== event.pointerId) return
    areaPointerRef.current = null
    const rect = rectFromPoints(area.start, point)
    if (rect.width < 0.01 || rect.height < 0.01) {
      setSelectionRect(undefined)
      setSelectionError(labels.selectionTooSmall)
      return
    }
    void captureSelection('area', rect)
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    interactionHandlers.onPointerCancel(event)
    if (areaPointerRef.current?.pointerId === event.pointerId) {
      areaPointerRef.current = null
      setSelectionRect(undefined)
    }
  }

  async function cancelCapture() {
    const pending = pendingCapture
    setPendingCapture(undefined)
    setSelectionRect(undefined)
    setNote('')
    if (pending) {
      await onDeleteCapture([pending.capture.cropPath, pending.capture.viewportPath])
    }
  }

  function confirmCapture() {
    if (!pendingCapture) return
    onAddAnnotation(createSimulatorAnnotationAttachment(
      pendingCapture.kind,
      note.trim() || undefined,
      pendingCapture.capture,
    ))
    setPendingCapture(undefined)
    setSelectionRect(undefined)
    setNote('')
    onModeChange('interact')
  }

  return (
    <div className="ios-simulator-surface-shell">
      <div className="ios-simulator-mode-toolbar" role="toolbar" aria-label={deviceName}>
        {modes.map(item => (
          <button
            key={item.value}
            type="button"
            className={mode === item.value ? 'is-active' : ''}
            aria-pressed={mode === item.value}
            disabled={capturing || Boolean(pendingCapture)}
            onClick={() => onModeChange(item.value)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div
        ref={surfaceRef}
        className="ios-simulator-interaction-surface"
        role="application"
        tabIndex={mode === 'interact' && interactive ? 0 : -1}
        aria-label={labels.interaction}
        aria-describedby={hintId}
        aria-busy={capturing}
        data-mode={mode}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={interactionHandlers.onClick}
        onKeyDown={interactionHandlers.onKeyDown}
        onPaste={interactionHandlers.onPaste}
        onCompositionStart={interactionHandlers.onCompositionStart}
        onCompositionEnd={interactionHandlers.onCompositionEnd}
      >
        <img
          ref={imageRef}
          src={previewSource}
          alt={previewAlt}
          draggable={false}
          style={frameStyle}
          onLoad={updatePaintedRect}
          onError={() => {
            if (streamUrl && previewSource === streamUrl) setFailedStreamUrl(streamUrl)
          }}
        />
        <SimulatorPresenceOverlay
          paintedRect={stablePaintedRect}
          presence={agentPresence}
          label={labels.agentActive}
          badgeLabel={labels.agentBadge}
        />
        {selectionStyle && (
          <div className="ios-simulator-selection-outline" style={selectionStyle} aria-hidden="true" />
        )}
        {capturing && <div className="ios-simulator-capturing" role="status">{labels.capturing}</div>}
        {!interactive && mode === 'interact' && (
          <div className="ios-simulator-interaction-unavailable" aria-hidden="true">
            {labels.unavailable}
          </div>
        )}
      </div>
      {selectionError && <p className="ios-simulator-selection-error" role="alert">{selectionError}</p>}
      {pendingCapture && (
        <div className="ios-simulator-annotation-confirm">
          <label>
            <span>{labels.note}</span>
            <textarea
              value={note}
              onChange={event => setNote(event.target.value)}
              placeholder={labels.notePlaceholder}
              aria-label={labels.note}
              maxLength={4_000}
              autoFocus
            />
          </label>
          <div>
            <button type="button" className="ghost-button" onClick={() => { void cancelCapture() }}>
              {labels.cancel}
            </button>
            <button type="button" className="primary-button" onClick={confirmCapture}>
              {labels.addToChat}
            </button>
          </div>
        </div>
      )}
      <p id={hintId} className="ios-simulator-keyboard-hint">{labels.keyboardHint}</p>
    </div>
  )
}

function rectFromPoints(from: IosSimulatorPoint, to: IosSimulatorPoint): IosSimulatorRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  }
}

function paintedSurfaceRect(
  surface: HTMLDivElement | null,
  image: HTMLImageElement | null,
) {
  if (!surface || !image) return { x: 0, y: 0, width: 0, height: 0 }
  const bounds = surface.getBoundingClientRect()
  return paintedContainRect(
    { width: bounds.width, height: bounds.height },
    { width: image.naturalWidth, height: image.naturalHeight },
  )
}

function sameRect(left: Rect, right: Rect) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
}
