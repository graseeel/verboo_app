import type { AccessMode, GoalState, SkillSummary, TranscriptItem } from '../../../shared/types'

type CreateGoalInput = {
  objective: string
  accessMode: AccessMode
  modelId?: string
  modelDisplayName?: string
  workingDirectory: string
  skills: SkillSummary[]
}

export function createGoalState(input: CreateGoalInput): GoalState {
  const now = Date.now()
  return {
    id: `goal:${crypto.randomUUID()}`,
    objective: input.objective.trim(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    turnsRun: 0,
    maxTurns: 3,
    maxElapsedMs: 30 * 60 * 1000,
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

export function goalSystemMessage(text: string): TranscriptItem {
  return {
    id: `goal-system:${crypto.randomUUID()}`,
    role: 'system',
    text,
    timestamp: Date.now(),
  }
}
