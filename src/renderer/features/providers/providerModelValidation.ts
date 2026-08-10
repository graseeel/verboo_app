import type { ExternalProviderId, VerbooModel } from '../../../shared/types'

export type ProviderModelValidation = 'available' | 'unavailable' | 'unknown' | 'unsupported'

export type ProviderModelBlocker = {
  conversationId: string
  provider: ExternalProviderId
  accountId: string
  modelId: string
}

/**
 * M2 — preflight must not spawn the CLI on every send. Model lists are cached
 * per provider:account and invalidated on conversation account change and on
 * accounts-list reload.
 */
const modelsCache = new Map<string, VerbooModel[]>()

function modelsCacheKey(provider: ExternalProviderId, accountId: string): string {
  return `${provider}:${accountId}`
}

/** Drop one provider:account entry, or the whole cache when no key is given. */
export function invalidateProviderModelsCache(
  provider?: ExternalProviderId,
  accountId?: string,
): void {
  if (provider && accountId) {
    modelsCache.delete(modelsCacheKey(provider, accountId))
    return
  }
  modelsCache.clear()
}

async function loadModelsCached(
  loadModels: (provider: ExternalProviderId, accountId: string) => Promise<VerbooModel[]>,
  provider: ExternalProviderId,
  accountId: string,
): Promise<VerbooModel[]> {
  const key = modelsCacheKey(provider, accountId)
  const cached = modelsCache.get(key)
  if (cached) return cached
  const models = await loadModels(provider, accountId)
  modelsCache.set(key, models)
  return models
}

/**
 * M1 — an old CLI without the `models` subcommand reports the stable
 * `provider_models_unsupported` code (provider_accounts.rs:372-377 remaps
 * `provider_command_unknown`). That is a MISSING CAPABILITY, not a failure:
 * the renderer must not block the turn (pre-fail-closed behavior).
 */
function isProviderModelsUnsupported(error: unknown): boolean {
  if (error instanceof Error) return error.message === 'provider_models_unsupported'
  return error === 'provider_models_unsupported'
}

/**
 * A validation result may clear a blocker only when it describes the exact
 * account/model pair that is currently blocked. This prevents changing a
 * different provider account from accidentally clearing a Codex blocker.
 */
export function canClearProviderModelBlocker(
  blocker: ProviderModelBlocker | undefined,
  context: Pick<ProviderModelBlocker, 'conversationId' | 'provider' | 'accountId' | 'modelId'>,
  validation: ProviderModelValidation,
): boolean {
  return (validation === 'available' || validation === 'unsupported')
    && blocker?.conversationId === context.conversationId
    && blocker.provider === context.provider
    && blocker.accountId === context.accountId
    && blocker.modelId === context.modelId
}

export function shouldBlockProviderModel(
  validation: ProviderModelValidation,
): boolean {
  return validation !== 'available' && validation !== 'unsupported'
}

export async function validateProviderModelSelection(
  loadModels: (provider: ExternalProviderId, accountId: string) => Promise<VerbooModel[]>,
  provider: ExternalProviderId,
  accountId: string,
  modelId: string,
): Promise<ProviderModelValidation> {
  try {
    const models = await loadModelsCached(loadModels, provider, accountId)
    return models.some(model => model.id === modelId) ? 'available' : 'unavailable'
  } catch (error) {
    if (isProviderModelsUnsupported(error)) return 'unsupported'
    return 'unknown'
  }
}
