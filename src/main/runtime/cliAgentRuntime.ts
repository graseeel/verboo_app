import type { GoalEvaluationInput } from '../../shared/types'
import type { CredentialsStore } from '../services/credentialsStore'
import { evaluateGoal } from '../services/goalEvaluator'
import { ModelService } from '../services/modelService'
import { VerbooCliService } from '../services/verbooCliService'
import type { AgentEventHandler, AgentRuntime, AgentTurnExecutor, GoalEvaluationOutput } from './agentRuntime'

type CliAgentRuntimeOptions = {
  credentials: CredentialsStore
  modelService: ModelService
}

export class CliAgentRuntime implements AgentRuntime {
  private readonly cli: VerbooCliService
  private readonly credentials: CredentialsStore
  private readonly modelService: ModelService

  constructor(options: CliAgentRuntimeOptions) {
    this.credentials = options.credentials
    this.modelService = options.modelService
    this.cli = new VerbooCliService(options.credentials)
  }

  sendTurn: AgentRuntime['sendTurn'] = (request, onEvent: AgentEventHandler, settings, resumeSessionId) =>
    this.cli.sendTurn(request, onEvent, settings, resumeSessionId)

  interrupt(): void {
    this.cli.interrupt()
  }

  startLogin(): ReturnType<AgentRuntime['startLogin']> {
    return this.cli.startCliLogin()
  }

  logout(): ReturnType<AgentRuntime['logout']> {
    return this.cli.logout()
  }

  getAuthStatus(): ReturnType<AgentRuntime['getAuthStatus']> {
    return this.cli.getAuthStatus()
  }

  listModels(forceRefresh = false): ReturnType<AgentRuntime['listModels']> {
    return this.modelService.listModels(forceRefresh)
  }

  evaluateGoal(input: GoalEvaluationInput): Promise<GoalEvaluationOutput> {
    return evaluateGoal({
      goal: input.goal,
      conversationItems: input.conversationItems,
      latestResult: input.latestResult,
      workingDirectory: input.goal.workingDirectory,
    })
  }

  createTurnExecutor(): AgentTurnExecutor {
    return new VerbooCliService(this.credentials)
  }
}
