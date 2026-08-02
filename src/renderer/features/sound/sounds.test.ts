import { describe, expect, it, vi } from 'vitest'

import {
  CONCLUSION_PEAK_GAIN,
  NOTIFICATION_PEAK_GAIN,
  createSoundPlayer,
  resolveSoundForEvent,
  type SoundEvent,
  type SoundGateSettings,
} from './sounds'
import { readSoundsEnabled, writeSoundsEnabled } from './soundStorage'

/**
 * sounds.ts — the app's TWO sounds (user's explicit limit: "APENAS
 * ISSO, NADA MAIS"). jsdom has no audio device, so these tests pin WHAT
 * is scheduled (frequencies, envelopes, gain ceilings) and WHEN (the
 * gate), never the audible result — that stays field-proven only, and
 * the limitation is declared in sounds.ts.
 */

/* ── Fake Web Audio graph, recording every scheduled node ── */

type FakeParam = {
  setValueAtTime: ReturnType<typeof vi.fn>
  linearRampToValueAtTime: ReturnType<typeof vi.fn>
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>
}
const param = (): FakeParam => ({
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn(),
})
type FakeOsc = { type: string; frequency: FakeParam; connect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
type FakeGain = { gain: FakeParam; connect: ReturnType<typeof vi.fn> }

function fakeAudioContext(state: 'running' | 'suspended' = 'running') {
  const oscillators: FakeOsc[] = []
  const gains: FakeGain[] = []
  const ctx = {
    state,
    currentTime: 0,
    destination: {},
    createOscillator: vi.fn(() => {
      const osc: FakeOsc = { type: '', frequency: param(), connect: vi.fn(), start: vi.fn(), stop: vi.fn() }
      oscillators.push(osc)
      return osc
    }),
    createGain: vi.fn(() => {
      const gain: FakeGain = { gain: param(), connect: vi.fn() }
      gains.push(gain)
      return gain
    }),
    resume: vi.fn(() => Promise.resolve()),
  }
  return { ctx: ctx as unknown as AudioContext, oscillators, gains }
}

const GATE: SoundGateSettings = {
  soundsEnabled: true,
  completionNotifications: 'background',
  permissionNotifications: true,
  questionNotifications: true,
}
const EVENTS: SoundEvent[] = ['turnCompleted', 'goalCompleted', 'permissionNeeded', 'questionNeeded']

describe('sounds: the player schedules the RIGHT tones', () => {
  it('conclusion is the warm C-major arpeggio — three sines, staggered, soft attack', () => {
    const { ctx, oscillators, gains } = fakeAudioContext()
    const player = createSoundPlayer({ createContext: () => ctx })
    player.play('conclusion')
    expect(oscillators).toHaveLength(3)
    expect(oscillators.map(o => o.frequency.setValueAtTime.mock.calls[0][0])).toEqual([
      523.25, 659.25, 783.99,
    ])
    for (const osc of oscillators) {
      expect(osc.type).toBe('sine') // no harmonics harshness — never startling
      expect(osc.start).toHaveBeenCalledTimes(1)
      expect(osc.stop).toHaveBeenCalledTimes(1)
    }
    for (const gain of gains) {
      // Soft attack from zero (no click), peak at the declared ceiling,
      // exponential release — "agradável, nada muito exagerado".
      expect(gain.gain.setValueAtTime.mock.calls[0][0]).toBe(0)
      expect(gain.gain.linearRampToValueAtTime.mock.calls[0][0]).toBe(CONCLUSION_PEAK_GAIN)
      expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalled()
    }
  })

  it('notification is the gentle two-note rise — shorter and quieter than the conclusion', () => {
    const { ctx, oscillators, gains } = fakeAudioContext()
    const player = createSoundPlayer({ createContext: () => ctx })
    player.play('notification')
    expect(oscillators).toHaveLength(2)
    expect(oscillators.map(o => o.frequency.setValueAtTime.mock.calls[0][0])).toEqual([
      880.0, 1174.66,
    ])
    for (const gain of gains) {
      expect(gain.gain.linearRampToValueAtTime.mock.calls[0][0]).toBe(NOTIFICATION_PEAK_GAIN)
    }
    expect(NOTIFICATION_PEAK_GAIN).toBeLessThan(CONCLUSION_PEAK_GAIN)
  })

  it('a suspended context is resumed AND the tones still schedule (they hold for the resume)', () => {
    const { ctx, oscillators } = fakeAudioContext('suspended')
    const player = createSoundPlayer({ createContext: () => ctx })
    player.play('conclusion')
    expect(ctx.resume).toHaveBeenCalled()
    expect(oscillators).toHaveLength(3)
  })

  it('NO AudioContext (autoplay-blocked or unsupported WebView): SILENT, never throws', () => {
    const player = createSoundPlayer({ createContext: () => null })
    expect(() => {
      player.play('notification')
      player.play('conclusion')
    }).not.toThrow()
  })
})

describe('sounds: the GATE fires on the right events and respects every off switch', () => {
  it('MASTER SWITCH OFF silences ALL four events — the guaranteed off', () => {
    for (const event of EVENTS) {
      expect(resolveSoundForEvent(event, { ...GATE, soundsEnabled: false }, { background: true })).toBeNull()
    }
  })

  it('turnCompleted follows completionNotifications: background mode sounds only in background', () => {
    expect(resolveSoundForEvent('turnCompleted', GATE, { background: true })).toBe('conclusion')
    // CONTRAFACTUAL: same settings, user watching the active conversation → silent.
    expect(resolveSoundForEvent('turnCompleted', GATE, { background: false })).toBeNull()
  })

  it("'always' sounds even in the foreground; 'never' is silent in any context", () => {
    expect(
      resolveSoundForEvent('turnCompleted', { ...GATE, completionNotifications: 'always' }, { background: false }),
    ).toBe('conclusion')
    for (const background of [true, false]) {
      expect(
        resolveSoundForEvent('turnCompleted', { ...GATE, completionNotifications: 'never' }, { background }),
      ).toBeNull()
    }
  })

  it('goalCompleted shares the completion semantics — one chime at the end of the batch', () => {
    expect(resolveSoundForEvent('goalCompleted', GATE, { background: true })).toBe('conclusion')
    expect(resolveSoundForEvent('goalCompleted', GATE, { background: false })).toBeNull()
    expect(
      resolveSoundForEvent('goalCompleted', { ...GATE, completionNotifications: 'never' }, { background: true }),
    ).toBeNull()
  })

  it('permissionNeeded follows permissionNotifications', () => {
    expect(resolveSoundForEvent('permissionNeeded', GATE, { background: false })).toBe('notification')
    expect(
      resolveSoundForEvent('permissionNeeded', { ...GATE, permissionNotifications: false }, { background: true }),
    ).toBeNull()
  })

  it('questionNeeded follows questionNotifications', () => {
    expect(resolveSoundForEvent('questionNeeded', GATE, { background: false })).toBe('notification')
    expect(
      resolveSoundForEvent('questionNeeded', { ...GATE, questionNotifications: false }, { background: true }),
    ).toBeNull()
  })

  it('NO THIRD SOUND: across the whole matrix the gate can only produce the two approved kinds', () => {
    const produced = new Set<string>()
    for (const event of EVENTS) {
      for (const mode of ['always', 'background', 'never'] as const) {
        for (const background of [true, false]) {
          const kind = resolveSoundForEvent(
            event,
            { ...GATE, completionNotifications: mode },
            { background },
          )
          if (kind) produced.add(kind)
        }
      }
    }
    expect([...produced].sort()).toEqual(['conclusion', 'notification'])
  })
})

describe('soundStorage: the master switch persists, default ON', () => {
  it('default is ON (the user asked for the sounds); a stored OFF reads back OFF', () => {
    window.localStorage.removeItem('verboo:sounds-enabled')
    expect(readSoundsEnabled()).toBe(true)
    writeSoundsEnabled(false)
    expect(readSoundsEnabled()).toBe(false)
    writeSoundsEnabled(true)
    expect(readSoundsEnabled()).toBe(true)
    window.localStorage.removeItem('verboo:sounds-enabled')
  })
})
