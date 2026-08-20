/**
 * Android emulator model tests (PA-25, contract `contrato-android-simulator`
 * — frozen vocabulary 2026-08-19, APROVADO; names verbatim, do not rename).
 *
 * Pins the renderer side of the frozen vocabulary: the 9 issue ids, the 7
 * setup steps, the auto-capable set (manual-only issues), and the
 * unknown-command fail-open classifier. The size/text shown on the
 * `awaiting` pause cards arrives in the event's `message` (display-only —
 * the renderer NEVER anchors logic on it, per the Maestro's contract
 * update), so there is no renderer-side size table here.
 */

import { describe, expect, it } from 'vitest'
import {
  ANDROID_EMULATOR_AUTO_CAPABLE_ISSUES,
  ANDROID_EMULATOR_ISSUES,
  ANDROID_EMULATOR_SETUP_STEPS,
  androidEmulatorIssueMessageKey,
  androidEmulatorSetupStepMessageKey,
  errorText,
  isAndroidEmulatorIssue,
  isAndroidEmulatorSetupStep,
  isUnknownCommandError,
} from './androidEmulatorModel'

describe('androidEmulatorModel — frozen issue vocabulary', () => {
  it('lists the 9 frozen issues verbatim (contract §Deteccao)', () => {
    expect(ANDROID_EMULATOR_ISSUES).toEqual([
      'unsupportedPlatform',
      'sdkMissing',
      'adbMissing',
      'emulatorMissing',
      'systemImageMissing',
      'avdMissing',
      'accelMissing',
      'licensesNotAccepted',
      'discoveryFailed',
    ])
  })

  it('maps every frozen issue to its i18n key', () => {
    for (const issue of ANDROID_EMULATOR_ISSUES) {
      expect(androidEmulatorIssueMessageKey(issue)).toBe(`androidEmulator.requirements.${issue}`)
    }
  })

  it('isAndroidEmulatorIssue accepts the frozen ids and rejects anything else', () => {
    for (const issue of ANDROID_EMULATOR_ISSUES) {
      expect(isAndroidEmulatorIssue(issue)).toBe(true)
    }
    expect(isAndroidEmulatorIssue('xcodeMissing')).toBe(false)
    expect(isAndroidEmulatorIssue('')).toBe(false)
    expect(isAndroidEmulatorIssue(undefined)).toBe(false)
    expect(isAndroidEmulatorIssue(null)).toBe(false)
    expect(isAndroidEmulatorIssue(42)).toBe(false)
  })
})

describe('androidEmulatorModel — frozen setup steps', () => {
  it('lists the 7 frozen steps verbatim (contract §Steps de setup)', () => {
    expect(ANDROID_EMULATOR_SETUP_STEPS).toEqual([
      'downloadTools',
      'acceptLicenses',
      'installPackages',
      'downloadSystemImage',
      'createAvd',
      'enableAccel',
      'verify',
    ])
  })

  it('maps every frozen step to its i18n key', () => {
    for (const step of ANDROID_EMULATOR_SETUP_STEPS) {
      expect(androidEmulatorSetupStepMessageKey(step)).toBe(`androidEmulator.onboarding.step.${step}`)
    }
  })

  it('isAndroidEmulatorSetupStep guards unknown backend additions', () => {
    for (const step of ANDROID_EMULATOR_SETUP_STEPS) {
      expect(isAndroidEmulatorSetupStep(step)).toBe(true)
    }
    // Solda may propose ADDITIONS — unknown steps are not in the frozen set
    // and the onboarding renders them by their raw id instead of an i18n key.
    expect(isAndroidEmulatorSetupStep('downloadEmulator')).toBe(false)
    expect(isAndroidEmulatorSetupStep(undefined)).toBe(false)
  })
})

describe('androidEmulatorModel — automatic-path policy', () => {
  it('offers the automatic path only for issues the setup worker can fix', () => {
    expect(ANDROID_EMULATOR_AUTO_CAPABLE_ISSUES).toEqual([
      'sdkMissing',
      'adbMissing',
      'emulatorMissing',
      'systemImageMissing',
      'avdMissing',
      'licensesNotAccepted',
    ])
    // Manual-only by design: unsupportedPlatform/discoveryFailed have no
    // automatic path; accelMissing needs admin/reboot (WHPX) or a re-login
    // (kvm group) — the worker STOPS at enableAccel and the guide takes over.
    expect(ANDROID_EMULATOR_AUTO_CAPABLE_ISSUES).not.toContain('accelMissing')
    expect(ANDROID_EMULATOR_AUTO_CAPABLE_ISSUES).not.toContain('unsupportedPlatform')
    expect(ANDROID_EMULATOR_AUTO_CAPABLE_ISSUES).not.toContain('discoveryFailed')
  })
})

describe('androidEmulatorModel — fail-open classifier', () => {
  it('recognizes old backends rejecting unregistered commands', () => {
    expect(isUnknownCommandError(new Error('Command android_emulator_setup_start not found'))).toBe(true)
    expect(isUnknownCommandError('unknown command')).toBe(true)
    expect(isUnknownCommandError(new Error('UNKNOWN COMMAND: android_emulator_requirements'))).toBe(true)
  })

  it('does NOT swallow real failures of a backend that honors the contract', () => {
    expect(isUnknownCommandError(new Error('an Android emulator setup is already running'))).toBe(false)
    expect(isUnknownCommandError('sdkmanager --licenses failed')).toBe(false)
  })

  it('errorText extracts a message from Error/string/unknown', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
    expect(errorText('')).toBeUndefined()
    expect(errorText(undefined)).toBeUndefined()
  })
})
