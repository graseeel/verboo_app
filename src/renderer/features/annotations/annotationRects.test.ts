import { describe, expect, it } from 'vitest'

import {
  BALLOON_GAP,
  BALLOON_SIZE,
  collectHighlightRects,
  domRangeForTextOffsets,
  resolveBalloonPosition,
} from './annotationRects'

/**
 * annotationRects pure tests — the two functions that keep the overlay
 * honest:
 *  - domRangeForTextOffsets maps textContent offsets to REAL DOM points
 *    (crossing inline elements like <strong>, where the naive approach
 *    dies). If this maps wrong, the highlight lands on the wrong letters.
 *  - resolveBalloonPosition enforces RULE 2 BY CONSTRUCTION: candidates
 *    that intersect ANY selection rect are rejected in order, so the
 *    balloon can never eat a letter of the annotated text.
 */

const VIEWPORT = { width: 1024, height: 768 }

describe('domRangeForTextOffsets', () => {
  function segment(html: string): Element {
    const el = document.createElement('div')
    el.innerHTML = html
    return el
  }

  it('single text node → range on that node with the exact offsets', () => {
    const el = segment('alpha beta gamma')
    const range = domRangeForTextOffsets(el, 6, 10)!
    expect(range).not.toBeNull()
    expect(range.toString()).toBe('beta')
    expect(range.startContainer.nodeType).toBe(Node.TEXT_NODE)
    expect(range.startOffset).toBe(6)
    expect(range.endOffset).toBe(10)
  })

  it('CROSSING an inline element: offsets into <strong> map to the NESTED text node', () => {
    const el = segment('alpha <strong>be</strong>ta gamma')
    // textContent = 'alpha beta gamma' — 'beta' starts at 6, INSIDE the
    // strong's text node ('be' = offsets 6..8 of textContent, 0..2 local).
    const range = domRangeForTextOffsets(el, 6, 8)!
    expect(range.toString()).toBe('be')
    const strong = el.querySelector('strong')!
    expect(range.startContainer).toBe(strong.firstChild)
    expect(range.startOffset).toBe(0)
    expect(range.endOffset).toBe(2)
  })

  it('range SPANNING from before the element into it (start in one node, end in another)', () => {
    const el = segment('alpha <strong>be</strong>ta gamma')
    // 'a be': offsets 4..8 → starts in the first text node, ends inside <strong>.
    const range = domRangeForTextOffsets(el, 4, 8)!
    expect(range.toString()).toBe('a be')
    const strong = el.querySelector('strong')!
    expect(range.endContainer).toBe(strong.firstChild)
  })

  it('end at EXACTLY the total length is valid (boundary inclusive)', () => {
    const el = segment('alpha beta')
    const range = domRangeForTextOffsets(el, 0, 10)!
    expect(range.toString()).toBe('alpha beta')
  })

  it('start == end → null (no empty highlight)', () => {
    const el = segment('alpha')
    expect(domRangeForTextOffsets(el, 3, 3)).toBeNull()
  })

  it('end BEYOND the total length → null (degrade, never throw)', () => {
    const el = segment('alpha')
    expect(domRangeForTextOffsets(el, 0, 99)).toBeNull()
  })
})

describe('collectHighlightRects', () => {
  it('maps DOMRects to plain rects and DROPS zero-area fragments', () => {
    const range = document.createRange()
    range.getClientRects = () => {
      const rects = [
        { top: 1, left: 2, width: 30, height: 10 },
        { top: 0, left: 0, width: 0, height: 0 },
      ].map(r => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}) }))
      const list = rects as unknown as DOMRect[] & { item: (i: number) => DOMRect | null }
      list.item = i => list[i] ?? null
      return list as unknown as DOMRectList
    }
    expect(collectHighlightRects(range)).toEqual([{ top: 1, left: 2, width: 30, height: 10 }])
  })
})

describe('resolveBalloonPosition — RULE 2 by construction', () => {
  const last = { top: 120, left: 16, width: 300, height: 20 }

  function intersects(a: { top: number; left: number; width: number; height: number }, b: typeof last): boolean {
    return !(a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top)
  }

  it('normal case: AFTER the end of the last rect, with a gap, vertically centered', () => {
    const pos = resolveBalloonPosition({ selectionRects: [last], viewport: VIEWPORT })
    expect(pos.placement).toBe('after-end')
    expect(pos.left).toBe(last.left + last.width + BALLOON_GAP)
    expect(pos.top).toBe(last.top + last.height / 2 - BALLOON_SIZE / 2)
    const balloon = { top: pos.top, left: pos.left, width: BALLOON_SIZE, height: BALLOON_SIZE }
    expect(intersects(balloon, last)).toBe(false)
  })

  it('CONTRAFACTUAL (the Codex bug): a balloon CENTERED ON the end WOULD eat letters; ours never intersects', () => {
    // The reference bug: 'alvo.' → 'alv1' — balloon overlapping the last chars.
    const naive = { top: last.top, left: last.left + last.width - BALLOON_SIZE / 2, width: BALLOON_SIZE, height: BALLOON_SIZE }
    expect(intersects(naive, last)).toBe(true) // the bug, proven possible

    const pos = resolveBalloonPosition({ selectionRects: [last], viewport: VIEWPORT })
    const ours = { top: pos.top, left: pos.left, width: BALLOON_SIZE, height: BALLOON_SIZE }
    expect(intersects(ours, last)).toBe(false) // ours, proven clean
  })

  it('tight right edge → falls back ABOVE the end, still intersecting NOTHING (multi-line)', () => {
    const line1 = { top: 100, left: 16, width: 900, height: 20 }
    const line2EndAtEdge = { top: 120, left: 700, width: 316, height: 20 } // right = 1016, no room after
    const pos = resolveBalloonPosition({ selectionRects: [line1, line2EndAtEdge], viewport: VIEWPORT })
    expect(pos.placement).toBe('above-end')
    const balloon = { top: pos.top, left: pos.left, width: BALLOON_SIZE, height: BALLOON_SIZE }
    expect(intersects(balloon, line1)).toBe(false)
    expect(intersects(balloon, line2EndAtEdge)).toBe(false)
  })

  it('pathological: text covering every candidate → clamped, returns without throwing (declared limit)', () => {
    const wall = { top: 0, left: 0, width: 1024, height: 768 }
    const pos = resolveBalloonPosition({ selectionRects: [wall], viewport: VIEWPORT })
    expect(pos.placement).toBe('clamped')
    expect(Number.isFinite(pos.top)).toBe(true)
    expect(Number.isFinite(pos.left)).toBe(true)
  })
})
