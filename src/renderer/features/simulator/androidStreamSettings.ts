import { normalizeAndroidStreamFps } from './androidEmulatorModel'

export type AndroidStreamSettingsBridge = {
  getUserSettings(): Promise<{ androidStreamFps?: number }>
  updateUserSettings(patch: { androidStreamFps: 30 | 60 }): Promise<unknown>
}

export function resolveStoredStreamFps(stored: unknown): 30 | 60 {
  return normalizeAndroidStreamFps(stored)
}

export async function loadPersistedStreamFps(
  bridge: AndroidStreamSettingsBridge,
): Promise<30 | 60> {
  try {
    return resolveStoredStreamFps((await bridge.getUserSettings()).androidStreamFps)
  } catch {
    return 60
  }
}

export async function persistStreamFps(
  bridge: AndroidStreamSettingsBridge,
  value: 30 | 60,
): Promise<boolean> {
  try {
    await bridge.updateUserSettings({ androidStreamFps: value })
    return true
  } catch {
    return false
  }
}
