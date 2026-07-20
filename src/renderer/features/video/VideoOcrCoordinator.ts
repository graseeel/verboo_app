/**
 * VideoOcrCoordinator — bridges backend frame batches to the existing
 * Tesseract.js Web Worker.
 *
 * The Rust pipeline emits a `video:ocr-request` event with a jobId and up to
 * 60 timestamped frame URLs. This coordinator processes frames strictly
 * serially through the shared OCR worker (never on the main thread), keeps
 * per-frame failures as skips instead of failing the batch, and invokes the
 * completion command exactly once per job. Cancellation stops remaining
 * frames and still completes the batch with what was recognized so far —
 * the backend side owns timeouts and releases stale waiters.
 */

import type { VideoOcrRequest, VideoOcrText } from '../../../shared/types'

export type VideoOcrDeps = {
  /** Recognize one image URL; resolves null on worker failure. */
  recognize: (url: string) => Promise<{ text: string; confidence: number } | null>
  /** Return one batch to the backend (complete_video_ocr_batch). */
  complete: (jobId: string, results: VideoOcrText[]) => Promise<void>
}

export type VideoOcrCoordinator = {
  /** Handle one backend request. Resolves when the batch was returned. */
  handleRequest: (request: VideoOcrRequest) => Promise<void>
  /** Stop processing remaining frames for a job. */
  cancel: (jobId: string) => void
}

export function createVideoOcrCoordinator(deps: VideoOcrDeps): VideoOcrCoordinator {
  const cancelledJobs = new Set<string>()
  const completedJobs = new Set<string>()

  async function handleRequest(request: VideoOcrRequest): Promise<void> {
    if (completedJobs.has(request.jobId)) return
    const results: VideoOcrText[] = []
    for (const frame of request.frames) {
      if (cancelledJobs.has(request.jobId)) break
      try {
        const recognized = await deps.recognize(frame.url)
        if (recognized && recognized.text.trim().length > 0) {
          results.push({
            timestampMs: frame.timestampMs,
            text: recognized.text,
            confidence: recognized.confidence,
          })
        }
      } catch {
        // An individual frame failure is a skip, never a batch failure.
      }
    }
    if (completedJobs.has(request.jobId)) return
    completedJobs.add(request.jobId)
    cancelledJobs.delete(request.jobId)
    try {
      await deps.complete(request.jobId, results)
    } catch {
      // The backend released the waiter (timeout/cancel); nothing to do.
    }
  }

  return {
    handleRequest,
    cancel(jobId: string) {
      cancelledJobs.add(jobId)
    },
  }
}
