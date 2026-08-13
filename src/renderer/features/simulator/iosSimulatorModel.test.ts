import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIMULATOR_STREAM_FPS,
  IOS_SIMULATOR_FALLBACK_RATES,
  IOS_SIMULATOR_STREAM_RATES,
  formatSimulatorState,
  groupSimulatorDevices,
  simulatorStageMessageKey,
  simulatorIssueMessageKey,
} from './iosSimulatorModel'
import type { IosSimulatorDevice } from './iosSimulatorApi'

describe('iOS simulator presentation model', () => {
  it('keeps high-fluency stream profiles separate from the low-cost fallback', () => {
    expect(IOS_SIMULATOR_STREAM_RATES).toEqual([30, 60])
    expect(IOS_SIMULATOR_FALLBACK_RATES).toEqual([0.5, 1, 2])
    expect(DEFAULT_SIMULATOR_STREAM_FPS).toBe(30)
  })

  it('presents device state without hiding unknown runtime values', () => {
    expect(formatSimulatorState('Booted')).toEqual('simulator.state.booted')
    expect(formatSimulatorState('Shutdown')).toEqual('simulator.state.shutdown')
    expect(formatSimulatorState('Creating')).toEqual('simulator.state.creating')
  })

  it('maps backend requirement issues to actionable UI copy', () => {
    expect(simulatorIssueMessageKey('xcodeMissing')).toBe('simulator.requirements.xcodeMissing')
    expect(simulatorIssueMessageKey('unsupportedXcode')).toBe('simulator.requirements.unsupportedXcode')
    expect(simulatorIssueMessageKey('simulatorsMissing')).toBe('simulator.requirements.simulatorsMissing')
  })

  it('maps every backend lifecycle stage to its renderer message key', () => {
    expect(simulatorStageMessageKey('idle')).toBe('simulator.stage.idle')
    expect(simulatorStageMessageKey('booting')).toBe('simulator.stage.booting')
    expect(simulatorStageMessageKey('waitingForDisplay')).toBe('simulator.stage.waitingForDisplay')
    expect(simulatorStageMessageKey('generatingFirstPreview')).toBe('simulator.stage.generatingFirstPreview')
    expect(simulatorStageMessageKey('preparingInteraction')).toBe('simulator.stage.preparingInteraction')
    expect(simulatorStageMessageKey('ready')).toBe('simulator.stage.ready')
  })

  it('groups filtered devices with booted devices first and stable runtime order', () => {
    const devices: IosSimulatorDevice[] = [
      { name: 'iPhone 17 Pro', udid: 'phone-17-pro', state: 'Shutdown', iosVersion: '27.0', family: 'iphone' },
      { name: 'iPad Pro', udid: 'ipad-pro', state: 'Booted', iosVersion: '26.5', family: 'ipad' },
      { name: 'iPhone Air', udid: 'iphone-air', state: 'Booted', iosVersion: '26.5', family: 'iphone' },
    ]

    expect(groupSimulatorDevices(devices, 'all', '').map(group => ({
      key: group.key,
      devices: group.devices.map(device => device.name),
    }))).toEqual([
      { key: 'booted', devices: ['iPad Pro', 'iPhone Air'] },
      { key: 'iphone:27.0', devices: ['iPhone 17 Pro'] },
    ])
  })
})
