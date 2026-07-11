/**
 * src/renderer/features/composer/voiceInput.ts
 *
 * Thin, testable wrapper around the Web Speech API (`SpeechRecognition` /
 * `webkitSpeechRecognition`).
 *
 * Why Web Speech API over Whisper/local: zero API key, zero per-minute cost,
 * already inside WKWebView / Edge WebView2 — good fit for a QW1 quick-win.
 * The trade-off is platform support: macOS WKWebView usually defers to the
 * system dictation pipeline; Linux WebKitGTK STT can be missing. UI must
 * degrade gracefully (see detectSupport), and the macOS bundle needs
 * `NSMicrophoneUsageDescription` declared in tauri.conf.json.
 */

/** Minimal shape of the Web Speech API recognition object — narrowly typed
 *  so tests can inject a fake without depending on `lib.dom.d.ts`. */
export interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives?: number
  start(): void
  stop(): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onresult: ((event: any) => void) | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((event: any) => void) | null
  onend: (() => void) | null
}

type RecognitionCtor = new () => RecognitionLike

/** Returns the platform's SpeechRecognition constructor if available. */
export function getSpeechRecognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor
    webkitSpeechRecognition?: RecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

/** True when the current platform exposes any SpeechRecognition ctor.
 *  Use this to hide the mic button entirely when there is no fallback. */
export function detectSupport(): boolean {
  return Boolean(getSpeechRecognitionCtor())
}

/**
 * Pure helper: append a finalized transcript chunk to the existing composer
 * text. Adds exactly one space separator unless the existing text already
 * ends in whitespace (or is empty). Returns `previous` unchanged when
 * `addition` is empty after trimming — used by Composer.tsx to bail out
 * when a recognition event arrives with only whitespace.
 *
 * Exported pure so the multi-call chain can be unit-tested without the
 * React lifecycle: a stale `value` inside an `onFinal` closure used to
 * overwrite the latest composer text on the second final chunk.
 */
export function composeVoiceAppend(previous: string, addition: string): string {
  const trimmed = addition.trim()
  if (!trimmed) return previous
  const needsSeparator = previous.length > 0
    && !previous.endsWith(' ')
    && !previous.endsWith('\n')
    && !previous.endsWith('\t')
    && !previous.endsWith('\r')
  return previous + (needsSeparator ? ' ' : '') + trimmed
}

/** Display the interim transcript on top of the committed base text.
 *  Same separator logic as composeVoiceAppend — the difference is
 *  semantic: this is for DISPLAY ONLY, the caller does NOT commit
 *  the result to the stable base. The interim is replaced by the next
 *  final or interim event. */
export function applyVoiceInterim(committed: string, interim: string): string {
  return composeVoiceAppend(committed, interim)
}

/** Commit a final transcript chunk to the stable base. Returns the new
 *  committed text — the caller should update both the ref and the
 *  composer value. */
export function commitVoiceFinal(committed: string, final: string): string {
  return composeVoiceAppend(committed, final)
}

/** Catch-up step for the voice typewriter. Given the current displayed text
 *  and a longer target, returns the next text to display. Chars are added
 *  per frame at a fluid ~4–6 chars/frame (240–360 cps) — NOT a percentage
 *  of the gap (which makes medium gaps look chunky).
 *
 *  The graduated rate table keeps small gaps crisp (2/frame), medium gaps
 *  smooth (3–4/frame), and large gaps from stalling (5–6/frame). Target
 *  unchanged when equal or shorter (delete/backspace). Gaps ≤ 3 snap
 *  instantly — imperceptible at 60 fps.
 *
 *  Usage: call in a requestAnimationFrame loop. When the target changes
 *  (new interim/final), interrupt the running loop and restart. */
export function nextCatchUpStep(
  current: string,
  target: string,
  options?: { maxCharsPerFrame?: number },
): string {
  if (current === target) return target
  const gap = target.length - current.length
  // Gap ≤ 0 means the target shrank (new interim is shorter or the user
  // backspaced) or the target changed its prefix — snap immediately
  // rather than trying to animate a delete.
  if (gap <= 0) return target
  // Gap 1–3 is imperceptible at 60 fps → snap.
  if (gap <= 3) return target
  const max = options?.maxCharsPerFrame ?? 6
  // Graduated rate: tiny=2, small=3, medium=4, large=5, huge=max(6)
  const charsThisFrame =
    gap <= 15 ? 2 :
    gap <= 40 ? 3 :
    gap <= 80 ? 4 :
    gap <= 140 ? 5 :
    Math.min(max, Math.ceil(gap * 0.04))
  return target.slice(0, current.length + charsThisFrame)
}

/** Fatal error codes that should NOT trigger auto-restart. These represent
 *  permission or hardware failures that won't recover by retrying. */
export function isFatalVoiceError(code: string | undefined): boolean {
  return code === 'not-allowed'
    || code === 'service-not-allowed'
    || code === 'audio-capture'
}

/** Pick the alternative with the highest confidence. Falls back to
 *  index 0 when confidence is unavailable (some implementations don't
 *  expose it or return NaN). Used to improve transcription quality
 *  when maxAlternatives is set above 1. */
export function pickBestAlternative(result: {
  isFinal: boolean
  length: number
  [index: number]: { transcript: string; confidence?: number }
}): string {
  let bestTranscript = String(result[0]?.transcript ?? '')
  let bestConfidence = -Infinity
  for (let j = 0; j < result.length; j++) {
    const alt = result[j]
    const conf = typeof alt.confidence === 'number' && !Number.isNaN(alt.confidence)
      ? alt.confidence
      : -Infinity
    if (conf > bestConfidence) {
      bestTranscript = String(alt.transcript ?? '')
      bestConfidence = conf
    }
  }
  return bestTranscript
}

export type VoiceInputCallbacks = {
  /** Final transcript (trimmed, non-empty). */
  onFinal?: (text: string) => void
  /** Latest interim transcript (trimmed). Fires while the user is still
   *  speaking; the final transcript eventually replaces it. */
  onInterim?: (text: string) => void
  /** Called when the recognition surface signals an error. */
  onError?: (info: { message: string; code?: string }) => void
  /** Called when the browser stops the session (timeout, manual stop,
   *  network loss, etc.). isListening() returns false after this fires. */
  onEnd?: () => void
  /** Called immediately after recognition.start() resolves. */
  onStart?: () => void
}

export type VoiceInputOptions = VoiceInputCallbacks & {
  /** BCP-47 language tag passed straight to SpeechRecognition.lang. */
  lang?: string
  /** Override the recognition instance (used by tests). When omitted, the
   *  module instantiates the platform constructor via getSpeechRecognitionCtor. */
  recognitionFactory?: () => RecognitionLike
}

export type VoiceInputHandle = {
  isSupported: boolean
  isListening: () => boolean
  /** Returns true on a successful start, false when not supported, already
   *  listening, or when start() throws. */
  start: () => boolean
  /** Stops the active session if any. Safe to call multiple times. */
  stop: () => void
}

/**
 * Creates a voice input handle that bridges the Web Speech API into the
 * shape we need (final chunks + optional interim + error/end signals).
 *
 * Callers are responsible for the UI lifecycle — `stop()` should be invoked
 * on unmount, route change, or whenever the composer becomes irrelevant.
 */
export function createVoiceInput(options: VoiceInputOptions = {}): VoiceInputHandle {
  const isSupported = detectSupport()
  let recognition: RecognitionLike | undefined
  let listening = false
  // wantsListening: the user's intent. True while the user wants the mic
  // active. Set true on start(), false on stop(). Auto-restart checks this
  // to decide whether to re-fire start() after an unsolicited onend.
  let wantsListening = false
  // fatal: set true when onerror fires with a code that won't recover
  // by retrying (permission/hardware). Prevents infinite restart loops.
  let fatal = false

  function attach(rec: RecognitionLike) {
    rec.lang = options.lang ?? 'en-US'
    // Continuous so the user can dictate multiple sentences in a row.
    rec.continuous = true
    // Enable interimResults whenever the consumer subscribed to them.
    rec.interimResults = Boolean(options.onInterim)
    // Request up to 3 alternatives so we can pick the one with the highest
    // confidence. Some implementations ignore this or don't expose
    // confidence; pickBestAlternative falls back to index 0 in that case.
    try { rec.maxAlternatives = 3 } catch { /* read-only on some impls */ }
    rec.onresult = (event: {
      resultIndex?: number
      results: ArrayLike<{
        isFinal: boolean
        length: number
        [index: number]: { transcript: string; confidence?: number }
      }>
    }) => {
      let interimAcc = ''
      const start = event.resultIndex ?? 0
      for (let i = start; i < event.results.length; i++) {
        const result = event.results[i]
        const transcript = pickBestAlternative(result)
        if (result.isFinal) {
          const finalText = transcript.trim()
          if (finalText) options.onFinal?.(finalText)
        } else {
          interimAcc += transcript
        }
      }
      if (options.onInterim) {
        const interim = interimAcc.trim()
        if (interim) options.onInterim(interim)
      }
    }
    rec.onerror = (event: { error?: string; message?: string }) => {
      const code = event.error
      if (isFatalVoiceError(code)) {
        fatal = true
        wantsListening = false
      }
      const message = String(event.message ?? event.error ?? 'unknown voice error')
      options.onError?.({ message, code })
    }
    rec.onend = () => {
      if (wantsListening && !fatal) {
        // Auto-restart: WKWebView often ends the session early (silence
        // timeout, internal throttling). The user still wants to listen,
        // so restart transparently — don't call onEnd, the consumer
        // shouldn't see the session as ended.
        try {
          rec.start()
          return
        } catch {
          // start() threw (e.g., invalid state) — give up gracefully
          // and signal the end to the consumer.
        }
      }
      listening = false
      options.onEnd?.()
    }
  }

  function start(): boolean {
    if (listening) return false
    if (!options.recognitionFactory && !isSupported) return false
    try {
      recognition = options.recognitionFactory
        ? options.recognitionFactory()
        : (() => {
            const Ctor = getSpeechRecognitionCtor()
            if (!Ctor) throw new Error('SpeechRecognition is not available')
            return new Ctor()
          })()
      fatal = false
      wantsListening = true
      attach(recognition)
      recognition.start()
      listening = true
      options.onStart?.()
      return true
    } catch (err) {
      listening = false
      wantsListening = false
      const message = err instanceof Error ? err.message : String(err)
      options.onError?.({ message })
      return false
    }
  }

  function stop(): void {
    wantsListening = false
    if (!recognition) return
    try {
      recognition.stop()
    } catch {
      // Calling stop() after the session already ended can throw on some
      // implementations — swallow and rely on onend to mark not-listening.
    }
  }

  return {
    isSupported,
    isListening: () => listening,
    start,
    stop,
  }
}
