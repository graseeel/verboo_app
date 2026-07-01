import { app } from 'electron'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { UserSettings } from '../../shared/types'

export const defaultUserSettings: UserSettings = {
  defaultAccessMode: 'approval',
  fullAccessEnabled: false,
  lastSelectedModelId: undefined,
  showInMenuBar: true,
  showMenuBarText: true,
  staySignedIn: true,
  preventSleepWhileRunning: true,
  completionNotifications: 'background',
  permissionNotifications: true,
  questionNotifications: true,
  personality: 'pragmatic',
  customInstructions: '',
  trustedCommands: [],
  memoriesEnabled: false,
  chroniclePreview: false,
  ignoreToolChatsForMemory: true,
  goalMode: {
    enabled: true,
    maxTurns: 3,
    maxElapsedMinutes: 30,
    allowAutoAccess: true,
  },
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
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    await writeFile(this.filePath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    await chmod(this.filePath, 0o600)
    this.cache = next
    return next
  }

  async resetSettings(): Promise<UserSettings> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    await writeFile(this.filePath, JSON.stringify(defaultUserSettings, null, 2), { encoding: 'utf8', mode: 0o600 })
    await chmod(this.filePath, 0o600)
    this.cache = defaultUserSettings
    return defaultUserSettings
  }
}

function normalizeSettings(value: unknown): UserSettings {
  const record = isRecord(value) ? value : {}
  return {
    defaultAccessMode: normalizeAccessMode(
      record.defaultAccessMode,
      booleanValue(record.fullAccessEnabled, record.defaultAccessMode === 'full'),
    ),
    fullAccessEnabled: booleanValue(
      record.fullAccessEnabled,
      record.defaultAccessMode === 'full',
    ),
    lastSelectedModelId: normalizeOptionalString(record.lastSelectedModelId),
    showInMenuBar: booleanValue(record.showInMenuBar, defaultUserSettings.showInMenuBar),
    showMenuBarText: booleanValue(record.showMenuBarText, defaultUserSettings.showMenuBarText),
    staySignedIn: booleanValue(record.staySignedIn, defaultUserSettings.staySignedIn),
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
    trustedCommands: normalizeTrustedCommands(record.trustedCommands),
    memoriesEnabled: booleanValue(record.memoriesEnabled, defaultUserSettings.memoriesEnabled),
    chroniclePreview: booleanValue(record.chroniclePreview, defaultUserSettings.chroniclePreview),
    ignoreToolChatsForMemory: booleanValue(record.ignoreToolChatsForMemory, defaultUserSettings.ignoreToolChatsForMemory),
    goalMode: normalizeGoalMode(record.goalMode),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeAccessMode(value: unknown, enabled: boolean): UserSettings['defaultAccessMode'] {
  const mode = oneOf(value, ['approval', 'auto', 'full'], defaultUserSettings.defaultAccessMode)
  return mode === 'full' && !enabled ? 'approval' : mode
}

function oneOf<const T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && options.includes(value as T) ? value as T : fallback
}

function normalizeTrustedCommands(value: unknown): UserSettings['trustedCommands'] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map(item => {
      const command = typeof item.command === 'string' ? item.command.trim() : ''
      const id = typeof item.id === 'string' && item.id.trim() ? item.id : command
      const createdAt = Number(item.createdAt)
      const lastUsedAt = Number(item.lastUsedAt)
      const useCount = Number(item.useCount)
      return {
        id,
        command,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : undefined,
        useCount: Number.isFinite(useCount) ? Math.max(0, Math.round(useCount)) : 0,
      }
    })
    .filter(item => item.command)
}

function normalizeGoalMode(value: unknown): UserSettings['goalMode'] {
  const record = isRecord(value) ? value : {}
  return {
    enabled: booleanValue(record.enabled, true),
    maxTurns: clamp(Number(record.maxTurns) || 3, 1, 20),
    maxElapsedMinutes: clamp(Number(record.maxElapsedMinutes) || 30, 1, 240),
    allowAutoAccess: booleanValue(record.allowAutoAccess, true),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
