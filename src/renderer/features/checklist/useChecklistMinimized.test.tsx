import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useChecklistMinimized } from './useChecklistMinimized'

/**
 * useChecklistMinimized — POSSE (gate da Sonda, 2026-08-12): the
 * checklist is per-conversation (todosByConversation), so the minimized
 * state must obey the conversation too. A single App-level boolean
 * leaked: minimize in conversation A and conversation B opened
 * minimized.
 *
 * DECISION (documented, not accidental): the reset is a RESET, not a
 * per-conversation memory. Switching conversations always re-expands;
 * returning to A does NOT restore the bar. Minimizing is a "clear my
 * view right now" gesture on the list I'm looking at — carrying it to
 * another conversation's list is the leak; restoring it hours later in
 * A would be a surprise of the same kind.
 */

describe('useChecklistMinimized: POSSE — the state obeys the owner conversation', () => {
  it('minimizes and re-expands within the SAME conversation', () => {
    const { result } = renderHook(({ id }) => useChecklistMinimized(id), {
      initialProps: { id: 'conv-A' as string | undefined },
    })
    expect(result.current.minimized).toBe(false)
    act(() => result.current.toggleMinimized())
    expect(result.current.minimized).toBe(true)
    act(() => result.current.toggleMinimized())
    expect(result.current.minimized).toBe(false)
  })

  it('LEAK regression: minimized in A → switch to B → B renders EXPANDED', () => {
    const { result, rerender } = renderHook(({ id }) => useChecklistMinimized(id), {
      initialProps: { id: 'conv-A' as string | undefined },
    })
    act(() => result.current.toggleMinimized())
    expect(result.current.minimized).toBe(true)

    rerender({ id: 'conv-B' })
    // No stale frame: the adjustment happens DURING the render that
    // switches the conversation, so B never paints a minimized bar.
    expect(result.current.minimized).toBe(false)
  })

  it('back to A: still expanded (reset semantics — A does NOT remember the bar)', () => {
    const { result, rerender } = renderHook(({ id }) => useChecklistMinimized(id), {
      initialProps: { id: 'conv-A' as string | undefined },
    })
    act(() => result.current.toggleMinimized())
    rerender({ id: 'conv-B' })
    rerender({ id: 'conv-A' })
    expect(result.current.minimized).toBe(false)
  })

  it('no conversation (undefined) → first conversation also starts expanded', () => {
    const { result, rerender } = renderHook(({ id }) => useChecklistMinimized(id), {
      initialProps: { id: undefined as string | undefined },
    })
    act(() => result.current.toggleMinimized())
    expect(result.current.minimized).toBe(true)
    rerender({ id: 'conv-A' })
    expect(result.current.minimized).toBe(false)
  })
})
