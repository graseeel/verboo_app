import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { UserSettings } from '../../shared/types'

export const defaultUserSettings: UserSettings = {
  defaultAccessMode: 'approval',
  showInMenuBar: true,
  showMenuBarText: true,
  preventSleepWhileRunning: true,
  completionNotifications: 'background',
  permissionNotifications: true,
  questionNotifications: true,
  personality: 'pragmatic',
  customInstructions: '',
  memoriesEnabled: false,
  chroniclePreview: false,
  ignoreToolChatsForMemory: true,
}

export class SettingsService {
  private readonly filePath = join(app.getPath('userData'), 'settings.json')
  private cache: UserSettings | undefined

  async getSettings(): Promise<UserSettings> {
    if (this.cache) return this.cache
    try {
      const raw = await readFile(this.filePath, 'utf8')
      this.cache = normalizeSettings(JSON.parse(raw))
    } catch {
      this.cache = defaultUserSettings
    }
    return this.cache
  }

  async updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
    const current = await this.getSettings()
    const next = normalizeSettings({ ...current, ...patch })
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(next, null, 2), 'utf8')
    this.cache = next
    return next
  }

  async resetSettings(): Promise<UserSettings> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(defaultUserSettings, null, 2), 'utf8')
    this.cache = defaultUserSettings
    return defaultUserSettings
  }
}

function normalizeSettings(value: unknown): UserSettings {
  const record = isRecord(value) ? value : {}
  return {
    defaultAccessMode: oneOf(record.defaultAccessMode, ['approval', 'auto', 'full'], defaultUserSettings.defaultAccessMode),
    showInMenuBar: booleanValue(record.showInMenuBar, defaultUserSettings.showInMenuBar),
    showMenuBarText: booleanValue(record.showMenuBarText, defaultUserSettings.showMenuBarText),
    preventSleepWhileRunning: booleanValue(record.preventSleepWhileRunning, defaultUserSettings.preventSleepWhileRunning),
    completionNotifications: oneOf(
      record.completionNotifications,
      ['always', 'background', 'never'],
      defaultUserSettings.completionNotifications,
    ),
    permissionNotifications: booleanValue(record.permissionNotifications, defaultUserSettings.permissionNotifications),
    questionNotifications: booleanValue(record.questionNotifications, defaultUserSettings.questionNotifications),
    personality: oneOf(record.personality, ['pragmatic', 'concise', 'explanatory'], defaultUserSettings.personality),
    customInstructions: typeof record.customInstructions === 'string' ? record.customInstructions : '',
    memoriesEnabled: booleanValue(record.memoriesEnabled, defaultUserSettings.memoriesEnabled),
    chroniclePreview: booleanValue(record.chroniclePreview, defaultUserSettings.chroniclePreview),
    ignoreToolChatsForMemory: booleanValue(record.ignoreToolChatsForMemory, defaultUserSettings.ignoreToolChatsForMemory),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function oneOf<const T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && options.includes(value as T) ? value as T : fallback
}
