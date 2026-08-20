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
import type { AndroidDevice } from './androidEmulatorApi'
import {
  ANDROID_EMULATOR_AUTO_CAPABLE_ISSUES,
  ANDROID_EMULATOR_ISSUES,
  ANDROID_EMULATOR_SETUP_STEPS,
  DEFAULT_ANDROID_EMULATOR_FALLBACK_FPS,
  DEFAULT_ANDROID_EMULATOR_STREAM_FPS,
  androidDeviceDisplayLabel,
  androidEmulatorIssueMessageKey,
  androidEmulatorSetupStepMessageKey,
  errorText,
  formatAndroidAvdDisplayName,
  groupAndroidEmulatorDevices,
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


// ── PA-27: picker grouping + stream defaults ───────────────────────────────

describe('androidEmulatorModel — device picker grouping (PA-27)', () => {
  const pixel8: AndroidDevice = {
    avdName: 'Pixel_8_API_35', displayName: 'Pixel 8', apiLevel: 35, family: 'phone', running: false,
  }
  const pixelTablet: AndroidDevice = {
    avdName: 'Pixel_Tablet_API_34', displayName: 'Pixel Tablet', apiLevel: 34, family: 'tablet', running: false,
  }
  const pixel9Running: AndroidDevice = {
    avdName: 'Pixel_9_API_36', displayName: 'Pixel 9', apiLevel: 36, family: 'phone', running: true,
  }
  const androidTv: AndroidDevice = {
    avdName: 'Android_TV_API_35', displayName: 'Android TV', apiLevel: 35, family: 'other', running: false,
  }

  it('keeps running devices first, then groups by family and descending apiLevel', () => {
    const groups = groupAndroidEmulatorDevices([pixel8, pixelTablet, pixel9Running], 'all', '')

    expect(groups.map(group => group.key)).toEqual(['running', 'phone:35', 'tablet:34'])
    expect(groups[0].devices.map(device => device.avdName)).toEqual(['Pixel_9_API_36'])
  })

  it('filters by family and by a free-text query over name/avd/apiLevel', () => {
    expect(
      groupAndroidEmulatorDevices([pixel8, pixelTablet], 'tablet', '').map(group => group.key),
    ).toEqual(['tablet:34'])
    expect(
      groupAndroidEmulatorDevices([pixel8, pixelTablet], 'all', '35').flatMap(group => group.devices),
    ).toEqual([pixel8])
    expect(groupAndroidEmulatorDevices([pixel8], 'all', 'galaxy')).toEqual([])
  })

  it('orders phones by descending apiLevel inside the family groups', () => {
    const older: AndroidDevice = { ...pixel8, avdName: 'Pixel_8_API_31', apiLevel: 31 }
    const groups = groupAndroidEmulatorDevices([older, pixel8], 'all', '')

    expect(groups.map(group => group.key)).toEqual(['phone:35', 'phone:31'])
  })

  it('uses the frozen family order phone, tablet, other', () => {
    const groups = groupAndroidEmulatorDevices([androidTv, pixelTablet, pixel8], 'all', '')

    expect(groups.map(group => group.key)).toEqual(['phone:35', 'tablet:34', 'other:35'])
  })

  it('pins the renderer-side stream defaults for the screencap loop', () => {
    expect(DEFAULT_ANDROID_EMULATOR_STREAM_FPS).toBe(2)
    expect(DEFAULT_ANDROID_EMULATOR_FALLBACK_FPS).toBe(1)
  })
})


// ── PA-36: friendly AVD presentation ───────────────────────────────────────

describe('androidEmulatorModel — friendly AVD label (PA-36)', () => {
  it('humanizes the bundled-style AVD name with its API suffix', () => {
    expect(formatAndroidAvdDisplayName('Verboo_Device_API_36')).toBe('Verboo Device · API 36')
    expect(formatAndroidAvdDisplayName('Pixel_7_Pro_API_34')).toBe('Pixel 7 Pro · API 34')
    expect(formatAndroidAvdDisplayName('Pixel-8-API-35')).toBe('Pixel 8 · API 35')
  })

  it('formats third-party AVDs by the same generic rule (nothing hardcoded)', () => {
    expect(formatAndroidAvdDisplayName('Minha_AVD_de_Teste')).toBe('Minha AVD de Teste')
    expect(formatAndroidAvdDisplayName('galaxy_s23_ultra')).toBe('galaxy s23 ultra')
    expect(formatAndroidAvdDisplayName('myAvd')).toBe('myAvd')
  })

  it('normalizes the API token variants and tolerates noise', () => {
    expect(formatAndroidAvdDisplayName('Pixel_API36')).toBe('Pixel · API 36')
    expect(formatAndroidAvdDisplayName('Pixel_api_36')).toBe('Pixel · API 36')
    expect(formatAndroidAvdDisplayName('API_36')).toBe('API 36')
    expect(formatAndroidAvdDisplayName('Pixel__8___API__36')).toBe('Pixel 8 · API 36')
    expect(formatAndroidAvdDisplayName('  spaced_out  ')).toBe('spaced out')
    expect(formatAndroidAvdDisplayName('')).toBe('')
  })

  it('does not mistake names CONTAINING "api" for an API suffix', () => {
    expect(formatAndroidAvdDisplayName('Capivara_2')).toBe('Capivara 2')
    expect(formatAndroidAvdDisplayName('rapidtest')).toBe('rapidtest')
  })

  it('prefers a real backend displayName, humanizing only the echoed avdName', () => {
    const real: AndroidDevice = {
      avdName: 'Pixel_8_API_35', displayName: 'Pixel 8', apiLevel: 35, family: 'phone', running: false,
    }
    const echoed: AndroidDevice = {
      avdName: 'Verboo_Device_API_36', displayName: 'Verboo_Device_API_36', apiLevel: 36, family: 'phone', running: false,
    }
    expect(androidDeviceDisplayLabel(real)).toBe('Pixel 8')
    expect(androidDeviceDisplayLabel(echoed)).toBe('Verboo Device · API 36')
  })

  it('matches the picker search by the friendly label too', () => {
    const echoed: AndroidDevice = {
      avdName: 'Verboo_Device_API_36', displayName: 'Verboo_Device_API_36', apiLevel: 36, family: 'phone', running: false,
    }
    expect(groupAndroidEmulatorDevices([echoed], 'all', 'verboo device').flatMap(group => group.devices))
      .toEqual([echoed])
    expect(groupAndroidEmulatorDevices([echoed], 'all', 'verboo_device').flatMap(group => group.devices))
      .toEqual([echoed])
  })
})
