import { describe, expect, it } from 'vitest'
import { FrameStats } from './frameStats'
const TIME_ORIGIN_MS = 1_000_000_000
function producerUsFor(paintedAtMs: number, lagMs: number): bigint {
  return BigInt(Math.round((TIME_ORIGIN_MS + paintedAtMs - lagMs) * 1000))
}
describe('FrameStats', () => {
  it('measures real producer-to-paint latency from VAF1 timestampUs', () => {
    const stats = new FrameStats({ timeOriginMs: TIME_ORIGIN_MS })
    ;[20, 21, 22, 23, 24, 25].forEach((lagMs, index) => {
      stats.recordPaint({
        seq: index + 1,
        timestampUs: producerUsFor(index * 16, lagMs),
        paintedAtMs: index * 16,
      })
    })
    expect(stats.producerToPaintP95Ms()).toBe(25)
  })
  it('computes presented fps over a synthetic 60-frame 50fps window', () => {
    const stats = new FrameStats()
    for (let i = 0; i <= 60; i++) stats.recordPresented(i * 20)
    expect(stats.presentedFps(1_200)).toBeCloseTo(50, 9)
  })
  it('needs two samples and respects the trailing window cutoff', () => {
    const stats = new FrameStats({ windowMs: 500 })
    expect(stats.presentedFps(0)).toBeUndefined()
    stats.recordPresented(0)
    expect(stats.presentedFps(10)).toBeUndefined()
    stats.recordPresented(300)
    stats.recordPresented(900)
    expect(stats.presentedFps(1_000)).toBeUndefined()
    stats.recordPresented(1_400)
    expect(stats.presentedFps(1_400)).toBeCloseTo(2, 9)
  })
  it('uses the frozen 4096-sample default ring and stays bounded', () => {
    const stats = new FrameStats({ timeOriginMs: TIME_ORIGIN_MS })
    expect(stats.capacity).toBe(4096)
    for (let i = 1; i <= 4100; i++) {
      stats.recordPaint({ seq: i, timestampUs: producerUsFor(i, i), paintedAtMs: i })
    }
    expect(stats.producerToPaintP95Ms()).toBe(3896)
  })
  it('counts wakeups vs paints into rendererDropped without per-frame state', () => {
    const stats = new FrameStats({ capacity: 8 })
    for (let i = 0; i < 5; i++) stats.recordWakeup()
    for (let i = 0; i < 2; i++) {
      stats.recordPaint({ seq: i + 1, timestampUs: producerUsFor(i * 16, 10), paintedAtMs: i * 16 })
    }
    expect(stats.snapshot(32).rendererDropped).toBe(3)
    for (let i = 2; i < 6; i++) {
      stats.recordPaint({ seq: i + 1, timestampUs: producerUsFor(i * 16, 10), paintedAtMs: i * 16 })
    }
    const snapshot = stats.snapshot(64)
    expect(snapshot.rendererDropped).toBe(0)
    expect(snapshot.presentedFps).toBeUndefined()
    expect(snapshot.producerToPaintP95Ms).toBeDefined()
  })
  it('a REAL receipt with invalid/future lag still counts: rendererDropped stays 0', () => {
    const stats = new FrameStats({ timeOriginMs: TIME_ORIGIN_MS })
    stats.recordWakeup()
    stats.recordPaint({ seq: 1, timestampUs: producerUsFor(100, -5), paintedAtMs: 100 })
    const snap = stats.snapshot(0)
    expect(snap.rendererDropped).toBe(0)
    expect(snap.producerToPaintP95Ms).toBeUndefined()
  })
  it('rejects non-finite/negative latencies and reset clears counters', () => {
    const stats = new FrameStats({ timeOriginMs: TIME_ORIGIN_MS })
    stats.recordPaint({ seq: 1, timestampUs: producerUsFor(100, -1), paintedAtMs: 100 })
    stats.recordPresented(Number.NaN)
    expect(stats.producerToPaintP95Ms()).toBeUndefined()
    stats.recordWakeup()
    stats.reset()
    expect(stats.snapshot().rendererDropped).toBe(0)
  })
})
