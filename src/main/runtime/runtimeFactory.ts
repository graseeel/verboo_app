import type { CredentialsStore } from '../services/credentialsStore'
import type { ModelService } from '../services/modelService'
import type { AgentRuntime } from './agentRuntime'
import { CliAgentRuntime } from './cliAgentRuntime'

type RuntimeFactoryOptions = {
  credentials: CredentialsStore
  modelService: ModelService
}

const DEFAULT_RUNTIME = 'cli'

export function createAgentRuntime(options: RuntimeFactoryOptions): AgentRuntime {
  const requestedRuntime = (process.env.VERBOO_AGENT_RUNTIME || DEFAULT_RUNTIME).trim().toLowerCase()

  if (requestedRuntime !== DEFAULT_RUNTIME) {
    console.warn(
      `VERBOO_AGENT_RUNTIME=${requestedRuntime} ainda nao esta disponivel. Usando runtime CLI.`,
    )
  }

  return new CliAgentRuntime(options)
}
