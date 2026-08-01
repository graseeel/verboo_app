import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { ListChecks, PanelBottom, PanelRight } from 'lucide-react'
import type { TodoItem } from '../../../shared/types'
import { useI18n } from '../../i18n'
import {
  CHECKLIST_CARD_WIDTH,
  clampCardPosition,
  checklistCardHome,
  resolveCardDrop,
  type ChecklistCardPos,
  type ChecklistViewport,
} from './checklistPlacement'

/**
 * ChecklistPanel — the TodoWrite task list, ONE component with TWO
 * forms (approved in PROTOTYPE-checklist-b-v3.html):
 *
 *   - floating: compact mini-modal card (fixed width, height of its
 *     content), top-right, draggable vertically along the right strip,
 *     full list + hairline progress. Descola por SOMBRA+BORDA — nunca
 *     translucidez sobre texto.
 *   - docked: condensed window of 3 rows (last done / current / next),
 *     fraction riding the current row, NO header, NO border — quieter
 *     than the goal panel, which keeps the border (hierarquia aprovada:
 *     goal-com-borda > lista-sem-borda). Collapses to a single row when
 *     every item is completed.
 *
 * USER RULES baked in here:
 *   1. The card NEVER rests over the transcript. During the drag it
 *      follows the pointer anywhere (fluid feedback); on release it
 *      glides back to the right strip BY ITSELF (resolveCardDrop
 *      computes the target — x always returns to the strip, y survives
 *      clamped, magnetic snap near the home corner).
 *   2. The USER chooses the form; the toggle rides the card header /
 *      the current docked row and the preference is persisted by the
 *      parent (it survives conversation switches and app restarts).
 *
 * MULTIPLATFORM BY CONSTRUCTION (no local gate covers the WebView):
 *   - The viewport — INCLUDING the OS scrollbar lane — is measured at
 *     runtime (window.innerWidth − documentElement.clientWidth), never
 *     assumed: on Windows the scrollbar occupies layout space, on
 *     macOS it overlays. See the `measureViewport` default below.
 *   - Row heights are line-height units (em) in checklist.css, NOT
 *     pixels — font metrics differ across platforms and what fits on
 *     one overflows on another.
 *   - Drag uses Pointer Events with setPointerCapture + touch-action,
 *     not mouse events — works on touch and on Linux environments
 *     where mouse-event sequencing differs.
 *   - Persisted positions are re-clamped INTO BOUNDS on restore and on
 *     every resize — a position saved on a large monitor is off-screen
 *     on a smaller one.
 */

export type ChecklistPanelProps = {
  todos: TodoItem[]
  form: 'floating' | 'docked'
  /** Persisted resting position; null = home corner. Floating only. */
  cardPos: ChecklistCardPos | null
  onCardPosChange: (pos: ChecklistCardPos) => void
  onToggleForm: () => void
  /** FLIP flight: fixed geometry + zIndex while migrating between
   *  forms (computed by useChecklistFlight). */
  flightStyle?: CSSProperties
  flying?: boolean
  /** The flight hook registers the root element to measure it across
   *  remounts (the element moves between the aux-stack and a portal). */
  registerElement?: (el: HTMLDivElement | null) => void
  /** Entrance animation — first appearance only (never on remounts
   *  from a form switch, that would be motion noise). */
  entering?: boolean
  /** Injectable for tests; defaults to the live window measurement. */
  measureViewport?: () => ChecklistViewport
  /** Injectable for tests; defaults to the live matchMedia query. */
  prefersReducedMotion?: () => boolean
}

type DragState = {
  pointerId: number
  startClientX: number
  startClientY: number
  startPos: ChecklistCardPos
  candidate: ChecklistCardPos
}

/** Estimated card height when the element reports 0 (jsdom in tests,
 *  or a pre-paint measurement). Real renders measure offsetHeight. */
function estimateCardHeight(itemCount: number): number {
  return 46 + itemCount * 22
}

function liveViewport(): ChecklistViewport {
  const clientWidth = document.documentElement?.clientWidth ?? window.innerWidth
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollbarWidth: Math.max(0, window.innerWidth - clientWidth),
  }
}

function livePrefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

export function ChecklistPanel(props: ChecklistPanelProps) {
  const { todos, form } = props
  const { t } = useI18n()
  const measureViewport = props.measureViewport ?? liveViewport
  const reduced = (props.prefersReducedMotion ?? livePrefersReducedMotion)()

  const rootRef = useRef<HTMLDivElement | null>(null)
  const setRootEl = (el: HTMLDivElement | null) => {
    rootRef.current = el
    props.registerElement?.(el)
  }
  const [drag, setDrag] = useState<DragState | null>(null)
  const [gliding, setGliding] = useState(false)
  const glideTimer = useRef<number | undefined>(undefined)

  const doneCount = todos.filter(item => item.status === 'completed').length
  const total = todos.length
  const allDone = total > 0 && doneCount === total
  const firstOpenIndex = todos.findIndex(item => item.status !== 'completed')

  /* Settled checks: items ALREADY completed when they first render do
   * NOT replay the draw animation (anti motion-noise, approved in the
   * prototype). A completion that happens live draws once, then joins
   * the settled set. Identity = content (TodoWrite lists are small and
   * contents are unique by CLI convention). */
  const settledRef = useRef<Set<string> | undefined>(undefined)
  if (settledRef.current === undefined) {
    settledRef.current = new Set(todos.filter(i => i.status === 'completed').map(i => i.content))
  }
  useEffect(() => {
    const settled = settledRef.current!
    for (const item of todos) {
      if (item.status === 'completed') settled.add(item.content)
    }
  }, [todos])

  const cardSize = () => ({
    width: CHECKLIST_CARD_WIDTH,
    height: rootRef.current?.offsetHeight || estimateCardHeight(total),
  })

  /* Restore/resize containment (multiplatform rule): a persisted
   * position is valid only INSIDE the current window. Runs on mount
   * and on every resize while floating. */
  useLayoutEffect(() => {
    if (form !== 'floating') return
    const contain = () => {
      if (!props.cardPos) return
      const clamped = clampCardPosition(props.cardPos, measureViewport(), cardSize())
      if (clamped.x !== props.cardPos.x || clamped.y !== props.cardPos.y) {
        props.onCardPosChange(clamped)
      }
    }
    contain()
    window.addEventListener('resize', contain)
    return () => window.removeEventListener('resize', contain)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, props.cardPos])

  useEffect(() => () => window.clearTimeout(glideTimer.current), [])

  /* ── Drag (floating only) ─────────────────────────────────────── */
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (form !== 'floating' || props.flying) return
    // Buttons inside the card (form toggle) are not drag handles.
    if ((event.target as HTMLElement).closest('button')) return
    const viewport = measureViewport()
    const startPos = props.cardPos ?? checklistCardHome(viewport)
    const state: DragState = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPos,
      candidate: startPos,
    }
    try {
      rootRef.current?.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointerIds in tests have no capture — drag still works.
    }
    setDrag(state)
    event.preventDefault()
  }

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const candidate = clampCardPosition(
      {
        x: drag.startPos.x + event.clientX - drag.startClientX,
        y: drag.startPos.y + event.clientY - drag.startClientY,
      },
      measureViewport(),
      cardSize(),
    )
    setDrag({ ...drag, candidate })
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const dropped = drag.candidate
    setDrag(null)
    const resolved = resolveCardDrop(dropped, measureViewport(), cardSize())
    if (reduced) {
      props.onCardPosChange(resolved)
      return
    }
    // "Volta sozinho e de forma FLUIDA": keep rendering during a short
    // left/top transition from the drop point to the resolved strip
    // position. The glide class carries the transition in CSS.
    setGliding(true)
    props.onCardPosChange(resolved)
    glideTimer.current = window.setTimeout(() => setGliding(false), 240)
  }

  /* ── Geometry actually rendered ───────────────────────────────── */
  const viewport = form === 'floating' ? measureViewport() : null
  const restingPos = props.cardPos ?? (viewport ? checklistCardHome(viewport) : null)
  const displayPos = drag?.candidate ?? restingPos

  const floatingStyle: CSSProperties | undefined =
    form === 'floating' && viewport && restingPos && displayPos
      ? {
          position: 'fixed',
          left: displayPos.x,
          top: displayPos.y,
          width: CHECKLIST_CARD_WIDTH,
          // During a FLIP flight the hook dictates the full geometry.
          ...(props.flightStyle ?? {}),
        }
      : props.flightStyle

  const rootClass = [
    'checklist-panel',
    form === 'floating' ? 'floating' : 'docked',
    drag ? 'is-dragging' : '',
    gliding ? 'is-gliding' : '',
    props.flying ? 'flying' : '',
    props.entering && !reduced ? 'checklist-enter' : '',
  ]
    .filter(Boolean)
    .join(' ')

  /* ── Rows ─────────────────────────────────────────────────────── */
  const rowText = (item: TodoItem) =>
    item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content

  const renderRow = (item: TodoItem | null, modifier: string, key: string, withFraction: boolean) => {
    const settled = item ? settledRef.current!.has(item.content) : true
    return (
      <div className={`checklist-row ${modifier}`} key={key}>
        <svg
          className={`checklist-check ${settled ? 'settled' : ''}`}
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="5.5" />
          <path d="M4.4 7.2l1.8 1.8 3.4-3.8" />
        </svg>
        <span className="checklist-row-text">{item ? rowText(item) : t('checklist.allDone')}</span>
        {withFraction && (
          <span className="checklist-frac">
            {doneCount}/{total}
          </span>
        )}
        {withFraction && form === 'docked' && (
          <button
            type="button"
            className="checklist-toggle"
            title={t('checklist.float')}
            aria-label={t('checklist.float')}
            onClick={props.onToggleForm}
          >
            <PanelRight size={13} strokeWidth={1.8} />
          </button>
        )}
      </div>
    )
  }

  const dockedRows = () => {
    if (allDone) return [renderRow(null, 'done-all is-done', 'done-all', true)]
    const indices = [firstOpenIndex - 1, firstOpenIndex, firstOpenIndex + 1].filter(
      i => i >= 0 && i < total,
    )
    return indices.map(i => {
      const item = todos[i]
      const modifier =
        i < firstOpenIndex ? 'is-done' : item.status === 'in_progress' ? 'is-current' : 'is-next'
      return renderRow(item, modifier, `row-${i}`, i === firstOpenIndex)
    })
  }

  const progressLabel = t('checklist.progress', { done: doneCount, total })

  return (
    <div
      ref={setRootEl}
      className={rootClass}
      style={floatingStyle}
      role="region"
      aria-label={t('checklist.regionLabel')}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {form === 'floating' ? (
        <div className="checklist-card-box">
          <div className="checklist-card-head">
            <ListChecks size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>{t('checklist.regionLabel')}</span>
            <span className="checklist-card-frac">
              {doneCount}/{total}
            </span>
            <button
              type="button"
              className="checklist-toggle"
              title={t('checklist.dock')}
              aria-label={t('checklist.dock')}
              onClick={props.onToggleForm}
            >
              <PanelBottom size={13} strokeWidth={1.8} />
            </button>
          </div>
          <div
            className="checklist-card-bar"
            role="progressbar"
            aria-label={progressLabel}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={doneCount}
          >
            <div style={{ width: `${total === 0 ? 0 : (doneCount / total) * 100}%` }} />
          </div>
          <div className="checklist-card-rows">
            {todos.map((item, i) => {
              const modifier =
                item.status === 'completed'
                  ? 'is-done'
                  : item.status === 'in_progress'
                    ? 'is-current'
                    : 'is-next'
              return renderRow(item, modifier, `card-${i}`, false)
            })}
          </div>
        </div>
      ) : (
        <div className="checklist-docked-box" aria-label={progressLabel}>
          {dockedRows()}
        </div>
      )}
    </div>
  )
}
