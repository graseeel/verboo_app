import type {
  ExternalProviderId,
  ProviderAccountSummary,
  ProviderCapabilities,
  ProviderTurnAccount,
  StoredConversation,
  VerbooModel,
} from '../../../shared/types'
import { resolveProviderAccountForConversation } from './providerAccountBindings'
import {
  type ProviderModelValidation,
  validateProviderModelSelection,
} from './providerModelValidation'

export type ProviderTurnPreflightResult =
  | { status: 'not-required' | 'legacy' }
  | { status: 'bound-account-missing'; accountId: string }
  | { status: 'missing-account'; provider: ExternalProviderId; modelId: string }
  | {
      status: 'blocked'
      provider: ExternalProviderId
      accountId: string
      modelId: string
      validation: Exclude<ProviderModelValidation, 'available' | 'unsupported'>
    }
  | { status: 'ready'; account: ProviderTurnAccount; validation: 'available' | 'unsupported' }

export async function preflightProviderTurn({
  provider,
  modelId,
  conversation,
  capabilities,
  accounts,
  fetchModels,
}: {
  provider: ExternalProviderId | undefined
  modelId: string
  conversation: StoredConversation | undefined
  capabilities: ProviderCapabilities
  accounts: readonly ProviderAccountSummary[]
  fetchModels: (
    provider: Extract<ExternalProviderId, 'codex' | 'claude'>,
    accountId: string,
  ) => Promise<VerbooModel[]>
}): Promise<ProviderTurnPreflightResult> {
  if (provider !== 'codex' && provider !== 'claude') return { status: 'not-required' }
  if (!capabilities.providerAccountsV1) return { status: 'legacy' }

  const connectedAccountIds = new Set(
    accounts
      .filter(account => account.provider === provider)
      .map(account => account.accountId),
  )
  const boundAccountId = conversation?.providerAccountBindings?.[provider]
  if (boundAccountId && !connectedAccountIds.has(boundAccountId)) {
    return { status: 'bound-account-missing', accountId: boundAccountId }
  }
  const defaultAccountId = accounts.find(account =>
    account.provider === provider && account.isDefault,
  )?.accountId
  const account = resolveProviderAccountForConversation(
    conversation,
    provider,
    defaultAccountId,
    connectedAccountIds,
    capabilities,
  )
  if (!account) return { status: 'missing-account', provider, modelId }

  const validation = await validateProviderModelSelection(
    fetchModels,
    provider,
    account.accountId,
    modelId,
  )
  if (validation === 'unavailable' || validation === 'unknown') {
    return {
      status: 'blocked',
      provider,
      accountId: account.accountId,
      modelId,
      validation,
    }
  }
  return { status: 'ready', account, validation }
}
