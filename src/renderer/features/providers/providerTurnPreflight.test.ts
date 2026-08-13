import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversation } from '../../state/chatStore'
import type { ProviderAccountSummary, VerbooModel } from '../../../shared/types'
import { preflightProviderTurn } from './providerTurnPreflight'
import { invalidateProviderModelsCache } from './providerModelValidation'

beforeEach(() => invalidateProviderModelsCache())

const accounts: ProviderAccountSummary[] = [
  {
    provider: 'codex',
    accountId: 'codex-a',
    displayLabel: 'Codex 1',
    isDefault: true,
    connectionState: 'connected',
    schemaVersion: 1,
  },
]

const capabilities = { providerAccountsV1: true, providerUsageV1: true }
const fetchModels = async (): Promise<VerbooModel[]> => [{ id: 'gpt-5', displayName: 'GPT-5', raw: {} }]
const conversation = (patch: Partial<ReturnType<typeof createConversation>> = {}) => ({
  ...createConversation(),
  ...patch,
})

describe('preflightProviderTurn', () => {
  it('does not gate built-in or legacy providers', async () => {
    await expect(preflightProviderTurn({
      provider: undefined,
      modelId: 'local',
      conversation: conversation(),
      capabilities,
      accounts,
      fetchModels,
    })).resolves.toEqual({ status: 'not-required' })
    await expect(preflightProviderTurn({
      provider: 'codex',
      modelId: 'gpt-5',
      conversation: conversation(),
      capabilities: { ...capabilities, providerAccountsV1: false },
      accounts,
      fetchModels,
    })).resolves.toEqual({ status: 'legacy' })
  })

  it('reports a removed historical binding instead of silently rebinding', async () => {
    await expect(preflightProviderTurn({
      provider: 'codex',
      modelId: 'gpt-5',
      conversation: conversation({ providerAccountBindings: { codex: 'gone' } }),
      capabilities,
      accounts,
      fetchModels,
    })).resolves.toEqual({ status: 'bound-account-missing', accountId: 'gone' })
  })

  it('fails closed when no account is connected or the model is unsupported', async () => {
    await expect(preflightProviderTurn({
      provider: 'claude',
      modelId: 'claude-opus',
      conversation: conversation(),
      capabilities,
      accounts,
      fetchModels,
    })).resolves.toMatchObject({ status: 'missing-account', provider: 'claude' })
    await expect(preflightProviderTurn({
      provider: 'codex',
      modelId: 'claude-opus',
      conversation: conversation(),
      capabilities,
      accounts,
      fetchModels: async () => [{ id: 'gpt-5', displayName: 'GPT-5', raw: {} }],
    })).resolves.toMatchObject({ status: 'blocked', provider: 'codex', accountId: 'codex-a' })
  })

  it('returns the account and fork decision only after validation succeeds', async () => {
    await expect(preflightProviderTurn({
      provider: 'codex',
      modelId: 'gpt-5',
      conversation: conversation({ cliSessionId: 'session-1' }),
      capabilities,
      accounts,
      fetchModels,
    })).resolves.toEqual({
      status: 'ready',
      account: { provider: 'codex', accountId: 'codex-a', forkSession: false },
      validation: 'available',
    })
  })

  // M1 — an old CLI without the `models` subcommand must NOT block the turn.
  // The renderer treats `provider_models_unsupported` as a missing capability
  // (pre-fail-closed behavior), not as a model that this account lacks.
  it('M1: allows the turn when the CLI reports models as unsupported', async () => {
    await expect(preflightProviderTurn({
      provider: 'codex',
      modelId: 'gpt-5',
      conversation: conversation({ providerAccountBindings: { codex: 'codex-a' } }),
      capabilities,
      accounts,
      fetchModels: vi.fn().mockRejectedValue(new Error('provider_models_unsupported')),
    })).resolves.toEqual({
      status: 'ready',
      account: { provider: 'codex', accountId: 'codex-a', forkSession: false },
      validation: 'unsupported',
    })
  })

  // M2 — the second preflight for the same provider:account must reuse the
  // cached model list instead of calling the bridge again.
  it('M2: the second preflight for the same account does not call the bridge again', async () => {
    const fetchModels = vi.fn().mockResolvedValue([{ id: 'gpt-5', displayName: 'GPT-5', raw: {} }])
    const args = {
      provider: 'codex' as const,
      modelId: 'gpt-5',
      conversation: conversation({ providerAccountBindings: { codex: 'codex-a' } }),
      capabilities,
      accounts,
      fetchModels,
    }
    await preflightProviderTurn(args)
    await preflightProviderTurn(args)
    expect(fetchModels).toHaveBeenCalledTimes(1)
  })
})
