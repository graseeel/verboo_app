import type {
  ExternalProviderId,
  ProviderAccountBindings,
  StoredConversation,
} from '../../../shared/types'

export type ProviderTurnAccountResolution =
  | { status: 'ready'; accountId: string; forkSession: boolean; newlyBound: boolean }
  | { status: 'unresolved'; accountId: string }
  | { status: 'missing' }

export function resolveProviderTurnAccount(
  conversation: StoredConversation,
  provider: ExternalProviderId,
  defaultAccountId: string | undefined,
  connectedAccountIds: ReadonlySet<string>,
): ProviderTurnAccountResolution {
  const bound = conversation.providerAccountBindings?.[provider]
  const accountId = bound ?? defaultAccountId
  if (!accountId) return { status: 'missing' }
  if (!connectedAccountIds.has(accountId)) return { status: 'unresolved', accountId }
  const sessionAccount = conversation.cliSessionProviderAccounts?.[provider]
  return {
    status: 'ready',
    accountId,
    forkSession: Boolean(conversation.cliSessionId && sessionAccount && sessionAccount !== accountId),
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
