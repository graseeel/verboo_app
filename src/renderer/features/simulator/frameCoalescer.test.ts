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
})
