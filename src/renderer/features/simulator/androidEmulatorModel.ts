import type { AndroidDevice, AndroidEmulatorSetupStep } from './androidEmulatorApi'

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

// ── F1: device picker + stream defaults (PA-27) ────────────────────────────

/** Renderer-side stream defaults for android_emulator_attach. The preview is
 *  an `adb exec-out screencap` PNG loop — far slower than the iOS MJPEG
 *  stream, hence modest rates (the backend is free to clamp). */
export const DEFAULT_ANDROID_EMULATOR_STREAM_FPS = 2
export const DEFAULT_ANDROID_EMULATOR_FALLBACK_FPS = 1

export type AndroidDeviceFamilyFilter = 'all' | 'phone' | 'tablet'

export type AndroidEmulatorDeviceGroup = {
  /** 'running' for the running-devices group, otherwise `${family}:${apiLevel}`. */
  key: string
  devices: AndroidDevice[]
}

const ANDROID_DEVICE_FAMILY_ORDER: Record<AndroidDevice['family'], number> = {
  phone: 0,
  tablet: 1,
  other: 2,
}

/** Picker grouping (PA-27): running devices first, then family (phone →
 *  tablet → other), then apiLevel descending — mirrors the iOS
 *  groupSimulatorDevices policy on the AndroidDevice shape. */
export function groupAndroidEmulatorDevices(
  devices: readonly AndroidDevice[],
  filter: AndroidDeviceFamilyFilter,
  query: string,
): AndroidEmulatorDeviceGroup[] {
  const needle = query.trim().toLocaleLowerCase()
  const visible = devices
    .filter(device => filter === 'all' || device.family === filter)
    .filter(device => !needle
      || `${androidDeviceDisplayLabel(device)} ${device.displayName} ${device.avdName} ${device.apiLevel}`
        .toLocaleLowerCase().includes(needle))
    .slice()
    .sort((left, right) => {
      const runningOrder = Number(right.running) - Number(left.running)
      return runningOrder
        || ANDROID_DEVICE_FAMILY_ORDER[left.family] - ANDROID_DEVICE_FAMILY_ORDER[right.family]
        || right.apiLevel - left.apiLevel
        || left.displayName.localeCompare(right.displayName)
        || left.avdName.localeCompare(right.avdName)
    })
  const groups = new Map<string, AndroidEmulatorDeviceGroup>()
  for (const device of visible) {
    const key = device.running ? 'running' : `${device.family}:${device.apiLevel}`
    const group = groups.get(key) ?? { key, devices: [] }
    group.devices.push(device)
    groups.set(key, group)
  }
  return [...groups.values()]
}

// ── PA-36: friendly AVD presentation ───────────────────────────────────────

/** Human-readable label for a raw AVD name (PA-36). The backend sends
 *  `displayName = avdName` verbatim (e.g. 'Verboo_Device_API_36'), which is
 *  unusable as UI text. Generic rule — nothing is hardcoded to the bundled
 *  AVD, so user-created AVDs format the same way: `_`/`-` runs collapse to
 *  single spaces (original casing preserved), and a trailing standalone API
 *  token normalizes to ` · API NN`. The `\b` keeps names that merely CONTAIN
 *  'api' (e.g. 'Capivara_2') from being mistaken for an API suffix. */
export function formatAndroidAvdDisplayName(avdName: string): string {
  const spaced = avdName.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  const apiMatch = /\bAPI\s*(\d+)$/i.exec(spaced)
  if (!apiMatch) return spaced
  const base = spaced.slice(0, apiMatch.index).trim()
  return base ? `${base} · API ${apiMatch[1]}` : `API ${apiMatch[1]}`
}

/** What the UI shows for a device (PA-36): a real backend displayName wins;
 *  when the backend just echoes the raw avdName, humanize it (mirrors
 *  readableModelName in ModelSelector). The raw avdName stays the selection
 *  value + search key and surfaces as the tooltip. */
export function androidDeviceDisplayLabel(device: AndroidDevice): string {
  if (device.displayName && device.displayName !== device.avdName) return device.displayName
  return formatAndroidAvdDisplayName(device.avdName)
}
