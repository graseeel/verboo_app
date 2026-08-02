import type { CompletionNotificationMode } from '../../../shared/types'

/**
 * sounds.ts — the app's TWO sounds (user order, 2026-08-01).
 *
 * EXACTLY TWO SOUNDS — "APENAS ISSO, NADA MAIS" (the user's explicit
 * limit). A third sound is a defect by definition here, and the
 * soundContract test pins it (SoundKind has exactly two members and no
 * other file in the renderer may touch an oscillator).
 *
 *   - notification: the app NEEDS ATTENTION (a permission approval or
 *     a question is waiting). Two soft rising sines, ~200ms — a tap on
 *     the shoulder, not an alarm.
 *   - conclusion: the app FINISHED (a plain turn completed, or a goal /
 *     batch reached 'completed'). A warm C-major arpeggio, ~600ms —
 *     the user runs long batches and goes to sleep; this is how he
 *     knows it ended without looking at the screen. It must wake
 *     ATTENTION, never startle: sine-only (no harmonics harshness),
 *     12ms soft attack (no click), peak gain well under speech level.
 *
 * AUTOPSY OF THE LIMITS (declared, per house rule):
 *   - Autocontained by construction: the tones are SYNTHESIZED with the
 *     Web Audio API (Oscillator + Gain) — no audio file, no network,
 *     and Web Audio works in WKWebView (macOS), WebView2 (Windows) and
 *     WebKitGTK (Linux). No OS-specific API.
 *   - The OS volume/mute state is NOT READABLE from a WebView on any of
 *     the three platforms. "If the system is muted, don't play" is
 *     unimplementable honestly — the OFF switch we can guarantee is
 *     OURS (the soundsEnabled master toggle in Settings →
 *     Notifications), plus the per-type notification preferences below.
 *   - Autoplay policy: an AudioContext may start 'suspended' until the
 *     first user gesture. We register a one-time unlock listener on
 *     creation and attempt resume() on every play. A sound requested
 *     before ANY gesture in the session may be swallowed — in practice
 *     the user gestured to send the message that started the turn.
 *   - The sound itself is NOT VERIFIABLE in automated tests: jsdom has
 *     no audio device. Tests pin WHAT is scheduled (frequencies,
 *     envelopes, gain ceilings) and WHEN (the gate) — the audible
 *     result is field-proven only.
 */

export type SoundKind = 'notification' | 'conclusion'

/** Events that may produce a sound. Mapped onto the EXISTING
 *  notification preferences (integration, not a parallel system):
 *  completion events follow completionNotifications' always/background/
 *  never mode; attention events follow their own boolean prefs. All of
 *  it behind the soundsEnabled master switch. */
export type SoundEvent = 'turnCompleted' | 'goalCompleted' | 'permissionNeeded' | 'questionNeeded'

export type SoundGateSettings = {
  soundsEnabled: boolean
  completionNotifications: CompletionNotificationMode
  permissionNotifications: boolean
  questionNotifications: boolean
}

export type SoundGateContext = {
  /** The completion surfaced away from the user's eyes: background
   *  conversation OR unfocused window — same semantics the backend
   *  applies to the OS completion notification. */
  background: boolean
}

/** PURE gate: which sound (if any) an event produces. The wiring in
 *  App.tsx calls this at the four dispatch points; the tests cross the
 *  full matrix. */
export function resolveSoundForEvent(
  event: SoundEvent,
  settings: SoundGateSettings,
  context: SoundGateContext,
): SoundKind | null {
  if (!settings.soundsEnabled) return null
  switch (event) {
    case 'turnCompleted':
    case 'goalCompleted': {
      const mode = settings.completionNotifications
      if (mode === 'never') return null
      if (mode === 'background' && !context.background) return null
      return 'conclusion'
    }
    case 'permissionNeeded':
      return settings.permissionNotifications ? 'notification' : null
    case 'questionNeeded':
      return settings.questionNotifications ? 'notification' : null
  }
}

/* ── Synthesis ──────────────────────────────────────────────────────
 * One note = { frequency Hz, start offset s, duration s, peak gain }.
 * Envelope: 12ms linear attack (no click), exponential release. */

const ATTACK_S = 0.012
const RELEASE_FLOOR = 0.0001

/** "Nada muito exagerado": both sounds peak far under normal speech
 *  (~0.5). The contract test pins these ceilings. */
export const NOTIFICATION_PEAK_GAIN = 0.09
export const CONCLUSION_PEAK_GAIN = 0.12

type Tone = { frequency: number; startAt: number; duration: number; peak: number }

/** notification: A5 → D6, two short sines — a gentle "ahem". */
const NOTIFICATION_TONES: Tone[] = [
  { frequency: 880.0, startAt: 0, duration: 0.09, peak: NOTIFICATION_PEAK_GAIN },
  { frequency: 1174.66, startAt: 0.1, duration: 0.11, peak: NOTIFICATION_PEAK_GAIN },
]

/** conclusion: C5 → E5 → G5 arpeggio — warm, resolved, "done". */
const CONCLUSION_TONES: Tone[] = [
  { frequency: 523.25, startAt: 0, duration: 0.28, peak: CONCLUSION_PEAK_GAIN },
  { frequency: 659.25, startAt: 0.1, duration: 0.28, peak: CONCLUSION_PEAK_GAIN },
  { frequency: 783.99, startAt: 0.2, duration: 0.38, peak: CONCLUSION_PEAK_GAIN },
]

export type SoundPlayer = {
  play: (kind: SoundKind) => void
}

export type SoundPlayerOptions = {
  /** Injectable for tests (jsdom has no AudioContext). Defaults to the
   *  platform's unprefixed AudioContext — supported by all three
   *  WebViews; absence yields a player that is SILENT, never throws. */
  createContext?: () => AudioContext | null
}

function defaultCreateContext(): AudioContext | null {
  return typeof window !== 'undefined' && typeof window.AudioContext === 'function'
    ? new window.AudioContext()
    : null
}

export function createSoundPlayer(options?: SoundPlayerOptions): SoundPlayer {
  let context: AudioContext | null | undefined // undefined = not yet attempted

  const ensureContext = (): AudioContext | null => {
    if (context !== undefined) return context
    const factory = options?.createContext ?? defaultCreateContext
    context = factory()
    if (context && typeof document !== 'undefined') {
      // Autoplay unlock: the first gesture resumes a suspended context.
      const unlock = () => {
        void context?.resume().catch(() => undefined)
      }
      document.addEventListener('pointerdown', unlock, { once: true })
      document.addEventListener('keydown', unlock, { once: true })
    }
    return context
  }

  const play = (kind: SoundKind): void => {
    const audio = ensureContext()
    if (!audio) return
    if (audio.state === 'suspended') {
      // Scheduled tones hold while suspended and sound if the resume
      // lands; if the policy keeps it suspended, silence — respectful,
      // never an error.
      void audio.resume().catch(() => undefined)
    }
    const tones = kind === 'conclusion' ? CONCLUSION_TONES : NOTIFICATION_TONES
    const t0 = audio.currentTime + 0.02
    for (const tone of tones) {
      const start = t0 + tone.startAt
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(tone.frequency, start)
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(tone.peak, start + ATTACK_S)
      gain.gain.exponentialRampToValueAtTime(RELEASE_FLOOR, start + tone.duration)
      oscillator.connect(gain)
      gain.connect(audio.destination)
      oscillator.start(start)
      oscillator.stop(start + tone.duration + 0.05)
    }
  }

  return { play }
}
