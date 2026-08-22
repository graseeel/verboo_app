/**
 * T3 — acceptance signal (ii): contextUsage DROPS after the compaction
 * frontier, tested at the layer where it is observable.
 *
 * extractContextUsage is the EXACT function the stream-event handler
 * feeds: App.tsx:~1751 wires
 *   const usage = extractContextUsage(event.payload, selectedContextWindowRef.current)
 *   if (usage) setContextUsage(usage)
 * so the UI meter always holds the snapshot of the LATEST event. This
 * test replays that wiring with simulated CLI event payloads — the same
 * `context_window` shape the CLI emits — and asserts the post-frontier
 * reading is LOWER than the pre-frontier one.
 *
 * What stays WITHOUT proof (declared honestly): that the REAL CLI on
 * the user's machine emits the drop cannot be proven from here — the
 * measured /compact runs (25s/50s, compact_boundary, zero assistant
 * text) say it does, but this test proves the observable layer: WHEN
 * the post-compact event arrives, the meter falls.
 *
 * The remaining tests pin the extraction's existing behavior byte-for-
 * byte after the T3 move out of App.tsx (verbatim move, zero behavior
 * change): both wire shapes, the early-zeros guard, the
 * total_input_tokens path, and the raw-usage fallback.
 */

import { describe, it, expect } from 'vitest'
import { extractContextUsage } from './contextUsage'

const WINDOW = 200_000

/** The CLI's pre-calculated context_window object, as emitted on stream
 *  events right BEFORE the frontier compaction runs. */
const preCompactPayload = {
  context_window: {
    used_percentage: 82,
    context_window_size: WINDOW,
    total_input_tokens: 164_000,
    total_output_tokens: 3_000,
  },
}

/** The same shape, as emitted by the first event AFTER the compaction. */
const postCompactPayload = {
  context_window: {
    used_percentage: 24,
    context_window_size: WINDOW,
    total_input_tokens: 48_000,
    total_output_tokens: 3_000,
  },
}

describe('T3 signal (ii): contextUsage drops across the compaction frontier', () => {
  it('the meter reads a LOWER usage from the post-compact event than from the pre-compact one', () => {
    // Replays the handler wiring: each event reduces to a snapshot and
    // the UI keeps the latest.
    const pre = extractContextUsage(preCompactPayload, WINDOW)
    const post = extractContextUsage(postCompactPayload, WINDOW)

    expect(pre).toBeDefined()
    expect(post).toBeDefined()
    expect(pre?.usedTokens).toBe(164_000)
    expect(post?.usedTokens).toBe(48_000)
    expect(post!.usedTokens).toBeLessThan(pre!.usedTokens)
    expect(post!.percentage!).toBeLessThan(pre!.percentage!)
    expect(post!.percentage!).toBeCloseTo(0.24)
    expect(pre!.percentage!).toBeCloseTo(0.82)
    expect(pre?.source).toBe('cli-usage')
    expect(post?.source).toBe('cli-usage')
  })

  it('CONTRAFACTUAL: without the frontier the meter does NOT drop — the fall is attributable to the compact', () => {
    // If no compaction happened between two events, the extractor
    // reports the same usage twice — a drop cannot be produced by
    // extractor noise; only by a real context reduction.
    const first = extractContextUsage(preCompactPayload, WINDOW)
    const second = extractContextUsage(preCompactPayload, WINDOW)

    expect(second?.usedTokens).toBe(first?.usedTokens)
    expect(second!.usedTokens).not.toBeLessThan(first!.usedTokens)
  })
})

describe('T3 extraction pins (verbatim move out of App.tsx — zero behavior change)', () => {
  it('reads the stream_event-wrapped context_window shape (the other wire form)', () => {
    const wrapped = { type: 'stream_event', event: { context_window: preCompactPayload.context_window } }
    const snapshot = extractContextUsage(wrapped, WINDOW)
    expect(snapshot?.usedTokens).toBe(164_000)
    expect(snapshot?.percentage!).toBeCloseTo(0.82)
  })

  it('rejects early zeros (returns undefined) so the local estimate is not overwritten', () => {
    const zeros = {
      context_window: { used_percentage: 0, context_window_size: WINDOW, total_input_tokens: 0 },
    }
    expect(extractContextUsage(zeros, WINDOW)).toBeUndefined()
    expect(extractContextUsage({}, WINDOW)).toBeUndefined()
    expect(extractContextUsage(undefined, WINDOW)).toBeUndefined()
  })

  it('computes from total_input_tokens + window size when used_percentage is absent', () => {
    const payload = {
      context_window: { context_window_size: WINDOW, total_input_tokens: 50_000, total_output_tokens: 1_000 },
    }
    const snapshot = extractContextUsage(payload, WINDOW)
    expect(snapshot?.usedTokens).toBe(50_000)
    expect(snapshot?.percentage!).toBeCloseTo(0.25)
    expect(snapshot?.inputTokens).toBe(50_000)
    expect(snapshot?.outputTokens).toBe(1_000)
  })

  it('falls back to raw API usage (snake_case, cache included) when no context_window exists', () => {
    const payload = {
      usage: {
        input_tokens: 1_000,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      },
    }
    const snapshot = extractContextUsage(payload, WINDOW)
    expect(snapshot?.usedTokens).toBe(1_500)
    expect(snapshot?.percentage!).toBeCloseTo(1_500 / WINDOW)
    expect(snapshot?.source).toBe('cli-usage')
    // Zero-usage payloads still yield undefined (no meter overwrite).
    expect(extractContextUsage({ usage: { input_tokens: 0, output_tokens: 0 } }, WINDOW)).toBeUndefined()
  })
})
