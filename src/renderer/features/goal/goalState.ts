import type { AccessMode, GoalState, SkillSummary, TranscriptItem } from '../../../shared/types'

type CreateGoalInput = {
  objective: string
  accessMode: AccessMode
  modelId?: string
  modelDisplayName?: string
  workingDirectory: string
  skills: SkillSummary[]
  /** From UserSettings.goalMode — clamp to the same bounds as the settings UI. */
  maxTurns?: number
  maxElapsedMinutes?: number
}

export function createGoalState(input: CreateGoalInput): GoalState {
  const now = Date.now()
  const maxTurns = clampInt(input.maxTurns ?? 3, 1, 20)
  const maxElapsedMinutes = clampInt(input.maxElapsedMinutes ?? 30, 1, 240)
  return {
    id: `goal:${crypto.randomUUID()}`,
    objective: input.objective.trim(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    turnsRun: 0,
    maxTurns,
    maxElapsedMs: maxElapsedMinutes * 60 * 1000,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    accessMode: input.accessMode,
    modelId: input.modelId,
    modelDisplayName: input.modelDisplayName,
    workingDirectory: input.workingDirectory,
    skills: input.skills,
    noProgressCount: 0,
    recentFingerprints: [],
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.round(Math.max(min, Math.min(max, value)))
}

export function goalSystemMessage(text: string): TranscriptItem {
  return {
    id: `goal-system:${crypto.randomUUID()}`,
    role: 'system',
    text,
    timestamp: Date.now(),
  }
}
