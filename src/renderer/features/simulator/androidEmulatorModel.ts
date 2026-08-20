import type { AndroidEmulatorSetupStep } from './androidEmulatorApi'

/**
 * Android emulator domain model (PA-25, contract `contrato-android-simulator`
 * — frozen vocabulary 2026-08-19, APROVADO pelo usuário; names verbatim,
 * do not rename. Renames only by Maestro decision).
 *
 * Mirrors the iosSimulatorModel split: the issue/step ids live here (the api
 * imports them), along with the pure policy the onboarding needs — which
 * issues the automatic path can fix, how to classify an old backend, and the
 * approximate download sizes shown on the mandatory confirmation card.
 */

export type AndroidEmulatorIssue =
  | 'unsupportedPlatform'
  | 'sdkMissing'
  | 'adbMissing'
  | 'emulatorMissing'
  | 'systemImageMissing'
  | 'avdMissing'
  | 'accelMissing'
  | 'licensesNotAccepted'
  | 'discoveryFailed'

/** Frozen issue ids (contract §Deteccao) — load-bearing, do not reorder. */
export const ANDROID_EMULATOR_ISSUES: readonly AndroidEmulatorIssue[] = [
  'unsupportedPlatform',
  'sdkMissing',
  'adbMissing',
  'emulatorMissing',
  'systemImageMissing',
  'avdMissing',
  'accelMissing',
  'licensesNotAccepted',
  'discoveryFailed',
]

export function isAndroidEmulatorIssue(value: unknown): value is AndroidEmulatorIssue {
  return typeof value === 'string' && (ANDROID_EMULATOR_ISSUES as readonly string[]).includes(value)
}

export function androidEmulatorIssueMessageKey(issue: AndroidEmulatorIssue): string {
  return `androidEmulator.requirements.${issue}`
}

/** Frozen setup steps (contract §Steps de setup) — load-bearing. */
export const ANDROID_EMULATOR_SETUP_STEPS: readonly AndroidEmulatorSetupStep[] = [
  'downloadTools',
  'acceptLicenses',
  'installPackages',
  'downloadSystemImage',
  'createAvd',
  'enableAccel',
  'verify',
]

export function isAndroidEmulatorSetupStep(value: unknown): value is AndroidEmulatorSetupStep {
  return typeof value === 'string'
    && (ANDROID_EMULATOR_SETUP_STEPS as readonly string[]).includes(value)
}

export function androidEmulatorSetupStepMessageKey(step: AndroidEmulatorSetupStep): string {
  return `androidEmulator.onboarding.step.${step}`
}

// Issues for which the choice screen offers the automatic path.
// unsupportedPlatform/discoveryFailed have no automatic path; accelMissing is
// manual-only by design (contract §Onboarding: enabling WHPX needs admin + a
// reboot, the kvm group needs a re-login) — the setup worker STOPS at
// enableAccel and setup-done { issue: 'accelMissing' } lands the user on the
// manual guide for that step.
export const ANDROID_EMULATOR_AUTO_CAPABLE_ISSUES: readonly AndroidEmulatorIssue[] = [
  'sdkMissing',
  'adbMissing',
  'emulatorMissing',
  'systemImageMissing',
  'avdMissing',
  'licensesNotAccepted',
]

/** Older backends reject unregistered commands with an unknown-command /
 *  not-found error; anything else (e.g. "setup already running") is a REAL
 *  failure of a backend that does support the contract. Same semantics as
 *  the iOS onboarding helper (kept per-platform — the shared-infra refactor
 *  is registered future debt, not this task). */
export function isUnknownCommandError(err: unknown): boolean {
  const text = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
  return /unknown command|not found/i.test(text)
}

export function errorText(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined
  const text = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
  return text || undefined
}
