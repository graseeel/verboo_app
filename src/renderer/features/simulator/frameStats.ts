export type PaintSample = {
  seq: number
  /** VAF1 header timestampUs — microssegundos, autoridade do producer. */
  timestampUs: bigint
  /** performance.now() capturado pelo painter logo após drawArrays. */
  paintedAtMs: number
}
export type FrameStatsOptions = {
  windowMs?: number
  capacity?: number
  /** Época ms da origem do clock performance. Default: performance.timeOrigin;
   *  fallback Date.now() − performance.now() quando o campo não existe. */
  timeOriginMs?: number
}
export type FrameStatsSnapshot = {
  presentedFps?: number
  producerToPaintP95Ms?: number
  rendererDropped: number
}
const DEFAULT_CAPACITY = 4096
/** performance.timeOrigin é a época EXATA do clock performance; o fallback
 *  reconstrói a mesma época (aproximada) em runtimes sem o campo. */
function defaultTimeOriginMs(): number {
  return Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin
    : Date.now() - performance.now()
}
export class FrameStats {
  readonly capacity: number
  private readonly windowMs: number
  private readonly timeOriginMs: number
  private readonly lags: number[] = []
  private readonly presented: number[] = []
  private wakeups = 0
  private paints = 0
  constructor(options: FrameStatsOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000
    this.capacity = options.capacity ?? DEFAULT_CAPACITY
    this.timeOriginMs = options.timeOriginMs ?? defaultTimeOriginMs()
  }
  reset(): void {
    this.lags.length = 0
    this.presented.length = 0
    this.wakeups = 0
    this.paints = 0
  }
  /** Um chamada por wakeup ACEITO (após validação sessão/generation). */
  recordWakeup(): void {
    this.wakeups += 1
  }
  recordPaint(sample: PaintSample): void {
    this.paints += 1                     // receipt REAL: conta SEMPRE
    const paintEpochMs = this.timeOriginMs + sample.paintedAtMs
    const lagMs = paintEpochMs - Number(sample.timestampUs) / 1000
    if (!Number.isFinite(lagMs) || lagMs < 0) return   // só OMITE a amostra
    this.lags.push(lagMs)
    if (this.lags.length > this.capacity) this.lags.shift()
  }
  recordPresented(atMs: number): void {
    if (!Number.isFinite(atMs)) return
    this.presented.push(atMs)
    if (this.presented.length > this.capacity) this.presented.shift()
    while (
      this.presented.length > 1
      && this.presented[0]! < this.presented[this.presented.length - 1]! - this.windowMs
    ) {
      this.presented.shift()
    }
  }
  /** fps médio apresentado na janela (spec §12.1/§12.2); undefined até 2 amostras. */
  presentedFps(nowMs: number): number | undefined {
    const cutoff = nowMs - this.windowMs
    const stamps = this.presented.filter(at => at >= cutoff)
    if (stamps.length < 2) return undefined
    const spanMs = stamps[stamps.length - 1]! - stamps[0]!
    if (spanMs <= 0) return undefined
    return ((stamps.length - 1) * 1000) / spanMs
  }
  /** p95 nearest-rank das latências producer-to-paint observadas, ms. */
  producerToPaintP95Ms(): number | undefined {
    if (this.lags.length === 0) return undefined
    const sorted = [...this.lags].sort((a, b) => a - b)
    const rank = Math.ceil(sorted.length * 0.95)
    return sorted[Math.min(rank, sorted.length) - 1]
  }
  /** Snapshot DEV/QA — nunca renderizado por frame; p95 calculado UMA vez. */
  snapshot(nowMs?: number): FrameStatsSnapshot {
    const presentedFps = nowMs === undefined ? undefined : this.presentedFps(nowMs)
    const p95 = this.producerToPaintP95Ms()
    return {
      ...(presentedFps === undefined ? {} : { presentedFps }),
      ...(p95 === undefined ? {} : { producerToPaintP95Ms: p95 }),
      rendererDropped: Math.max(this.wakeups - this.paints, 0),
    }
  }
}
