import type { ContextUsageSnapshot } from '../../../shared/types'

/**
 * T3: context-usage extraction, MOVED OUT of App.tsx so the frontier's
 * signal (ii) — contextUsage DROPS after a task-boundary compaction —
 * is testable as EFFECT at the layer where it is observable: the exact
 * function the stream-event handler feeds (App.tsx:~1751 wires
 * `extractContextUsage(event.payload, ...) → setContextUsage`).
 * Importing App.tsx into vitest would drag the whole component tree
 * and the Tauri bridge in; this module is pure payload→snapshot.
 *
 * The move is VERBATIM: every function below is byte-identical to its
 * pre-T3 App.tsx definition (comments included). App.tsx imports them
 * back from here. No behavior change.
 */

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

export function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/// Like `numberValue` but returns `undefined` for missing/non-number fields.
/// Used in fallback chains where we need to distinguish "field present" from
/// "field absent" (e.g. context_window.used_percentage might be absent).
export function numberValueOptional(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function extractUsageObject(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined
  if (isRecord(payload.usage)) return payload.usage
  if (isRecord(payload.message) && isRecord(payload.message.usage)) return payload.message.usage

  if (payload.type === 'stream_event' && isRecord(payload.event)) {
    if (isRecord(payload.event.usage)) return payload.event.usage
    if (isRecord(payload.event.message) && isRecord(payload.event.message.usage)) return payload.event.message.usage
  }

  return undefined
}

export function extractContextUsage(payload: unknown, maxTokens?: number): ContextUsageSnapshot | undefined {
  // Prefer the CLI's pre-calculated context_window object when available.
  // This is the authoritative source — the CLI accounts for its own context
  // management (system prompt, output reservation, compaction) which the
  // raw API usage tokens don't reflect. Using the CLI's numbers ensures the
  // meter matches what the CLI itself displays.
  const ctxWindow = extractContextWindowObject(payload)
  if (ctxWindow) {
    const cliUsedPercentage = numberValueOptional(ctxWindow.used_percentage)
    const cliWindowSize = numberValueOptional(ctxWindow.context_window_size)
    const cliTotalInput = numberValueOptional(ctxWindow.total_input_tokens)
    const cliTotalOutput = numberValueOptional(ctxWindow.total_output_tokens)
    const effectiveMax = cliWindowSize ?? maxTokens
    // If the CLI gives us a used_percentage (0-100), use it directly.
    // BUT: return undefined when the CLI sends early zeros (before any tokens
    // have actually been used) so the frontend's estimate is not overwritten.
    if (cliUsedPercentage !== undefined) {
      const valid = cliUsedPercentage > 0 || (cliTotalInput !== undefined && cliTotalInput > 0)
      if (!valid) return undefined
      const percentage = Math.max(0, Math.min(1, cliUsedPercentage / 100))
      const usedTokens = effectiveMax
        ? Math.round(percentage * effectiveMax)
        : cliTotalInput ?? 0
      return {
        usedTokens,
        maxTokens: effectiveMax,
        percentage,
        inputTokens: cliTotalInput,
        outputTokens: cliTotalOutput,
        source: 'cli-usage',
        updatedAt: Date.now(),
      }
    }
    // If the CLI gives us total_input_tokens + context_window_size, compute
    // from those (more accurate than raw API usage because the CLI tracks
    // cumulative input across the whole conversation).
    if (cliTotalInput !== undefined && effectiveMax !== undefined && effectiveMax > 0) {
      const percentage = Math.max(0, Math.min(1, cliTotalInput / effectiveMax))
      return {
        usedTokens: cliTotalInput,
        maxTokens: effectiveMax,
        percentage,
        inputTokens: cliTotalInput,
        outputTokens: cliTotalOutput,
        source: 'cli-usage',
        updatedAt: Date.now(),
      }
    }
  }

  // Fallback: compute from raw API usage tokens (input + cache).
  const usage = extractUsageObject(payload)
  if (!usage) return undefined

  const inputTokens = numberValue(usage.input_tokens) ?? 0
  const outputTokens = numberValue(usage.output_tokens) ?? 0
  const cacheCreationTokens = numberValue(usage.cache_creation_input_tokens) ?? 0
  const cacheReadTokens = numberValue(usage.cache_read_input_tokens) ?? 0
  const usedTokens = inputTokens + cacheCreationTokens + cacheReadTokens
  if (usedTokens <= 0) return undefined

  return {
    usedTokens,
    maxTokens,
    percentage: maxTokens ? Math.min(1, usedTokens / maxTokens) : undefined,
    inputTokens,
    outputTokens,
    source: 'cli-usage',
    updatedAt: Date.now(),
  }
}

/// Extracts the CLI's `context_window` object from a stream-json payload.
/// The CLI emits this with pre-calculated `used_percentage`,
/// `remaining_percentage`, `context_window_size`, `total_input_tokens`,
/// and `total_output_tokens`. This is the authoritative context usage.
function extractContextWindowObject(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined
  if (isRecord(payload.context_window)) return payload.context_window
  if (payload.type === 'stream_event' && isRecord(payload.event)) {
    if (isRecord(payload.event.context_window)) return payload.event.context_window
  }
  return undefined
}
