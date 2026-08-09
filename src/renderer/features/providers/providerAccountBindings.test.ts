import { describe, expect, it } from 'vitest'
import { createConversation } from '../../state/chatStore'
import type { ProviderAccountBindings, StoredConversation } from '../../../shared/types'
import {
  bindProviderAccount,
  recordProviderSessionAccount,
  resolveProviderTurnAccount,
} from './providerAccountBindings'

function ready(result: ReturnType<typeof resolveProviderTurnAccount>) {
  if (result.status !== 'ready') throw new Error(`expected ready, got ${result.status}`)
  return result
}

function conversation(patch: Partial<StoredConversation> = {}): StoredConversation {
  return { ...createConversation(), ...patch }
}

describe('provider account bindings', () => {
  it('binds the first provider use and keeps it stable after the default changes', () => {
    const first = ready(resolveProviderTurnAccount(conversation(), 'codex', 'default-a', new Set(['default-a'])))
    const bound = bindProviderAccount(conversation(), 'codex', first.accountId)
    const second = ready(resolveProviderTurnAccount(bound, 'codex', 'default-b', new Set(['default-a', 'default-b'])))
    expect(first.accountId).toBe('default-a')
    expect(second.accountId).toBe('default-a')
    expect(second.newlyBound).toBe(false)
  })

  it('forks only when the local session used another account for this provider', () => {
    const bound = conversation({
      cliSessionId: 'session-1',
      providerAccountBindings: { codex: 'local-b' },
      cliSessionProviderAccounts: { codex: 'local-a' },
    })
    expect(resolveProviderTurnAccount(bound, 'codex', 'local-a', new Set(['local-a', 'local-b'])))
      .toMatchObject({ status: 'ready', accountId: 'local-b', forkSession: true })
  })

  it('preserves unresolved historical ids instead of silently rebinding', () => {
    const bound = conversation({ providerAccountBindings: { codex: 'removed-account' } })
    expect(resolveProviderTurnAccount(bound, 'codex', 'default-a', new Set(['default-a'])))
      .toEqual({ status: 'unresolved', accountId: 'removed-account' })
  })

  it('records only the selected provider account on the returned CLI session', () => {
    const initialBindings: ProviderAccountBindings = { codex: 'local-a', claude: 'claude-a' }
    const updated = recordProviderSessionAccount(
      conversation({ providerAccountBindings: initialBindings }),
      'codex',
      'local-b',
      'session-2',
    )
    expect(updated.cliSessionId).toBe('session-2')
    expect(updated.cliSessionProviderAccounts).toEqual({ codex: 'local-b' })
    expect(updated.providerAccountBindings).toEqual(initialBindings)
  })
})
