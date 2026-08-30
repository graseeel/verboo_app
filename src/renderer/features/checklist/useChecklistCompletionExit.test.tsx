import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHECKLIST_DONE_DWELL_MS,
  CHECKLIST_EXIT_MS,
  useChecklistCompletionExit,
} from './useChecklistCompletionExit'
import type { TodoItem } from '../../../shared/types'

/**
 * useChecklistCompletionExit — the completed list LEAVES (user order,
 * 2026-08-01). These tests prove the SEQUENCE with fake timers:
 * dwell → exit animation → removal, and — contrafactual, the fence's
 * reference standard — that the list does NOT leave a millisecond
 * before its time, that a NEW list is never deleted by a stale timer,
 * and that reduced motion removes instantly after the dwell.
 */

afterEach(cleanup)
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const item = (content: string, status: TodoItem['status'] = 'completed'): TodoItem => ({
  content,
  status,
  activeForm: '',
})

const ALL_DONE: TodoItem[] = [item('a'), item('b'), item('c')]
const WITH_PENDING: TodoItem[] = [item('a'), item('b', 'pending')]

function Harness({
  conversationId,
  todos,
  onRemove,
  reduced = false,
}: {
  conversationId: string | undefined
  todos: TodoItem[] | undefined
  onRemove: (id: string) => void
  reduced?: boolean
}) {
  const { exiting } = useChecklistCompletionExit(conversationId, todos, onRemove, {
    prefersReducedMotion: () => reduced,
  })
  return <div data-testid="exiting">{String(exiting)}</div>
}

function setup(
  props: { conversationId?: string; todos?: TodoItem[]; reduced?: boolean } = {},
  onRemove = vi.fn(),
) {
  const full = {
    conversationId: 'conv-1',
    todos: ALL_DONE,
    ...props,
  }
  const view = render(
    <Harness
      conversationId={full.conversationId}
      todos={full.todos}
      onRemove={onRemove}
      reduced={full.reduced}
    />,
  )
  const exiting = () => view.getByTestId('exiting').textContent === 'true'
  return { view, onRemove, exiting }
}

describe('useChecklistCompletionExit: THE SEQUENCE — dwell, animate, THEN remove', () => {
  it('leaves ONLY after dwell + exit — never a millisecond before (contrafactual)', () => {
    const { onRemove, exiting } = setup()
    // During the dwell the completed list is the confirmation — it must
    // still be there, not exiting, not removed.
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_DONE_DWELL_MS - 1)
    })
    expect(exiting()).toBe(false)
    expect(onRemove).not.toHaveBeenCalled()
    // The dwell elapses → the exit animation starts; removal must NOT
    // have happened yet (the animation plays on a mounted element).
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(exiting()).toBe(true)
    expect(onRemove).not.toHaveBeenCalled()
    // Mid-exit: still mounted.
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_EXIT_MS - 1)
    })
    expect(onRemove).not.toHaveBeenCalled()
    // The exit completes → ONLY NOW the list is removed.
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith('conv-1')
  })

  it('REDUCED MOTION: the dwell still applies, the removal is instant — no exit phase', () => {
    const { onRemove, exiting } = setup({ reduced: true })
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_DONE_DWELL_MS - 1)
    })
    expect(onRemove).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    // Removed at the dwell boundary WITHOUT an exiting phase.
    expect(exiting()).toBe(false)
    expect(onRemove).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_EXIT_MS + 100)
    })
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('a list with pending items NEVER starts the sequence', () => {
    const { onRemove, exiting } = setup({ todos: WITH_PENDING })
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_DONE_DWELL_MS + CHECKLIST_EXIT_MS + 1000)
    })
    expect(exiting()).toBe(false)
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('an EMPTY list does not trigger the vacuous every() true', () => {
    const { onRemove } = setup({ todos: [] })
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_DONE_DWELL_MS + CHECKLIST_EXIT_MS + 1000)
    })
    expect(onRemove).not.toHaveBeenCalled()
  })
})

describe('useChecklistCompletionExit: IDENTITY GUARD — a stale timer never kills a new list', () => {
  it('a NEW list arriving mid-dwell cancels the exit (contrafactual: otherwise removal fires into it)', () => {
    const { view, onRemove, exiting } = setup()
    act(() => {
      vi.advanceTimersByTime(800)
    })
    // The agent re-plans: a fresh list with pending items replaces the
    // completed one. If the dwell timer were not keyed to the list
    // reference, it would fire at 1600ms and DELETE the new list.
    view.rerender(
      <Harness conversationId="conv-1" todos={WITH_PENDING} onRemove={onRemove} />,
    )
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_DONE_DWELL_MS + CHECKLIST_EXIT_MS + 1000)
    })
    expect(onRemove).not.toHaveBeenCalled()
    expect(exiting()).toBe(false)
  })

  it('a NEW completed list arriving mid-EXIT cancels the removal and restarts its own dwell', () => {
    const { view, onRemove } = setup()
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_DONE_DWELL_MS + 100) // inside the exit window
    })
    const FRESH_DONE: TodoItem[] = [item('x'), item('y')]
    view.rerender(<Harness conversationId="conv-1" todos={FRESH_DONE} onRemove={onRemove} />)
    // The old exit timer must not land on the fresh list…
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_EXIT_MS + 500)
    })
    expect(onRemove).not.toHaveBeenCalled()
    // …and the fresh list runs its OWN full sequence from scratch.
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_DONE_DWELL_MS + CHECKLIST_EXIT_MS)
    })
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('an identical re-send (same reference — applyTodoWrite stability) does NOT restart the dwell', () => {
    const { view, onRemove, exiting } = setup()
    act(() => {
      vi.advanceTimersByTime(800)
    })
    view.rerender(<Harness conversationId="conv-1" todos={ALL_DONE} onRemove={onRemove} />)
    // Total elapsed 1600 — if the rerender had restarted the dwell,
    // exiting would only begin at 2400. It begins exactly on time.
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_DONE_DWELL_MS - 800)
    })
    expect(exiting()).toBe(true)
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_EXIT_MS)
    })
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('POSSESSION: switching conversation cancels the pending exit — no invisible mutation elsewhere', () => {
    const { view, onRemove } = setup()
    act(() => {
      vi.advanceTimersByTime(800)
    })
    view.rerender(<Harness conversationId="conv-2" todos={undefined} onRemove={onRemove} />)
    act(() => {
      vi.advanceTimersByTime(CHECKLIST_DONE_DWELL_MS + CHECKLIST_EXIT_MS + 1000)
    })
    expect(onRemove).not.toHaveBeenCalled()
  })
})
