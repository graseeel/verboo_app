import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useGoalPanelExit } from './useGoalPanelExit'
import type { GoalState } from '../../../shared/types'

/**
 * useGoalPanelExit — the genie EXIT window (user request: the panel
 * sinks back into the composer when the goal finishes). The tests pin
 * the WINDOW, not the CSS: when the snapshot is exposed, for how long,
 * and — counterfactual standard — when it must NEVER be exposed
 * (reduced motion, clear/cancel, conversation switch, persisted
 * terminal goal on reopen).
 */

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'goal-1',
    objective: 'Create /tmp/test.txt',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnsRun: 0,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    noProgressCount: 0,
    recentFingerprints: [],
    accessMode: 'approval',
    workingDirectory: '/tmp',
    skills: [],
    ...overrides,
  }
}

const NO_REDUCED_MOTION = () => false
const REDUCED_MOTION = () => true
const DURATION = 280

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useGoalPanelExit — live goal', () => {
  it('exposes NOTHING while the goal is live (active, evaluating, continuing, paused)', () => {
    for (const status of ['active', 'evaluating', 'continuing', 'paused'] as const) {
      const { result, unmount } = renderHook(
        ({ goal }) => useGoalPanelExit(goal, { durationMs: DURATION, prefersReducedMotion: NO_REDUCED_MOTION }),
        { initialProps: { goal: makeGoal({ status }) } },
      )
      expect(result.current.exitGoal, `status ${status} must not open an exit window`).toBeUndefined()
      act(() => {
        vi.advanceTimersByTime(DURATION * 2)
      })
      expect(result.current.exitGoal).toBeUndefined()
      unmount()
    }
  })

  it('paused is NOT an exit: pausing a running goal keeps the panel mounted with no leaving window', () => {
    // The batch can pause (K-guard, needsUser, user) and the panel must
    // STAY visible — exit is reserved for terminal states.
    const { result, rerender } = renderHook(
      ({ goal }) => useGoalPanelExit(goal, { durationMs: DURATION, prefersReducedMotion: NO_REDUCED_MOTION }),
      { initialProps: { goal: makeGoal({ status: 'active' }) } },
    )
    rerender({ goal: makeGoal({ status: 'paused', pauseReason: 'userPaused' }) })
    expect(result.current.exitGoal).toBeUndefined()
    act(() => {
      vi.advanceTimersByTime(DURATION * 2)
    })
    expect(result.current.exitGoal).toBeUndefined()
  })
})

describe('useGoalPanelExit — terminal transition', () => {
  it('completed: exposes the LIVE snapshot (not the terminal state) and clears it after durationMs', () => {
    const live = makeGoal({ status: 'active' })
    const { result, rerender } = renderHook(
      ({ goal }) => useGoalPanelExit(goal, { durationMs: DURATION, prefersReducedMotion: NO_REDUCED_MOTION }),
      { initialProps: { goal: live } },
    )

    rerender({ goal: { ...live, status: 'completed' } })

    // The snapshot is the last LIVE face of the goal — the panel must
    // sink looking like what the user last saw, never flashing a
    // terminal label during the animation.
    expect(result.current.exitGoal).toBeDefined()
    expect(result.current.exitGoal?.id).toBe('goal-1')
    expect(result.current.exitGoal?.status).toBe('active')

    // Counterfactual boundary: one ms before the deadline the snapshot
    // is STILL there — the window does not close early.
    act(() => {
      vi.advanceTimersByTime(DURATION - 1)
    })
    expect(result.current.exitGoal).toBeDefined()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.exitGoal).toBeUndefined()
  })

  it('blocked: same exit window (unsafe stops the batch — the panel sinks)', () => {
    const live = makeGoal({ status: 'evaluating' })
    const { result, rerender } = renderHook(
      ({ goal }) => useGoalPanelExit(goal, { durationMs: DURATION, prefersReducedMotion: NO_REDUCED_MOTION }),
      { initialProps: { goal: live } },
    )
    rerender({ goal: { ...live, status: 'blocked' } })
    expect(result.current.exitGoal?.status).toBe('evaluating')
  })

  it('resume from blocked CANCELS the exit window — the live panel takes back the slot', () => {
    const live = makeGoal({ status: 'active' })
    const { result, rerender } = renderHook(
      ({ goal }) => useGoalPanelExit(goal, { durationMs: DURATION, prefersReducedMotion: NO_REDUCED_MOTION }),
      { initialProps: { goal: live } },
    )
    rerender({ goal: { ...live, status: 'blocked' } })
    expect(result.current.exitGoal).toBeDefined()

    // The user resumes before the window closes: the leaving ghost must
    // not coexist with the resurrected live panel.
    rerender({ goal: { ...live, status: 'active' } })
    expect(result.current.exitGoal).toBeUndefined()
    act(() => {
      vi.advanceTimersByTime(DURATION * 2)
    })
    expect(result.current.exitGoal).toBeUndefined()
  })

  it('a NEW live goal (different id) does not inherit the exit ghost of the finished one', () => {
    const live = makeGoal({ status: 'active' })
    const { result, rerender } = renderHook(
      ({ goal }) => useGoalPanelExit(goal, { durationMs: DURATION, prefersReducedMotion: NO_REDUCED_MOTION }),
      { initialProps: { goal: live } },
    )
    rerender({ goal: { ...live, status: 'completed' } })
    expect(result.current.exitGoal).toBeDefined()

    rerender({ goal: makeGoal({ id: 'goal-2', status: 'active', objective: 'New goal' }) })
    expect(result.current.exitGoal).toBeUndefined()
    act(() => {
      vi.advanceTimersByTime(DURATION * 2)
    })
    expect(result.current.exitGoal).toBeUndefined()
  })
})

describe('useGoalPanelExit — paths that must NEVER animate', () => {
  it('REDUCED MOTION: terminal transition exposes no window, ever', () => {
    // Requirement: under prefers-reduced-motion the exit is instant —
    // the genie must never play. This is the JS half of the guarantee
    // (the CSS half kills the animation itself, belt-and-braces).
    const live = makeGoal({ status: 'active' })
    const { result, rerender } = renderHook(
      ({ goal }) => useGoalPanelExit(goal, { durationMs: DURATION, prefersReducedMotion: REDUCED_MOTION }),
      { initialProps: { goal: live } },
    )
    rerender({ goal: { ...live, status: 'completed' } })
    expect(result.current.exitGoal).toBeUndefined()
    act(() => {
      vi.advanceTimersByTime(DURATION * 4)
    })
    expect(result.current.exitGoal).toBeUndefined()
  })

  it('clear/cancel (goal becomes undefined) opens NO exit window', () => {
    // Cancel is the user's own click — the panel disappears immediately.
    // (Conversation switch produces the same signal and must not
    // animate a stale panel over the freshly-switched chat either.)
    const live = makeGoal({ status: 'active' })
    const { result, rerender } = renderHook(
      ({ goal }) => useGoalPanelExit(goal, { durationMs: DURATION, prefersReducedMotion: NO_REDUCED_MOTION }),
      { initialProps: { goal: live as GoalState | undefined } },
    )
    rerender({ goal: undefined })
    expect(result.current.exitGoal).toBeUndefined()
    act(() => {
      vi.advanceTimersByTime(DURATION * 2)
    })
    expect(result.current.exitGoal).toBeUndefined()
  })

  it('clearing DURING the exit window drops the ghost immediately', () => {
    const live = makeGoal({ status: 'active' })
    const { result, rerender } = renderHook(
      ({ goal }) => useGoalPanelExit(goal, { durationMs: DURATION, prefersReducedMotion: NO_REDUCED_MOTION }),
      { initialProps: { goal: live as GoalState | undefined } },
    )
    rerender({ goal: { ...live, status: 'completed' } })
    expect(result.current.exitGoal).toBeDefined()

    rerender({ goal: undefined })
    expect(result.current.exitGoal).toBeUndefined()
  })

  it('a goal terminal ON MOUNT (persisted, app reopened) does not animate — no live snapshot exists', () => {
    const { result } = renderHook(
      ({ goal }) => useGoalPanelExit(goal, { durationMs: DURATION, prefersReducedMotion: NO_REDUCED_MOTION }),
      { initialProps: { goal: makeGoal({ status: 'completed' }) } },
    )
    expect(result.current.exitGoal).toBeUndefined()
    act(() => {
      vi.advanceTimersByTime(DURATION * 2)
    })
    expect(result.current.exitGoal).toBeUndefined()
  })

  it('a terminal goal whose id matches NO live snapshot (stale ref from another goal) does not animate', () => {
    // Guards the identity check: goal-A live → goal-B appears already
    // terminal (e.g. hydrated). A's snapshot must not dress up as B's
    // exit — the id must match.
    const { result, rerender } = renderHook(
      ({ goal }) => useGoalPanelExit(goal, { durationMs: DURATION, prefersReducedMotion: NO_REDUCED_MOTION }),
      { initialProps: { goal: makeGoal({ id: 'goal-a', status: 'active' }) } },
    )
    rerender({ goal: makeGoal({ id: 'goal-b', status: 'completed' }) })
    expect(result.current.exitGoal).toBeUndefined()
  })
})
