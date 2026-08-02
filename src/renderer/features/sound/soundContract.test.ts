import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { CONCLUSION_PEAK_GAIN, NOTIFICATION_PEAK_GAIN } from './sounds'

/**
 * soundContract — cross-file pins for the app's TWO sounds.
 *
 * The behavioral half lives in sounds.test.ts; these are SOURCE-TEXT
 * pins in the rustSerdeContract tradition, guarding what no DOM or
 * fake-context test can: the user's hard limit ("APENAS ISSO, NADA
 * MAIS" — exactly two sounds, no third one escaping), the "nada muito
 * exagerado" gain ceiling, and zero orphaned i18n keys.
 */

const RENDERER_ROOT = resolve(__dirname, '../..')
const SOUNDS_PATH = resolve(__dirname, 'sounds.ts')
const I18N_PATH = resolve(__dirname, '../../i18n.tsx')
const SETTINGS_VIEW_PATH = resolve(__dirname, '../settings/SettingsView.tsx')

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) yield full
  }
}

describe('soundContract: EXACTLY TWO sounds — no third one escapes', () => {
  it('SoundKind has exactly two members, pinned verbatim', () => {
    const source = readFileSync(SOUNDS_PATH, 'utf-8')
    expect(source).toContain("export type SoundKind = 'notification' | 'conclusion'")
  })

  it('NO oscillator or AudioContext outside sounds.ts — the two sounds have a single home', () => {
    const offenders: string[] = []
    for (const file of walk(RENDERER_ROOT)) {
      if (file === SOUNDS_PATH) continue
      const source = readFileSync(file, 'utf-8')
      if (/createOscillator|new AudioContext|OscillatorNode/.test(source)) {
        offenders.push(file)
      }
    }
    expect(offenders, `third-sound suspects: ${offenders.join(', ')}`).toEqual([])
  })

  it("'nada muito exagerado': both sounds peak FAR under normal speech level", () => {
    expect(NOTIFICATION_PEAK_GAIN).toBeLessThanOrEqual(0.2)
    expect(CONCLUSION_PEAK_GAIN).toBeLessThanOrEqual(0.2)
  })
})

describe('soundContract: i18n — the toggle keys exist in BOTH locales, never orphaned', () => {
  const i18n = readFileSync(I18N_PATH, 'utf-8')
  const settingsView = readFileSync(SETTINGS_VIEW_PATH, 'utf-8')

  for (const key of ['settings.sounds', 'settings.soundsBody']) {
    it(`'${key}' has exactly two locale entries (en-US + pt-BR)`, () => {
      const occurrences = i18n.match(new RegExp(`'${key.replace('.', '\\.')}'\\s*:`, 'g')) ?? []
      expect(occurrences, `'${key}' must exist exactly twice in i18n.tsx`).toHaveLength(2)
    })

    it(`'${key}' has a real t() consumer in SettingsView`, () => {
      expect(settingsView).toContain(`t('${key}')`)
    })
  }
})
