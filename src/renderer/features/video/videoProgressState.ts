/**
 * Pure state transitions for the transient per-turn video progress row.
 *
 * Live stages are an explicit upsert keyed by turnId — never routed through
 * the transcript activity list. Stages are monotonic: duplicated or
 * out-of-order events are dropped so the row can only advance.
 */

import type { VideoProgress } from '../../../shared/types'

export const VIDEO_STAGE_ORDER: Record<VideoProgress['stage'], number> = {
  validating: 0,
  preparing: 1,
  transcribing: 2,
  analyzing: 3,
  consolidating: 4,
}

export function applyVideoProgress(
  prev: Record<string, VideoProgress>,
  turnId: string,
  incoming: VideoProgress,
): Record<string, VideoProgress> {
  const current = prev[turnId]
  if (current && VIDEO_STAGE_ORDER[incoming.stage] <= VIDEO_STAGE_ORDER[current.stage]) {
    return prev
  }
  return { ...prev, [turnId]: incoming }
}

export function clearVideoProgress(
  prev: Record<string, VideoProgress>,
  turnId: string,
): Record<string, VideoProgress> {
  if (!(turnId in prev)) return prev
  const next = { ...prev }
  delete next[turnId]
  return next
}
