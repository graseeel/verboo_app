export class LatestFrameCoalescer<T> {
  private pending: T | undefined
  private requestId: number | undefined
  private fallbackId: number | undefined

  constructor(
    private readonly schedule: (callback: FrameRequestCallback) => number,
    private readonly cancel: (id: number) => void,
    private readonly commit: (value: T) => void,
    private readonly scheduleFallback?: (callback: FrameRequestCallback) => number,
    private readonly cancelFallback?: (id: number) => void,
  ) {}

  push(value: T) {
    this.pending = value
    if (this.requestId !== undefined) return
    const flush = () => this.flush()
    this.requestId = this.schedule(flush)
    this.fallbackId = this.scheduleFallback?.(flush)
  }

  dispose() {
    if (this.requestId !== undefined) this.cancel(this.requestId)
    if (this.fallbackId !== undefined) this.cancelFallback?.(this.fallbackId)
    this.requestId = undefined
    this.fallbackId = undefined
    this.pending = undefined
  }

  private flush() {
    if (this.requestId === undefined) return
    this.cancel(this.requestId)
    if (this.fallbackId !== undefined) this.cancelFallback?.(this.fallbackId)
    this.requestId = undefined
    this.fallbackId = undefined
    const next = this.pending
    this.pending = undefined
    if (next !== undefined) this.commit(next)
  }
}
