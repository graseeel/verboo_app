import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useOutsideDismiss } from './useOutsideDismiss'
import { useRef } from 'react'

/**
 * Regression tests for useOutsideDismiss, specifically the ignoreRefs
 * param that prevents a pointerdown race between the trigger element
 * and the dismissed panel.
 */

function createRefMock() {
  const el = document.createElement('div')
  const ref = { current: el } as React.RefObject<HTMLDivElement | null>
  return { el, ref }
}

describe('useOutsideDismiss', () => {
  it('calls onDismiss when clicking outside the ref', () => {
    const { el: panel, ref: panelRef } = createRefMock()
    const outside = document.createElement('button')
    document.body.appendChild(panel)
    document.body.appendChild(outside)

    const onDismiss = vi.fn()
    renderHook(() => useOutsideDismiss(panelRef, true, onDismiss))

    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onDismiss).toHaveBeenCalledTimes(1)

    document.body.removeChild(panel)
    document.body.removeChild(outside)
  })

  it('does NOT call onDismiss when clicking inside the ref', () => {
    const { el: panel, ref: panelRef } = createRefMock()
    const inside = document.createElement('button')
    panel.appendChild(inside)
    document.body.appendChild(panel)

    const onDismiss = vi.fn()
    renderHook(() => useOutsideDismiss(panelRef, true, onDismiss))

    inside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onDismiss).not.toHaveBeenCalled()

    document.body.removeChild(panel)
  })

  it('calls onDismiss on Escape key', () => {
    const { el: panel, ref: panelRef } = createRefMock()
    document.body.appendChild(panel)

    const onDismiss = vi.fn()
    renderHook(() => useOutsideDismiss(panelRef, true, onDismiss))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)

    document.body.removeChild(panel)
  })

  it('does NOT call onDismiss when ignoreRefs contains the click target', () => {
    const { el: panel, ref: panelRef } = createRefMock()
    const { el: trigger, ref: triggerRef } = createRefMock()
    document.body.appendChild(panel)
    document.body.appendChild(trigger)

    const onDismiss = vi.fn()
    renderHook(() => useOutsideDismiss(panelRef, true, onDismiss, [triggerRef]))

    // Click on the trigger (which is outside the panel but in ignoreRefs)
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onDismiss).not.toHaveBeenCalled()

    // Click on a different outside element SHOULD still dismiss
    const otherOutside = document.createElement('button')
    document.body.appendChild(otherOutside)
    otherOutside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onDismiss).toHaveBeenCalledTimes(1)

    document.body.removeChild(panel)
    document.body.removeChild(trigger)
    document.body.removeChild(otherOutside)
  })

  it('does NOT call onDismiss when ignoreRefs contains an ancestor of click target', () => {
    const { el: panel, ref: panelRef } = createRefMock()
    const { el: wrapper } = createRefMock()
    const wrapperRef = { current: wrapper } as React.RefObject<HTMLDivElement | null>
    const child = document.createElement('button')
    wrapper.appendChild(child)
    document.body.appendChild(panel)
    document.body.appendChild(wrapper)

    const onDismiss = vi.fn()
    renderHook(() => useOutsideDismiss(panelRef, true, onDismiss, [wrapperRef]))

    // Click on child element inside the ignored wrapper
    child.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onDismiss).not.toHaveBeenCalled()

    document.body.removeChild(panel)
    document.body.removeChild(wrapper)
  })

  it('does nothing when open is false', () => {
    const { el: panel, ref: panelRef } = createRefMock()
    const outside = document.createElement('button')
    document.body.appendChild(panel)
    document.body.appendChild(outside)

    const onDismiss = vi.fn()
    renderHook(() => useOutsideDismiss(panelRef, false, onDismiss))

    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onDismiss).not.toHaveBeenCalled()

    document.body.removeChild(panel)
    document.body.removeChild(outside)
  })
})