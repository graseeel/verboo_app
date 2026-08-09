import { describe, expect, it, vi } from 'vitest'
import { LatestFrameCoalescer } from './frameCoalescer'

describe('LatestFrameCoalescer', () => {
  it('commits only the newest pending frame in one animation frame', () => {
    const callbacks: FrameRequestCallback[] = []
    const committed: number[] = []
    const coalescer = new LatestFrameCoalescer<number>(
      callback => {
        callbacks.push(callback)
        return callbacks.length
      },
      vi.fn(),
      value => committed.push(value),
    )

    coalescer.push(1)
    coalescer.push(2)
    coalescer.push(3)

    expect(callbacks).toHaveLength(1)
    callbacks[0](16)
    expect(committed).toEqual([3])
  })

  it('cancels and forgets a pending frame when disposed', () => {
    const callbacks: FrameRequestCallback[] = []
    const cancel = vi.fn()
    const commit = vi.fn()
    const coalescer = new LatestFrameCoalescer<number>(
      callback => {
        callbacks.push(callback)
        return 41
      },
      cancel,
      commit,
    )

    coalescer.push(1)
    coalescer.dispose()
    callbacks[0](16)

    expect(cancel).toHaveBeenCalledWith(41)
    expect(commit).not.toHaveBeenCalled()
  })

  it('commits through a fallback when animation frames are starved', () => {
    const animationCallbacks: FrameRequestCallback[] = []
    const fallbackCallbacks: FrameRequestCallback[] = []
    const cancelAnimation = vi.fn()
    const cancelFallback = vi.fn()
    const commit = vi.fn()
    const coalescer = new LatestFrameCoalescer<number>(
      callback => {
        animationCallbacks.push(callback)
        return 11
      },
      cancelAnimation,
      commit,
      callback => {
        fallbackCallbacks.push(callback)
        return 22
      },
      cancelFallback,
    )

    coalescer.push(1)
    coalescer.push(2)
    fallbackCallbacks[0](16)

    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(2)
    expect(cancelAnimation).toHaveBeenCalledWith(11)
    animationCallbacks[0](17)
    expect(commit).toHaveBeenCalledOnce()
  })
})
