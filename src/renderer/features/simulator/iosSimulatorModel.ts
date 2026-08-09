import type { IosSimulatorDevice, IosSimulatorStartupStage } from './iosSimulatorApi'

export const IOS_SIMULATOR_STREAM_RATES = [30, 60] as const
export const IOS_SIMULATOR_FALLBACK_RATES = [0.5, 1, 2] as const
export const DEFAULT_SIMULATOR_STREAM_FPS = 30
export const DEFAULT_SIMULATOR_FALLBACK_FPS = 2

export type SimulatorIssue =
  | 'unsupportedPlatform'
  | 'xcodeMissing'
  | 'unsupportedXcode'
  | 'simctlMissing'
  | 'simulatorsMissing'
  | 'discoveryFailed'

export function formatSimulatorState(state: string): string {
  if (state === 'Booted') return 'simulator.state.booted'
  if (state === 'Shutdown') return 'simulator.state.shutdown'
  return 'simulator.state.creating'
}

export function simulatorIssueMessageKey(issue: SimulatorIssue): string {
  return `simulator.requirements.${issue}`
}

export function simulatorStageMessageKey(stage: IosSimulatorStartupStage): string {
  return {
    idle: 'simulator.stage.idle',
    booting: 'simulator.stage.booting',
    waitingForDisplay: 'simulator.stage.waitingForDisplay',
    generatingFirstPreview: 'simulator.stage.generatingFirstPreview',
    preparingInteraction: 'simulator.stage.preparingInteraction',
    ready: 'simulator.stage.ready',
  }[stage]
}

export type DeviceFamilyFilter = 'all' | 'iphone' | 'ipad'
export type SimulatorDeviceGroup = {
  key: string
  label: string
  devices: IosSimulatorDevice[]
}

export function groupSimulatorDevices(
  devices: readonly IosSimulatorDevice[],
  filter: DeviceFamilyFilter,
  query: string,
): SimulatorDeviceGroup[] {
  const needle = query.trim().toLocaleLowerCase()
  const visible = devices
    .filter(device => filter === 'all' || device.family === filter)
    .filter(device => !needle || `${device.name} ${device.iosVersion}`.toLocaleLowerCase().includes(needle))
    .slice()
    .sort((left, right) => {
      const bootOrder = Number(right.state === 'Booted') - Number(left.state === 'Booted')
      return bootOrder
        || left.family.localeCompare(right.family)
        || right.iosVersion.localeCompare(left.iosVersion, undefined, { numeric: true })
        || left.name.localeCompare(right.name)
        || left.udid.localeCompare(right.udid)
    })
  const groups = new Map<string, SimulatorDeviceGroup>()
  for (const device of visible) {
    const key = device.state === 'Booted' ? 'booted' : `${device.family}:${device.iosVersion}`
    const group = groups.get(key) ?? { key, label: key, devices: [] }
    group.devices.push(device)
    groups.set(key, group)
  }
  return [...groups.values()]
}
