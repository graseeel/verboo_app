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
  return previous + (needsSeparator ? ' ' : '') + trimmed
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

  function attach(rec: RecognitionLike) {
    rec.lang = options.lang ?? 'en-US'
    // Continuous so the user can dictate multiple sentences in a row.
    rec.continuous = true
    // Enable interimResults whenever the consumer subscribed to them.
    rec.interimResults = Boolean(options.onInterim)
    rec.onresult = (event: {
      resultIndex?: number
      results: ArrayLike<{
        isFinal: boolean
        0: { transcript: string }
      }>
    }) => {
      let interimAcc = ''
      const start = event.resultIndex ?? 0
      for (let i = start; i < event.results.length; i++) {
        const result = event.results[i]
        const transcript = String(result[0].transcript ?? '')
        if (result.isFinal) {
          const final = transcript.trim()
          if (final) options.onFinal?.(final)
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
      const message = String(event.message ?? event.error ?? 'unknown voice error')
      options.onError?.({ message, code: event.error })
    }
    rec.onend = () => {
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
      attach(recognition)
      recognition.start()
      listening = true
      options.onStart?.()
      return true
    } catch (err) {
      listening = false
      const message = err instanceof Error ? err.message : String(err)
      options.onError?.({ message })
      return false
    }
  }

  function stop(): void {
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
