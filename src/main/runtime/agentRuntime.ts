import type {
  AgentEvent,
  AgentTurnRequest,
  CliAuthStatus,
  GoalEvaluationInput,
  GoalEvaluationResult,
  LoginResult,
  ModelDiscoveryResult,
  UserSettings,
} from '../../shared/types'

export type AgentEventHandler = (event: AgentEvent) => void

export type GoalEvaluationOutput = {
  evaluation: GoalEvaluationResult
  userMessage?: string
}

export interface AgentTurnExecutor {
  sendTurn(
    request: AgentTurnRequest,
    onEvent: AgentEventHandler,
    settings?: UserSettings,
    resumeSessionId?: string,
  ): Promise<string>
  interrupt(): void
}

export interface AgentRuntime extends AgentTurnExecutor {
  startLogin(): Promise<LoginResult>
  logout(): Promise<LoginResult>
  getAuthStatus(): Promise<CliAuthStatus>
  listModels(forceRefresh?: boolean): Promise<ModelDiscoveryResult>
  evaluateGoal(input: GoalEvaluationInput): Promise<GoalEvaluationOutput>
  createTurnExecutor(): AgentTurnExecutor
}
