import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../../i18n'
import { AnnotationChip, isTruncatedAnnotation } from './AnnotationChip'
import { addAnnotationDraft, draftsForConversation, type AnnotationDrafts } from './annotationDrafts'
import { ANNOTATION_QUOTE_MAX, type Annotation } from '../../../shared/types'

/**
 * AnnotationChip DOM tests — REAL DOM, asserting EXHIBITION.
 *
 *  - plural: "1 annotation" / "2 annotations" on the chip label;
 *  - panel lists quote and comment; an item WITHOUT a comment shows NO
 *    orphaned 'Your comment' label (user veto: no empty chrome);
 *  - pencil edits the comment inline; X removes;
 *  - POSSE: drafts of conversation A rendered while B has its own — B's
 *    quote must NOT reach the screen;
 *  - truncation marker: quote at the cap with empty suffix shows '…'.
 */

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

let seq = 0
function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  seq += 1
  return {
    id: `ann-${seq}`,
    segmentId: 'turn1:text:0',
    quote: `quote-${seq}`,
    prefix: '',
    suffix: '',
    occurrenceIndex: 0,
    comment: null,
    createdAt: 1_700_000_000_000 + seq,
    ...overrides,
  }
}

function renderChip(annotations: Annotation[], onRemove = vi.fn(), onEditComment = vi.fn()) {
  const utils = render(
    <I18nProvider language="en-US">
      <AnnotationChip annotations={annotations} onRemove={onRemove} onEditComment={onEditComment} />
    </I18nProvider>,
  )
  return { ...utils, onRemove, onEditComment }
}

function openPanel() {
  // Click toggles (touch/keyboard path — hover is not available everywhere).
  fireEvent.click(screen.getByRole('button', { name: /annotation/i }))
}

describe('AnnotationChip — chip label', () => {
  it('ONE annotation → singular label reaches the screen', () => {
    renderChip([makeAnnotation()])
    expect(screen.getByRole('button', { name: /annotation/i }).textContent).toContain('1 annotation')
    expect(screen.getByRole('button', { name: /annotation/i }).textContent).not.toContain('annotations')
  })

  it('TWO annotations → plural label reaches the screen', () => {
    renderChip([makeAnnotation(), makeAnnotation()])
    expect(screen.getByRole('button', { name: /annotation/i }).textContent).toContain('2 annotations')
  })

  it('ZERO annotations → nothing rendered (no empty chrome)', () => {
    const { container } = renderChip([])
    expect(container.firstChild).toBeNull()
  })
})

describe('AnnotationChip — panel', () => {
  it('the open panel escapes the composer clipping boundary', () => {
    const { container } = render(
      <I18nProvider language="en-US">
        <div className="composer">
          <AnnotationChip annotations={[makeAnnotation()]} onRemove={() => {}} onEditComment={() => {}} />
        </div>
      </I18nProvider>,
    )
    const composer = container.querySelector('.composer')!

    openPanel()

    const panel = screen.getByRole('dialog', { name: 'Annotations on this chat' })
    expect(composer.contains(panel)).toBe(false)
    expect(panel.parentElement).toBe(document.body)
  })

  it('lists the quote; item WITHOUT comment shows NO orphaned comment label', () => {
    renderChip([makeAnnotation({ quote: 'the chosen excerpt' })])
    openPanel()
    expect(screen.getByText(/the chosen excerpt/)).toBeTruthy()
    expect(screen.getByText('Selected text')).toBeTruthy()
    expect(screen.queryByText('Your comment')).toBeNull()
  })

  it('item WITH comment shows the comment AND its label', () => {
    renderChip([makeAnnotation({ quote: 'excerpt', comment: 'please fix this' })])
    openPanel()
    expect(screen.getByText('Your comment')).toBeTruthy()
    expect(screen.getByText(/please fix this/)).toBeTruthy()
  })

  it('EFEITO: activating the focused chip moves focus to the first panel action', () => {
    renderChip([makeAnnotation({ quote: 'keyboard excerpt' })])
    const chip = screen.getByRole('button', { name: /annotation/i })
    chip.focus()
    expect(document.activeElement).toBe(chip)

    fireEvent.click(chip)

    expect(document.activeElement).toBe(screen.getByTitle('Edit comment'))
  })

  it('CONTRAFACTUAL: hover preview opens the panel without stealing focus from the chip', () => {
    renderChip([makeAnnotation({ quote: 'mouse excerpt' })])
    const chip = screen.getByRole('button', { name: /annotation/i })
    chip.focus()

    fireEvent.mouseEnter(chip.parentElement!)

    expect(screen.getByRole('dialog', { name: 'Annotations on this chat' })).toBeTruthy()
    expect(document.activeElement).toBe(chip)
  })

  it('EFEITO: pointer crosses the chip-panel gap and can click both pencil and X', () => {
    vi.useFakeTimers()
    const onEditComment = vi.fn()
    const onRemove = vi.fn()
    const ann = makeAnnotation({ quote: 'excerpt' })
    renderChip([ann], onRemove, onEditComment)
    const chip = screen.getByRole('button', { name: /annotation/i })
    const wrap = chip.parentElement!
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue({
      top: 600,
      left: 400,
      width: 100,
      height: 24,
      right: 500,
      bottom: 624,
      x: 400,
      y: 600,
      toJSON: () => ({}),
    } as DOMRect)

    fireEvent.mouseEnter(wrap)
    const panel = screen.getByRole('dialog', { name: 'Annotations on this chat' })

    // In the WebView the gap has no related target inside either portaled
    // surface. The panel must survive long enough for the pointer to reach
    // the explicit bridge, and then stay open beyond the grace period.
    fireEvent.mouseLeave(wrap, { relatedTarget: document.body })
    expect(screen.getByRole('dialog', { name: 'Annotations on this chat' })).toBe(panel)
    const bridge = document.querySelector<HTMLElement>('.annotation-chip-hover-bridge')
    expect(bridge).toBeTruthy()
    fireEvent.mouseEnter(bridge!)
    vi.advanceTimersByTime(1_000)
    expect(screen.getByRole('dialog', { name: 'Annotations on this chat' })).toBe(panel)

    fireEvent.mouseLeave(bridge!, { relatedTarget: panel })
    fireEvent.mouseEnter(panel)
    fireEvent.click(screen.getByTitle('Edit comment'))
    const input = screen.getByPlaceholderText('Comment (optional)…')
    fireEvent.change(input, { target: { value: 'reachable edit' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEditComment).toHaveBeenCalledWith(ann.id, 'reachable edit')

    fireEvent.click(screen.getByTitle('Remove annotation'))
    expect(onRemove).toHaveBeenCalledWith(ann.id)
  })

  it('pencil edits the comment inline and Enter saves it', () => {
    const onEditComment = vi.fn()
    const ann = makeAnnotation({ quote: 'excerpt' })
    renderChip([ann], vi.fn(), onEditComment)
    openPanel()
    fireEvent.click(screen.getByTitle('Edit comment'))
    const input = screen.getByPlaceholderText('Comment (optional)…')
    fireEvent.change(input, { target: { value: 'new comment' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEditComment).toHaveBeenCalledWith(ann.id, 'new comment')
  })

  it('saving an EMPTY comment clears it to null', () => {
    const onEditComment = vi.fn()
    const ann = makeAnnotation({ comment: 'old' })
    renderChip([ann], vi.fn(), onEditComment)
    openPanel()
    fireEvent.click(screen.getByTitle('Edit comment'))
    const input = screen.getByPlaceholderText('Comment (optional)…')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEditComment).toHaveBeenCalledWith(ann.id, null)
  })

  it('X removes the annotation', () => {
    const onRemove = vi.fn()
    const ann = makeAnnotation()
    renderChip([ann], onRemove)
    openPanel()
    fireEvent.click(screen.getByTitle('Remove annotation'))
    expect(onRemove).toHaveBeenCalledWith(ann.id)
  })

  it('renumbered display: three items show 1,2,3 by array position (no stable-id holes)', () => {
    renderChip([makeAnnotation(), makeAnnotation(), makeAnnotation()])
    openPanel()
    const panel = screen.getByRole('dialog', { name: 'Annotations on this chat' })
    const indexes = Array.from(panel.querySelectorAll('.annotation-panel-index')).map(el => el.textContent)
    expect(indexes).toEqual(['1', '2', '3'])
  })
})

describe('AnnotationChip — POSSE (via the store the App uses)', () => {
  it("conversation A's chip shows A's drafts and NOT B's, even though both exist", () => {
    const annA = makeAnnotation({ quote: 'alpha-from-A' })
    const annB = makeAnnotation({ quote: 'beta-from-B' })
    let drafts: AnnotationDrafts = {}
    drafts = addAnnotationDraft(drafts, 'conv-a', annA)
    drafts = addAnnotationDraft(drafts, 'conv-b', annB)

    renderChip(draftsForConversation(drafts, 'conv-a'))
    expect(screen.getByRole('button', { name: /annotation/i }).textContent).toContain('1 annotation')
    openPanel()
    expect(screen.getByText(/alpha-from-A/)).toBeTruthy()
    expect(screen.queryByText(/beta-from-B/)).toBeNull()
  })
})

describe('isTruncatedAnnotation', () => {
  it('quote at the cap with empty suffix → truncated marker on screen', () => {
    const ann = makeAnnotation({ quote: 'x'.repeat(ANNOTATION_QUOTE_MAX), suffix: '' })
    expect(isTruncatedAnnotation(ann)).toBe(true)
    renderChip([ann])
    openPanel()
    // The visible marker is the ellipsis appended to the quote.
    expect(screen.getByText(/…/)).toBeTruthy()
  })

  it('quote at the cap WITH a suffix is NOT marked truncated (declared edge)', () => {
    const ann = makeAnnotation({ quote: 'x'.repeat(ANNOTATION_QUOTE_MAX), suffix: 'more' })
    expect(isTruncatedAnnotation(ann)).toBe(false)
  })
})
