export class LatestFrameCoalescer<T> {
  private pending: T | undefined
  private requestId: number | undefined

  constructor(
    private readonly schedule: (callback: FrameRequestCallback) => number,
    private readonly cancel: (id: number) => void,
    private readonly commit: (value: T) => void,
  ) {}

  push(value: T) {
    this.pending = value
    if (this.requestId !== undefined) return
    this.requestId = this.schedule(() => {
      this.requestId = undefined
      const next = this.pending
      this.pending = undefined
      if (next !== undefined) this.commit(next)
    })
  }

  dispose() {
    if (this.requestId !== undefined) this.cancel(this.requestId)
    this.requestId = undefined
    this.pending = undefined
  }
}
