import type {
  ExternalProviderId,
  ProviderCapabilities,
  ProviderAccountBindings,
  ProviderTurnAccount,
  StoredConversation,
} from '../../../shared/types'

export type ProviderTurnAccountResolution =
  | { status: 'ready'; accountId: string; forkSession: boolean; newlyBound: boolean }
  | { status: 'unresolved'; accountId: string }
  | { status: 'missing' }

/**
 * Resolve the account stamped on a provider turn. Keeping capability gating,
 * binding precedence, and session-fork detection together prevents callers
 * from independently reimplementing the provider lifecycle rules.
 */
export function resolveProviderAccountForConversation(
  conversation: StoredConversation | undefined,
  provider: ExternalProviderId,
  defaultAccountId: string | undefined,
  connectedAccountIds: ReadonlySet<string>,
  capabilities: Pick<ProviderCapabilities, 'providerAccountsV1'>,
): ProviderTurnAccount | undefined {
  if (!capabilities.providerAccountsV1) return undefined
  const resolution = resolveProviderTurnAccount(
    conversation,
    provider,
    defaultAccountId,
    connectedAccountIds,
  )
  if (resolution.status !== 'ready') return undefined
  return {
    provider,
    accountId: resolution.accountId,
    forkSession: resolution.forkSession,
  }
}

export function resolveProviderTurnAccount(
  conversation: StoredConversation | undefined,
  provider: ExternalProviderId,
  defaultAccountId: string | undefined,
  connectedAccountIds: ReadonlySet<string>,
): ProviderTurnAccountResolution {
  const bound = conversation?.providerAccountBindings?.[provider]
  const accountId = bound ?? defaultAccountId
  if (!accountId) return { status: 'missing' }
  if (!connectedAccountIds.has(accountId)) return { status: 'unresolved', accountId }
  const sessionAccount = conversation?.cliSessionProviderAccounts?.[provider]
  return {
    status: 'ready',
    accountId,
    forkSession: Boolean(conversation?.cliSessionId && sessionAccount && sessionAccount !== accountId),
    newlyBound: bound === undefined,
  }
}

export function bindProviderAccount(
  conversation: StoredConversation,
  provider: ExternalProviderId,
  accountId: string,
): StoredConversation {
  const bindings: ProviderAccountBindings = {
    ...(conversation.providerAccountBindings ?? {}),
    [provider]: accountId,
  }
  return { ...conversation, providerAccountBindings: bindings }
}

export function recordProviderSessionAccount(
  conversation: StoredConversation,
  provider: ExternalProviderId,
  accountId: string,
  sessionId: string,
): StoredConversation {
  return {
    ...conversation,
    cliSessionId: sessionId,
    cliSessionProviderAccounts: {
      ...(conversation.cliSessionProviderAccounts ?? {}),
      [provider]: accountId,
    },
  }
}
