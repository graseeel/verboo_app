import type { AccessMode, GoalState, SkillSummary, TranscriptItem } from '../../../shared/types'

type CreateGoalInput = {
  objective: string
  accessMode: AccessMode
  modelId?: string
  modelDisplayName?: string
  workingDirectory: string
  skills: SkillSummary[]
  /**
   * Kept for backwards compatibility with callers that still pass
   * settings values, but no longer enforced — tokens and time are
   * unlimited. Defaults to Number.MAX_SAFE_INTEGER so the scheduler
   * never pauses on budget.
   */
  maxTurns?: number
  maxElapsedMinutes?: number
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
    // Unlimited — fields remain on GoalState for backwards compat but
    // are set to MAX_SAFE_INTEGER and never trigger a pause.
    maxTurns: Number.MAX_SAFE_INTEGER,
    maxElapsedMs: Number.MAX_SAFE_INTEGER,
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
