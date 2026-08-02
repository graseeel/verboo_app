import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AnnotationChip } from './AnnotationChip'
import { I18nProvider } from '../../i18n'
import type { Annotation } from '../../../shared/types'

/**
 * AnnotationOverlay DOM tests — F2, THE MOST DANGEROUS PHASE (QA).
 *
 * The two rules under test:
 *  RULE 1 — NEVER mutate the DOM inside MarkdownMessage. The overlay draws
 *    rectangles OVER the text from Range rects; the segment's textContent
 *    must stay BYTE-IDENTICAL with and without annotations mounted. That
 *    assertion comes FIRST in this file, by the Maestro's order.
 *  RULE 2 — THE BALLOON MUST NOT EAT LETTERS. In the Codex reference it
 *    overlaps the last characters ('alvo.' → 'alv1'). Ours sits AFTER the
 *    selection end with a gap, and the tests PROVE non-intersection
 *    geometrically instead of claiming it.
 *
 * jsdom has no layout: Range.getClientRects is shimmed module-wide with a
 * mutable rect set, so each test controls "where the text is". What these
 * tests prove is wiring + geometry through the REAL code (resolver → DOM
 * range → rects → styles). Pixel-truth in the three real WebViews is FIELD
 * WORK, declared as pending.
 */

let mockRects: { top: number; left: number; width: number; height: number }[] = []

function setMockRects(rects: typeof mockRects) {
  mockRects = rects
}

if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function () {
    const list = mockRects.map(r => ({
      ...r,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    })) as unknown as DOMRect[] & { item: (i: number) => DOMRect | null }
    list.item = (i: number) => list[i] ?? null
    return list as unknown as DOMRectList
  }
}

import { AnnotationOverlay } from './AnnotationOverlay'
import { BALLOON_GAP, BALLOON_SIZE } from './annotationRects'

afterEach(() => {
  cleanup()
  setMockRects([])
})

const SEGMENT_TEXT = 'alpha beta gamma delta'
let seq = 0
function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  seq += 1
  return {
    id: `ann-${seq}`,
    segmentId: 'turn1:text:0',
    quote: 'beta',
    prefix: 'alpha ',
    suffix: ' gamma delta',
    occurrenceIndex: 0,
    comment: null,
    createdAt: 1_700_000_000_000 + seq,
    ...overrides,
  }
}

function renderWithSegment(annotations: Annotation[], conversationId: string | undefined = 'conv-a') {
  return render(
    <I18nProvider language="en-US">
      <div>
        <div data-annotation-segment="turn1:text:0" data-testid="model-seg">
          {SEGMENT_TEXT}
        </div>
      </div>
      <AnnotationOverlay annotations={annotations} conversationId={conversationId} />
    </I18nProvider>,
  )
}

const DEFAULT_RECT = { top: 100, left: 100, width: 50, height: 20 }

describe('AnnotationOverlay — RULE 1: the segment DOM is never mutated', () => {
  it('BYTE-IDENTICAL: textContent, innerHTML and child count of the segment are unchanged with the overlay mounted', () => {
    // Written FIRST, by order. If this fails, the overlay mutated the DOM.
    const probe = document.createElement('div')
    probe.setAttribute('data-annotation-segment', 'probe:text:0')
    probe.innerHTML = 'alpha <strong>be</strong>ta <code>ga</code>mma'
    document.body.appendChild(probe)
    const before = {
      textContent: probe.textContent,
      innerHTML: probe.innerHTML,
      childNodes: probe.childNodes.length,
    }

    const annotation = makeAnnotation({ segmentId: 'probe:text:0', quote: 'ta ga', prefix: '', suffix: '', occurrenceIndex: 0 })
    setMockRects([DEFAULT_RECT])
    render(
      <I18nProvider language="en-US">
        <AnnotationOverlay annotations={[annotation]} conversationId="conv-a" />
      </I18nProvider>,
    )

    expect(probe.textContent).toBe(before.textContent)
    expect(probe.innerHTML).toBe(before.innerHTML)
    expect(probe.childNodes.length).toBe(before.childNodes)
    // And the overlay does NOT live inside the segment:
    expect(probe.querySelector('.annotation-hl, .annotation-balloon')).toBeNull()
    probe.remove()
  })
})

describe('AnnotationOverlay — effect: highlight + balloon reach the screen', () => {
  it('resolved annotation → one highlight rect per Range rect AND the numbered balloon', () => {
    setMockRects([DEFAULT_RECT])
    renderWithSegment([makeAnnotation()])

    expect(document.querySelectorAll('.annotation-hl')).toHaveLength(1)
    const balloon = document.querySelector('.annotation-balloon')!
    expect(balloon.textContent).toBe('1')
  })

  it('multi-line selection (2 rects) → 2 highlights, balloon anchored on the LAST rect', () => {
    const line1 = { top: 100, left: 16, width: 400, height: 20 }
    const line2 = { top: 120, left: 16, width: 120, height: 20 }
    setMockRects([line1, line2])
    renderWithSegment([makeAnnotation()])

    expect(document.querySelectorAll('.annotation-hl')).toHaveLength(2)
    const balloon = document.querySelector('.annotation-balloon') as HTMLElement
    const top = parseFloat(balloon.style.top)
    const left = parseFloat(balloon.style.left)
    // After the END of the last rect, with a gap — never ON it.
    expect(left).toBe(line2.left + line2.width + BALLOON_GAP)
    expect(top + BALLOON_SIZE).toBeGreaterThan(line2.top)
    expect(top).toBeLessThan(line2.top + line2.height)
  })

  it('RULE 2 geometric proof: the balloon rect does NOT intersect ANY selection rect', () => {
    const rects = [
      { top: 100, left: 16, width: 900, height: 20 },
      { top: 120, left: 16, width: 300, height: 20 },
    ]
    setMockRects(rects)
    renderWithSegment([makeAnnotation()])

    const balloon = document.querySelector('.annotation-balloon') as HTMLElement
    const b = {
      top: parseFloat(balloon.style.top),
      left: parseFloat(balloon.style.left),
      width: BALLOON_SIZE,
      height: BALLOON_SIZE,
    }
    for (const r of rects) {
      const intersects = !(b.left + b.width <= r.left || r.left + r.width <= b.left || b.top + b.height <= r.top || r.top + r.height <= b.top)
      expect(intersects).toBe(false)
    }
  })

  it('the overlay layer is pointer-events:none — it cannot eat clicks or selection (R1-adjacent)', () => {
    setMockRects([DEFAULT_RECT])
    renderWithSegment([makeAnnotation()])
    const layer = document.querySelector('.annotation-overlay') as HTMLElement
    expect(layer.style.pointerEvents).toBe('none')
  })

  it('two annotations → two balloons numbered by ARRAY POSITION (1 and 2)', () => {
    setMockRects([DEFAULT_RECT])
    const a1 = makeAnnotation({ id: 'first' })
    const a2 = makeAnnotation({ id: 'second', quote: 'gamma', prefix: 'alpha beta ', suffix: ' delta' })
    renderWithSegment([a1, a2])
    const balloons = Array.from(document.querySelectorAll('.annotation-balloon')).map(b => b.textContent)
    expect(balloons).toEqual(['1', '2'])
  })
})

describe('AnnotationOverlay — degradation', () => {
  it('anchor that does NOT resolve → ZERO visual, and the annotation STAYS in the list (chip intact)', () => {
    setMockRects([DEFAULT_RECT])
    const orphan = makeAnnotation({ quote: 'text-that-no-longer-exists', prefix: '', suffix: '' })
    render(
      <I18nProvider language="en-US">
        <div>
          <div data-annotation-segment="turn1:text:0">{SEGMENT_TEXT}</div>
        </div>
        <AnnotationOverlay annotations={[orphan]} conversationId="conv-a" />
        <AnnotationChip annotations={[orphan]} onRemove={() => {}} onEditComment={() => {}} />
      </I18nProvider>,
    )

    // Zero visual…
    expect(document.querySelectorAll('.annotation-hl')).toHaveLength(0)
    expect(document.querySelectorAll('.annotation-balloon')).toHaveLength(0)
    expect(document.querySelector('.annotation-overlay')).toBeNull()
    // …but the data was NOT lost with the position:
    expect(screen.getByRole('button', { name: /annotation/i }).textContent).toContain('1 annotation')
  })

  it('segment not in the DOM → zero visual, no throw', () => {
    setMockRects([DEFAULT_RECT])
    const missing = makeAnnotation({ segmentId: 'turn9:text:99' })
    render(
      <I18nProvider language="en-US">
        <AnnotationOverlay annotations={[missing]} conversationId="conv-a" />
      </I18nProvider>,
    )
    expect(document.querySelectorAll('.annotation-hl')).toHaveLength(0)
  })

  it('no conversation → nothing rendered', () => {
    // Inline render: passing undefined through a helper's parameter would
    // trigger the JS default and silently re-enable the overlay (the same
    // trap documented in AnnotationLayer.test.tsx).
    setMockRects([DEFAULT_RECT])
    render(
      <I18nProvider language="en-US">
        <div>
          <div data-annotation-segment="turn1:text:0">{SEGMENT_TEXT}</div>
        </div>
        <AnnotationOverlay annotations={[makeAnnotation()]} conversationId={undefined} />
      </I18nProvider>,
    )
    expect(document.querySelector('.annotation-overlay')).toBeNull()
  })
})

describe('AnnotationOverlay — follows scroll / resize / streaming', () => {
  it('SCROLL: after a scroll event the highlights sit on the NEW rects, not the old ones', () => {
    setMockRects([DEFAULT_RECT])
    renderWithSegment([makeAnnotation()])
    expect((document.querySelector('.annotation-hl') as HTMLElement).style.top).toBe('100px')

    // The text moved (scrolled up 40px): new measurement. fireEvent wraps
    // the dispatch in act() — raw dispatchEvent would leave React's flush
    // pending and the assertion would read the stale frame.
    setMockRects([{ ...DEFAULT_RECT, top: 60 }])
    fireEvent.scroll(document)

    const hl = document.querySelector('.annotation-hl') as HTMLElement
    expect(hl.style.top).toBe('60px')
  })

  it('RESIZE: a window resize re-measures and repositions', () => {
    setMockRects([DEFAULT_RECT])
    renderWithSegment([makeAnnotation()])

    setMockRects([{ ...DEFAULT_RECT, left: 200 }])
    fireEvent(window, new Event('resize'))

    expect((document.querySelector('.annotation-hl') as HTMLElement).style.left).toBe('200px')
  })

  it('N1: a STREAMING re-render of the segment keeps the balloon ALIVE and does NOT duplicate it', async () => {
    setMockRects([DEFAULT_RECT])
    const annotation = makeAnnotation()
    const { rerender } = render(
      <I18nProvider language="en-US">
        <div>
          <div data-annotation-segment="turn1:text:0">alpha beta</div>
        </div>
        <AnnotationOverlay annotations={[annotation]} conversationId="conv-a" />
      </I18nProvider>,
    )
    expect(document.querySelectorAll('.annotation-balloon')).toHaveLength(1)

    // Streaming: the segment GROWS (quote still present). MutationObserver
    // must recompute; React must reconcile by annotation id — never append.
    rerender(
      <I18nProvider language="en-US">
        <div>
          <div data-annotation-segment="turn1:text:0">alpha beta gamma delta epsilon</div>
        </div>
        <AnnotationOverlay annotations={[annotation]} conversationId="conv-a" />
      </I18nProvider>,
    )
    await new Promise(resolve => setTimeout(resolve, 0)) // flush MutationObserver microtasks

    expect(document.querySelectorAll('.annotation-balloon')).toHaveLength(1)
    expect(document.querySelectorAll('.annotation-hl').length).toBeGreaterThan(0)
    // And the balloon is still THIS annotation's, at index 1:
    expect(document.querySelector('.annotation-balloon')!.textContent).toBe('1')
  })

  it('N1 counterpart: streaming that REMOVES the quote degrades to zero visual (and nothing crashes)', async () => {
    setMockRects([DEFAULT_RECT])
    const annotation = makeAnnotation()
    const { rerender } = render(
      <I18nProvider language="en-US">
        <div>
          <div data-annotation-segment="turn1:text:0">alpha beta</div>
        </div>
        <AnnotationOverlay annotations={[annotation]} conversationId="conv-a" />
      </I18nProvider>,
    )
    expect(document.querySelectorAll('.annotation-balloon')).toHaveLength(1)

    rerender(
      <I18nProvider language="en-US">
        <div>
          <div data-annotation-segment="turn1:text:0">completely rewritten</div>
        </div>
        <AnnotationOverlay annotations={[annotation]} conversationId="conv-a" />
      </I18nProvider>,
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(document.querySelectorAll('.annotation-balloon')).toHaveLength(0)
    expect(document.querySelector('.annotation-overlay')).toBeNull()
  })
})

describe('AnnotationOverlay — reduced motion', () => {
  it('prefers-reduced-motion → NO entrance class (instant, per the app-wide contract)', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
    try {
      setMockRects([DEFAULT_RECT])
      renderWithSegment([makeAnnotation()])
      expect(document.querySelectorAll('.annotation-hl-enter')).toHaveLength(0)
    } finally {
      window.matchMedia = original
    }
  })

  it('normal motion → entrance class present (declares the fade exists)', () => {
    setMockRects([DEFAULT_RECT])
    renderWithSegment([makeAnnotation()])
    expect(document.querySelectorAll('.annotation-hl-enter').length).toBeGreaterThan(0)
  })
})
