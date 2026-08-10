import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canClearProviderModelBlocker,
  invalidateProviderModelsCache,
  shouldBlockProviderModel,
  validateProviderModelSelection,
} from './providerModelValidation'

const codexModels = () => [{ id: 'gpt-5.5', displayName: 'GPT-5.5', raw: {} }]

beforeEach(() => invalidateProviderModelsCache())

describe('provider model validation', () => {
  it('reports unavailable when the account model list omits the selected model', async () => {
    await expect(validateProviderModelSelection(
      vi.fn().mockResolvedValue(codexModels()),
      'codex',
      'account-1',
      'gpt-5.6-sol',
    )).resolves.toBe('unavailable')
  })

  it('reports unknown on a CLI/storage failure instead of allowing the turn', async () => {
    await expect(validateProviderModelSelection(
      vi.fn().mockRejectedValue(new Error('provider CLI unavailable')),
      'codex',
      'account-1',
      'gpt-5.6-sol',
    )).resolves.toBe('unknown')
  })

  it('does not clear a Codex blocker when a Claude account changes', () => {
    const blocker = { conversationId: 'chat-1', provider: 'codex' as const, accountId: 'codex-a', modelId: 'gpt-5.6' }
    expect(canClearProviderModelBlocker(blocker, {
      conversationId: 'chat-1',
      provider: 'claude',
      accountId: 'claude-a',
      modelId: 'gpt-5.6',
    }, 'available')).toBe(false)
  })

  it('keeps the send gate closed for unavailable or unknown validation', () => {
    expect(shouldBlockProviderModel('unavailable')).toBe(true)
    expect(shouldBlockProviderModel('unknown')).toBe(true)
    expect(shouldBlockProviderModel('available')).toBe(false)
  })

  // M1 — an old CLI without the `models` subcommand surfaces the stable
  // `provider_models_unsupported` code (provider_accounts.rs:372-377). It is a
  // MISSING CAPABILITY, not a failure: it must not create a model blocker.
  it('M1: reports unsupported instead of unknown when the CLI lacks the models subcommand', async () => {
    await expect(validateProviderModelSelection(
      vi.fn().mockRejectedValue(new Error('provider_models_unsupported')),
      'codex',
      'account-1',
      'gpt-5.6-sol',
    )).resolves.toBe('unsupported')
  })

  it('M1: keeps the send gate open when validation is unsupported', () => {
    expect(shouldBlockProviderModel('unsupported')).toBe(false)
  })

  it('M1: clears the exact blocker when validation is unsupported (capability absent)', () => {
    const blocker = { conversationId: 'chat-1', provider: 'codex' as const, accountId: 'codex-a', modelId: 'gpt-5.6' }
    expect(canClearProviderModelBlocker(blocker, blocker, 'unsupported')).toBe(true)
  })

  // M2 — preflight must not spawn the CLI on every send: model lists are
  // cached per provider:account and invalidated on conversation account change
  // and on accounts-list reload.
  it('M2: reuses the cached model list for the same provider:account', async () => {
    const loadModels = vi.fn().mockResolvedValue(codexModels())
    await validateProviderModelSelection(loadModels, 'codex', 'account-1', 'gpt-5.5')
    await validateProviderModelSelection(loadModels, 'codex', 'account-1', 'gpt-5.5')
    expect(loadModels).toHaveBeenCalledTimes(1)
  })

  it('M2: refetches when the provider:account cache entry is invalidated', async () => {
    const loadModels = vi.fn().mockResolvedValue(codexModels())
    await validateProviderModelSelection(loadModels, 'codex', 'account-1', 'gpt-5.5')
    invalidateProviderModelsCache('codex', 'account-1')
    await validateProviderModelSelection(loadModels, 'codex', 'account-1', 'gpt-5.5')
    expect(loadModels).toHaveBeenCalledTimes(2)
  })

  it('M2: refetches after the whole model cache is cleared', async () => {
    const loadModels = vi.fn().mockResolvedValue(codexModels())
    await validateProviderModelSelection(loadModels, 'codex', 'account-1', 'gpt-5.5')
    invalidateProviderModelsCache()
    await validateProviderModelSelection(loadModels, 'codex', 'account-1', 'gpt-5.5')
    expect(loadModels).toHaveBeenCalledTimes(2)
  })
})
