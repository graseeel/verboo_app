import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../../i18n'
import { AnnotationLayer } from './AnnotationLayer'
import type { Annotation } from '../../../shared/types'

/**
 * AnnotationLayer DOM tests — REAL DOM (jsdom), asserting EXHIBITION.
 *
 * The selection mechanism: jsdom implements setBaseAndExtent/getRangeAt but
 * does NOT fire selectionchange by itself, so every test ends the gesture
 * with fireEvent.pointerUp(document) — the same event the hook treats as
 * "gesture finished" in the real app.
 *
 * What is proven here (disparo E efeito, com pares contrafactuais):
 *  - efeito: selection inside a MODEL segment → bar in the DOM;
 *  - contrafactual: selection in USER text (no data-annotation-segment) → NO bar;
 *  - contrafactual: same marked segment under data-turn-streaming → NO bar;
 *  - R1: a copy event dispatched with the bar open still propagates and is
 *    NOT defaultPrevented — the hook never touches the copy gesture;
 *  - creation: clicking "Add to chat" delivers an Annotation whose quote is
 *    EXACTLY the selected text (effect, not string assembly);
 *  - POSSE: the annotation carries the conversation of the prop fixed at
 *    render — covered at the store level in annotationDrafts.test.ts; here
 *    we pin that onCreate fires for the rendered conversation only.
 */

afterEach(() => {
  cleanup()
  document.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// jsdom has no layout engine: Range.getBoundingClientRect is not implemented.
// Polyfill a deterministic rect so the hook's position math can run — what
// these tests assert is the bar's EXISTENCE and CONTENT in the DOM, never
// pixel geometry (that is proven in annotationBarPosition.test.ts as a pure
// function). Declared environment shim, not app behavior.
if (typeof Range !== 'undefined' && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 100, left: 100, width: 50, height: 20, right: 150, bottom: 120, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect
}

function renderLayer(onCreate: (a: Annotation) => void, conversationId: string | undefined = 'conv-a') {
  return render(
    <I18nProvider language="en-US">
      <div data-testid="scroll-surface">
        {/* USER message: no mark — must never produce a bar */}
        <p data-testid="user-msg">user typed this request</p>
        {/* MODEL segment: the only annotatable region */}
        <div data-annotation-segment="turn1:text:0" data-testid="model-seg">
          alpha beta gamma delta
        </div>
        <input data-testid="outside-focus" aria-label="Outside the annotation bar" />
      </div>
      <div className="composer" data-testid="composer" />
      <AnnotationLayer conversationId={conversationId} onCreate={onCreate} />
    </I18nProvider>,
  )
}

// NOTE: do NOT pass `undefined` through renderLayer's second parameter — JS
// default parameters trigger on undefined and would silently restore
// 'conv-a'. The no-conversation case renders inline below.

function selectText(node: Node, start: number, end: number) {
  const sel = document.getSelection()!
  sel.setBaseAndExtent(node, start, node, end)
}

function textOf(testId: string): ChildNode {
  const el = screen.getByTestId(testId)
  if (!el.firstChild) throw new Error(`${testId} has no text node`)
  return el.firstChild
}

function openBarThenCollapseSelectionWithFocus(resolveFocusTarget: () => HTMLElement) {
  selectText(textOf('model-seg'), 0, 5)
  fireEvent.pointerUp(document)
  expect(screen.getByRole('dialog', { name: 'Add to chat' })).toBeTruthy()

  const selection = document.getSelection()!
  expect(selection.isCollapsed).toBe(false)

  const focusTarget = resolveFocusTarget()
  focusTarget.focus()
  expect(document.activeElement).toBe(focusTarget)

  // input.focus() in jsdom does not reproduce the real WebView sequence
  // reliably: it does not dispatch the document selectionchange that exposed
  // this field bug. Collapse explicitly and dispatch the browser event;
  // otherwise the regression test never exercises the handler that failed.
  selection.collapseToEnd()
  expect(selection.isCollapsed).toBe(true)
  fireEvent(document, new Event('selectionchange'))
}

function measuredRect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function openBarForCommentGrowth({ selectionTop = 600, composerTop = 650 } = {}) {
  const onCreate = vi.fn()
  let currentComposerTop = composerTop
  let currentViewportHeight = 800
  vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => currentViewportHeight)
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(measuredRect(selectionTop, 100, 50, 20))
  renderLayer(onCreate)
  const composer = screen.getByTestId('composer')
  vi.spyOn(composer, 'getBoundingClientRect').mockImplementation(() => measuredRect(currentComposerTop, 0, 1024, 118))
  selectText(textOf('model-seg'), 0, 5)
  fireEvent.pointerUp(document)

  const bar = screen.getByRole('dialog', { name: 'Add to chat' })
  const comment = screen.getByPlaceholderText('Comment (optional)…') as HTMLTextAreaElement
  const addButton = screen.getByRole('button', { name: 'Add to chat' })
  fireEvent.pointerDown(comment)
  comment.focus()
  fireEvent.pointerUp(document)

  // jsdom does not lay text out and therefore never derives scrollHeight from
  // the value. Model that browser effect explicitly from the only varying
  // input in the pair below: the length of the comment the user typed.
  Object.defineProperty(comment, 'scrollHeight', {
    configurable: true,
    get: () => comment.value.length > 100 ? 800 : 32,
  })
  vi.spyOn(comment, 'getBoundingClientRect').mockImplementation(() => {
    const inlineHeight = Number.parseFloat(comment.style.height)
    return measuredRect(
      Number.parseFloat(bar.style.top) + 10,
      Number.parseFloat(bar.style.left) + 8,
      180,
      Number.isFinite(inlineHeight) ? inlineHeight : 32,
    )
  })
  vi.spyOn(bar, 'getBoundingClientRect').mockImplementation(() => {
    const inlineHeight = Number.parseFloat(comment.style.height)
    const commentHeight = Number.isFinite(inlineHeight) ? inlineHeight : 32
    return measuredRect(Number.parseFloat(bar.style.top), Number.parseFloat(bar.style.left), 300, commentHeight + 20)
  })

  return {
    addButton,
    bar,
    comment,
    composer,
    onCreate,
    setViewportGeometry: (viewportHeight: number, nextComposerTop: number) => {
      currentViewportHeight = viewportHeight
      currentComposerTop = nextComposerTop
    },
  }
}

describe('AnnotationLayer — selection → bar', () => {
  it('EFEITO: selection inside a model segment shows the floating bar', () => {
    renderLayer(() => {})
    selectText(textOf('model-seg'), 0, 5) // "alpha"
    fireEvent.pointerUp(document)
    expect(screen.getByRole('dialog', { name: 'Add to chat' })).toBeTruthy()
  })

  it('CONTRAFACTUAL: selection in a USER message (no mark) shows NO bar', () => {
    renderLayer(() => {})
    selectText(textOf('user-msg'), 0, 4)
    fireEvent.pointerUp(document)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('CONTRAFACTUAL: the SAME marked segment under data-turn-streaming shows NO bar', () => {
    const spy = vi.fn()
    render(
      <I18nProvider language="en-US">
        <div data-turn-streaming="true">
          <div data-annotation-segment="turn9:text:0" data-testid="streaming-seg">
            partial model text
          </div>
        </div>
        <AnnotationLayer conversationId="conv-a" onCreate={spy} />
      </I18nProvider>,
    )
    selectText(textOf('streaming-seg'), 0, 7)
    fireEvent.pointerUp(document)
    // The only variable vs the EFEITO test is the streaming attribute.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('no conversation (undefined) → bar never appears even on a valid segment', () => {
    // Inline render: passing undefined through the helper would trigger the
    // JS default parameter and silently re-enable the layer.
    render(
      <I18nProvider language="en-US">
        <div>
          <div data-annotation-segment="turn1:text:0" data-testid="model-seg">
            alpha beta gamma delta
          </div>
        </div>
        <AnnotationLayer conversationId={undefined} onCreate={() => {}} />
      </I18nProvider>,
    )
    selectText(textOf('model-seg'), 0, 5)
    fireEvent.pointerUp(document)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('R1: copy event with the bar open still propagates and is NOT defaultPrevented', () => {
    renderLayer(() => {})
    selectText(textOf('model-seg'), 0, 5)
    fireEvent.pointerUp(document)
    expect(screen.getByRole('dialog', { name: 'Add to chat' })).toBeTruthy()

    const seen = vi.fn()
    document.addEventListener('copy', seen)
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true })
    document.dispatchEvent(copyEvent)
    document.removeEventListener('copy', seen)

    expect(seen).toHaveBeenCalledTimes(1)
    expect(copyEvent.defaultPrevented).toBe(false)
  })

  it('EFEITO: collapsed document selection with focus INSIDE the bar keeps the bar present', () => {
    renderLayer(() => {})

    openBarThenCollapseSelectionWithFocus(() => screen.getByPlaceholderText('Comment (optional)…'))

    expect(screen.getByRole('dialog', { name: 'Add to chat' })).toBeTruthy()
  })

  it('EFEITO: collapse during pointer transit inside the bar keeps it present until focus arrives', () => {
    renderLayer(() => {})
    selectText(textOf('model-seg'), 0, 5)
    fireEvent.pointerUp(document)
    expect(screen.getByRole('dialog', { name: 'Add to chat' })).toBeTruthy()

    const input = screen.getByPlaceholderText('Comment (optional)…')
    fireEvent.pointerDown(input)
    expect(document.activeElement).not.toBe(input)

    const selection = document.getSelection()!
    selection.collapseToEnd()
    fireEvent(document, new Event('selectionchange'))
    fireEvent.pointerUp(document)

    expect(screen.getByRole('dialog', { name: 'Add to chat' })).toBeTruthy()
  })

  it('EFEITO: leaving the bar by Tab expires the pointer bridge so a later collapse dismisses it', () => {
    renderLayer(() => {})
    selectText(textOf('model-seg'), 0, 5)
    fireEvent.pointerUp(document)
    expect(screen.getByRole('dialog', { name: 'Add to chat' })).toBeTruthy()

    const input = screen.getByPlaceholderText('Comment (optional)…')
    fireEvent.pointerDown(input)
    input.focus()
    fireEvent.pointerUp(document)
    expect(document.activeElement).toBe(input)
    expect(screen.getByRole('dialog', { name: 'Add to chat' })).toBeTruthy()

    // jsdom dispatches Tab but does not move focus to the next control.
    // Reproduce the browser's resulting focus transition explicitly.
    fireEvent.keyDown(input, { key: 'Tab' })
    const outside = screen.getByTestId('outside-focus')
    outside.focus()
    expect(document.activeElement).toBe(outside)

    const selection = document.getSelection()!
    selection.collapseToEnd()
    fireEvent(document, new Event('selectionchange'))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('CONTRAFACTUAL: collapsed document selection with focus OUTSIDE the bar dismisses it', () => {
    renderLayer(() => {})

    openBarThenCollapseSelectionWithFocus(() => screen.getByTestId('outside-focus'))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('pointer down outside the bar dismisses it immediately', () => {
    renderLayer(() => {})
    selectText(textOf('model-seg'), 0, 5)
    fireEvent.pointerUp(document)
    expect(screen.getByRole('dialog', { name: 'Add to chat' })).toBeTruthy()

    fireEvent.pointerDown(screen.getByTestId('outside-focus'))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('scrolling the transcript surface dismisses the open bar', () => {
    renderLayer(() => {})
    selectText(textOf('model-seg'), 0, 5)
    fireEvent.pointerUp(document)
    expect(screen.getByRole('dialog', { name: 'Add to chat' })).toBeTruthy()

    fireEvent.scroll(screen.getByTestId('scroll-surface'))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('EFEITO: a long comment scrolls inside the capped field and leaves Add to chat actionable', () => {
    const { addButton, bar, comment, composer, onCreate } = openBarForCommentGrowth()
    const longComment = 'A long annotation comment that wraps across many visual lines. '.repeat(12)
    fireEvent.change(comment, { target: { value: longComment } })
    fireEvent.scroll(comment)

    expect(comment.value).toBe(longComment)
    expect(bar.contains(addButton)).toBe(true)
    expect(comment.style.maxHeight).toBe('74px')
    expect(comment.style.height).toBe('74px')
    expect(comment.style.overflowY).toBe('auto')
    expect(comment.scrollHeight).toBeGreaterThan(Number.parseFloat(comment.style.height))
    expect(bar.getBoundingClientRect().bottom).toBeLessThan(composer.getBoundingClientRect().top)

    fireEvent.click(addButton)
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('GEOMETRIA: the same long comment gets a larger ceiling for a selection near the top', () => {
    const { bar, comment, composer } = openBarForCommentGrowth({ selectionTop: 100, composerTop: 650 })
    const longComment = 'A long annotation comment that wraps across many visual lines. '.repeat(12)
    fireEvent.change(comment, { target: { value: longComment } })

    expect(comment.style.maxHeight).toBe('574px')
    expect(comment.style.height).toBe('574px')
    expect(comment.style.overflowY).toBe('auto')
    expect(bar.getBoundingClientRect().bottom).toBeLessThan(composer.getBoundingClientRect().top)
  })

  it('GEOMETRIA: shrinking the window recalculates an open long comment before it reaches the composer', () => {
    const { bar, comment, composer, setViewportGeometry } = openBarForCommentGrowth()
    const longComment = 'A long annotation comment that wraps across many visual lines. '.repeat(12)
    fireEvent.change(comment, { target: { value: longComment } })
    expect(comment.style.maxHeight).toBe('74px')

    setViewportGeometry(700, 600)
    fireEvent(window, new Event('resize'))

    expect(comment.style.maxHeight).toBe('24px')
    expect(comment.style.height).toBe('24px')
    expect(comment.style.overflowY).toBe('auto')
    expect(bar.getBoundingClientRect().bottom).toBeLessThan(composer.getBoundingClientRect().top)
  })

  it('GEOMETRIA: composer growth recalculates the open long comment without new typing', () => {
    let notifyComposerResize = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        notifyComposerResize = () => callback([], this as unknown as ResizeObserver)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    const { bar, comment, composer, setViewportGeometry } = openBarForCommentGrowth()
    const longComment = 'A long annotation comment that wraps across many visual lines. '.repeat(12)
    fireEvent.change(comment, { target: { value: longComment } })
    expect(comment.style.maxHeight).toBe('74px')

    setViewportGeometry(800, 600)
    notifyComposerResize()

    expect(comment.style.maxHeight).toBe('24px')
    expect(comment.style.height).toBe('24px')
    expect(bar.getBoundingClientRect().bottom).toBeLessThan(composer.getBoundingClientRect().top)
  })

  it('CONTRAFACTUAL: a short comment uses its content height without internal scroll', () => {
    const { addButton, bar, comment, composer, onCreate } = openBarForCommentGrowth()
    const shortComment = 'Short comment'
    fireEvent.change(comment, { target: { value: shortComment } })

    expect(comment.value).toBe(shortComment)
    expect(bar.contains(addButton)).toBe(true)
    expect(comment.style.maxHeight).toBe('74px')
    expect(comment.style.height).toBe('32px')
    expect(comment.style.overflowY).toBe('hidden')
    expect(comment.scrollHeight).toBe(Number.parseFloat(comment.style.height))
    expect(bar.getBoundingClientRect().bottom).toBeLessThan(composer.getBoundingClientRect().top)

    fireEvent.click(addButton)
    expect(onCreate).toHaveBeenCalledTimes(1)
  })
})

describe('AnnotationLayer — creation', () => {
  it('clicking "Add to chat" delivers an Annotation with EXACTLY the selected text as quote', () => {
    const received: Annotation[] = []
    renderLayer(a => received.push(a))
    // "alpha beta gamma delta" — select "beta"
    selectText(textOf('model-seg'), 6, 10)
    fireEvent.pointerUp(document)

    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))

    expect(received).toHaveLength(1)
    expect(received[0].quote).toBe('beta')
    expect(received[0].segmentId).toBe('turn1:text:0')
    expect(received[0].comment).toBeNull()
    expect(received[0].prefix).toBe('alpha ')
    expect(received[0].suffix).toBe(' gamma delta')
    expect(received[0].occurrenceIndex).toBe(0)
    // Bar dismissed after creation — the screen returns to clean.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a typed comment travels in the annotation', () => {
    const received: Annotation[] = []
    renderLayer(a => received.push(a))
    selectText(textOf('model-seg'), 6, 10)
    fireEvent.pointerUp(document)

    fireEvent.change(screen.getByPlaceholderText('Comment (optional)…'), { target: { value: 'check this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))

    expect(received).toHaveLength(1)
    expect(received[0].comment).toBe('check this')
  })

  it('a selection crossing into UNMARKED content clamps to the segment and SAYS SO in the bar', () => {
    render(
      <I18nProvider language="en-US">
        <div>
          <div data-annotation-segment="turn1:text:0" data-testid="seg-a">first segment</div>
          <p data-testid="tail">unmarked tail</p>
        </div>
        <AnnotationLayer conversationId="conv-a" onCreate={() => {}} />
      </I18nProvider>,
    )
    // Anchor inside the segment, focus OUTSIDE (unmarked tail) → clamp + notice.
    const sel = document.getSelection()!
    sel.setBaseAndExtent(textOf('seg-a'), 2, textOf('tail'), 4)
    fireEvent.pointerUp(document)

    const bar = screen.getByRole('dialog', { name: 'Add to chat' })
    expect(bar.textContent).toContain('Selection limited to one message.')
  })

  it('Escape dismisses the bar without creating anything', () => {
    const spy = vi.fn()
    renderLayer(spy)
    selectText(textOf('model-seg'), 0, 5)
    fireEvent.pointerUp(document)
    expect(screen.getByRole('dialog', { name: 'Add to chat' })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

/**
 * Obstacle geometry — pins that the hook's selector matches the REAL classes
 * the app renders (ChecklistPanel.tsx:311-313: base 'checklist-panel' +
 * 'floating'/'docked' modifiers). The Maestro caught the inventory missing
 * the DOCKED card: a selection near the end of the transcript with the card
 * docked and no goal active landed the bar ON it.
 *
 * Geometry used (deterministic): the Range polyfill above puts the selection
 * rect at {top:100,left:100,width:50,height:20}; BAR_SIZE in the hook is
 * 300×44; jsdom viewport is 1024×768. So the free position is ABOVE at
 * {top:48,left:8}. An obstacle stubbed over exactly that rect forces the
 * bar BELOW to top:128 — proven through the REAL wiring (selector → live
 * measure → pure positioner → inline style), not by re-deriving the math.
 */
describe('AnnotationLayer — obstacle inventory (checklist card, BOTH forms)', () => {
  const OBSTACLE_OVER_ABOVE = { top: 40, left: 0, width: 320, height: 60 } as DOMRect

  function renderWithObstacle(obstacleClass: string) {
    const utils = render(
      <I18nProvider language="en-US">
        <div>
          <div className={obstacleClass} data-testid="obstacle" />
          <div data-annotation-segment="turn1:text:0" data-testid="model-seg">
            alpha beta gamma delta
          </div>
        </div>
        <AnnotationLayer conversationId="conv-a" onCreate={() => {}} />
      </I18nProvider>,
    )
    vi.spyOn(screen.getByTestId('obstacle'), 'getBoundingClientRect').mockReturnValue(OBSTACLE_OVER_ABOVE)
    return utils
  }

  afterEach(() => vi.restoreAllMocks())

  it('DOCKED checklist card over the free spot → the bar MOVES below, no intersection', () => {
    renderWithObstacle('checklist-panel docked')
    selectText(textOf('model-seg'), 0, 5)
    fireEvent.pointerUp(document)

    const bar = screen.getByRole('dialog', { name: 'Add to chat' })
    expect(bar.getAttribute('data-placement')).toBe('below')
    expect(bar.style.top).toBe('128px')
    expect(bar.style.left).toBe('8px')
  })

  it('FLOATING checklist card over the free spot → the bar still MOVES below (regression pin)', () => {
    renderWithObstacle('checklist-panel floating')
    selectText(textOf('model-seg'), 0, 5)
    fireEvent.pointerUp(document)

    const bar = screen.getByRole('dialog', { name: 'Add to chat' })
    expect(bar.getAttribute('data-placement')).toBe('below')
    expect(bar.style.top).toBe('128px')
  })

  it('CONTRAFACTUAL: the SAME rect on an element WITHOUT the checklist class is NOT avoided', () => {
    renderWithObstacle('unrelated-panel')
    selectText(textOf('model-seg'), 0, 5)
    fireEvent.pointerUp(document)

    const bar = screen.getByRole('dialog', { name: 'Add to chat' })
    // The only variable vs the two tests above is the class: without
    // 'checklist-panel' the rect never becomes an obstacle and the bar
    // keeps the free ABOVE position — intersecting the rect.
    expect(bar.getAttribute('data-placement')).toBe('above')
    expect(bar.style.top).toBe('48px')
  })
})
