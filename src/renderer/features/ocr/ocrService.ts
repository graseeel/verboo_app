/**
 * src/renderer/features/ocr/ocrService.ts
 *
 * Lazy-loaded tesseract.js wrapper that runs OCR on local image files using
 * bundled WASM + worker assets. Eng+por traineddata are downloaded on first
 * use via the app data directory (the backend fetches them without CSP
 * restrictions). Until that backend command exists, traineddata is fetched
 * from jsdelivr CDN — if CSP blocks it, the user sees a clear warning.
 *
 * Design:
 * - tesseract.js worker is created lazily (first OCR call).
 * - Worker auto-terminates after IDLE_TEARDOWN_MS of inactivity.
 * - All exported functions are safe to call from any context (they handle
 *   their own worker lifecycle).
 */

import { createWorker } from 'tesseract.js'
import type { Worker } from 'tesseract.js'

// ── Config ────────────────────────────────────────────────────

/** Paths relative to the webview root — served from dist-renderer/ */
const ASSET_BASE = '/tessdata/'
const WORKER_PATH = `${ASSET_BASE}worker.min.js`
const CORE_PATH = `${ASSET_BASE}tesseract-core-simd-lstm.js`

/**
 * Where to look for .traineddata files. In production these should be in
 * the app data directory (downloaded by a Rust command into a known path).
 * For now we point at jsdelivr — CSP blocks this by default; the first OCR
 * call will fail gracefully and the user is told to configure assets.
 *
 * The path config here is overridden at runtime if the backend provides a
 * local traineddata directory via `getVisionFallbackState` or similar.
 */
const DEFAULT_LANG_PATH = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data'

/** Languages to load */
const LANGS = 'eng+por'

/** Teardown idle worker after 30s of inactivity */
const IDLE_TEARDOWN_MS = 30_000

// ── State ──────────────────────────────────────────────────────

let worker: Worker | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

// ── Helpers ─────────────────────────────────────────────────────

function scheduleTeardown() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    void terminateWorker()
  }, IDLE_TEARDOWN_MS)
}

async function ensureWorker(): Promise<Worker> {
  if (worker) return worker
  worker = await createWorker(LANGS, 1, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: DEFAULT_LANG_PATH,
    logger: () => { /* silence tesseract's verbose progress logs */ },
  })
  return worker
}

async function terminateWorker() {
  if (!worker) return
  try { await worker.terminate() } catch { /* ignore */ }
  worker = null
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
}

// ── Public API ─────────────────────────────────────────────────

export type OcrResult = {
  text: string
  confidence: number
  /** If the text is empty or nearly empty, this is a warning result */
  isEmpty: boolean
}

/**
 * Run OCR on an image file. The worker is created lazily on first use
 * and kept alive for reuse. Returns the recognized text + confidence.
 *
 * @param imageUrl - A webview-accessible URL for the image (e.g.
 *   from `convertFileSrc(path)` or `URL.createObjectURL(blob)`).
 * @returns Parsed OCR result, or null if the worker failed to load
 *   (e.g. missing traineddata / CSP block).
 */
export async function recognizeImage(imageUrl: string): Promise<OcrResult | null> {
  try {
    const w = await ensureWorker()
    scheduleTeardown()
    const { data } = await w.recognize(imageUrl)
    const text = (data.text ?? '').trim()
    return {
      text,
      confidence: data.confidence ?? 0,
      isEmpty: text.length < 15,
    }
  } catch (err) {
    console.warn('OCR recognition failed:', err)
    return null
  }
}

/**
 * Force-teardown the worker (e.g. on logout, before unmount). Safe to
 * call multiple times. The worker is recreated on the next recognizeImage call.
 */
export function teardownWorker(): void {
  void terminateWorker()
}
