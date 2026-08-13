import type { CSSProperties } from 'react'
import type { VerbooModel } from '../../../shared/types'
import type { Translator } from '../../i18n'

/**
 * Provider grouping for the F3 model selector (multi-provider catalog).
 *
 * Contract (F2, verified in Rust): `VerbooModel.provider` is absent for the
 * current catalog — absence means 'verboo'. External values seen: 'claude',
 * 'codex'. NOTHING here is hardcoded to a specific provider: a new id in the
 * listing gets its own group with a generic Title Case label when the
 * dictionaries have no translation for it.
 */

export const VERBOO_PROVIDER = 'verboo'

/** Provider id for a catalog model. Absent field = verboo (F2 contract). */
export function modelProvider(model: VerbooModel): string {
  return model.provider ?? VERBOO_PROVIDER
}

/** True when the listing carries at least one non-verboo model. This is the
 *  guard that switches the selector from today's groups (Available / Long
 *  context, byte-identical) to provider groups. */
export function hasExternalProvider(models: VerbooModel[]): boolean {
  return models.some(model => modelProvider(model) !== VERBOO_PROVIDER)
}

/** Display name for a provider: dictionary translation when known, Title Case
 *  of the raw id otherwise — a brand-new provider must appear on its own
 *  without waiting for a dictionary entry. */
export function providerDisplayName(providerId: string, t: Translator): string {
  if (providerId === VERBOO_PROVIDER) return 'Verboo'
  const key = `model.provider.${providerId}`
  const translated = t(key)
  // createTranslator falls back to the key itself when no dictionary entry
  // exists — that is the "untranslated" signal.
  if (translated && translated !== key) return translated
  return providerId
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** The account brand behind a provider's login — codex signs in with the
 *  user's ChatGPT account, which is the name a quota message must use.
 *  Unknown ids fall back to the display name (the nothing-hardcoded rule). */
export function providerAccountName(providerId: string, t: Translator): string {
  return providerId === 'codex' ? 'ChatGPT' : providerDisplayName(providerId, t)
}

/** The ONE canonical header label for an assistant turn (T10 + T12). The
 *  provider prefix comes from EVIDENCE the caller already resolved (the
 *  send-time stamp, or the catalog fallback for legacy items) — `providerName`
 *  is defined only for a known non-verboo provider. Without a stamped
 *  modelDisplayName the app has NO evidence of who answered, so the label
 *  falls back to a neutral ROLE word — never a hardcoded brand (the literal
 *  'Verboo' was the trust defect the owner reported). Shared by TurnView's
 *  turn header and MessageArticle's standalone label so the rule cannot
 *  drift into two forms again. */
export function assistantTurnLabel(modelDisplayName: string | undefined, providerName: string | undefined, t: Translator): string {
  return modelDisplayName ? `${providerName ?? 'Verboo'} - ${modelDisplayName}` : t('transcript.assistantFallback')
}

export function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash
}

/** Deterministic color per provider id — same hue palette as modelToneStyle.
 *  Feeds the verboo group dot and the unknown-provider fallback icon tile. */
export function providerToneStyle(providerId: string): CSSProperties {
  const hues = [266, 194, 146, 318, 28, 218]
  const hue = hues[hashString(providerId) % hues.length]
  return { '--provider-color': `hsl(${hue} 72% 66%)` } as CSSProperties
}

/** Provider for a transcript turn (F3): look the turn's model up in the
 *  catalog by id, falling back to displayName (sessions persisted before the
 *  modelId stamp, or ids renamed by the router). Unknown/absent → verboo, so
 *  the header stays exactly as today. */
export function resolveTurnProvider(modelId: string | undefined, modelDisplayName: string | undefined, models: VerbooModel[]): string {
  const match = (modelId ? models.find(model => model.id === modelId) : undefined)
    ?? (modelDisplayName ? models.find(model => model.displayName === modelDisplayName) : undefined)
  return match ? modelProvider(match) : VERBOO_PROVIDER
}

export type ProviderModelGroup = {
  providerId: string
  label: string
  dotStyle: CSSProperties
  models: VerbooModel[]
}

function providerGroupLabel(providerId: string, t: Translator, verbooPlan?: string): string {
  if (providerId === VERBOO_PROVIDER) {
    return verbooPlan ? `Verboo — ${t('model.group.verbooPlan', { plan: verbooPlan })}` : 'Verboo'
  }
  return `${providerDisplayName(providerId, t)} — ${t('model.group.providerAccount')}`
}

/** One group per provider, verboo first, the rest in first-appearance order.
 *  No Available/Long-context split — in provider mode the provider IS the
 *  grouping axis. */
export function groupModelsByProvider(models: VerbooModel[], t: Translator, verbooPlan?: string): ProviderModelGroup[] {
  const byProvider = new Map<string, VerbooModel[]>()
  for (const model of models) {
    const providerId = modelProvider(model)
    const bucket = byProvider.get(providerId)
    if (bucket) bucket.push(model)
    else byProvider.set(providerId, [model])
  }
  const orderedProviderIds = [...byProvider.keys()].sort((a, b) => {
    if (a === VERBOO_PROVIDER) return -1
    if (b === VERBOO_PROVIDER) return 1
    return 0
  })
  return orderedProviderIds.map(providerId => ({
    providerId,
    label: providerGroupLabel(providerId, t, verbooPlan),
    dotStyle: providerToneStyle(providerId),
    models: byProvider.get(providerId)!,
  }))
}

/**
 * T14: deduplicate models by id. The Rust merge (model_service.rs:190
 * `models.extend(provider_models)`) can produce duplicates when the router
 * cache and the CLI listing both contain the same model. The two entries
 * differ by field. The Router entry (provider absent) is authoritative for
 * model identity, context and capabilities; the CLI entry attaches the
 * provider and can backfill reasoning when the Router omits it. This also
 * protects against older CLI catalogs that marked every provider model as
 * visual by default.
 * Defense-in-depth: the primary fix is in the Rust merge (PERISCOPIO's fence,
 * model_service.rs `attach_provider_models`) — dispatched as T15. This
 * renderer-side dedup is a safety net that protects the user immediately and
 * pins the behavior with a test. It is NOT the primary fix.
 */
export function dedupModels(models: VerbooModel[]): VerbooModel[] {
  const byId = new Map<string, VerbooModel>()
  const counts = new Map<string, number>()
  for (const m of models) {
    const existing = byId.get(m.id)
    if (!existing) {
      byId.set(m.id, m)
      counts.set(m.id, 1)
      continue
    }
    // Two entries for the same id. Preserve Router truth and attach only the
    // CLI-owned provider plus a reasoning fallback.
    const cli = existing.provider ? existing : m
    const router = existing.provider ? m : existing
    byId.set(m.id, {
      ...router,
      provider: cli.provider,
      reasoning: router.reasoning ?? cli.reasoning,
    })
    counts.set(m.id, (counts.get(m.id) ?? 1) + 1)
  }
  // H.6: leave a trace when dedup effectively fuses entries — a third duplicate
  // seen in the field was not reproduced; if it returns, this warn is the
  // symptom that leads to the cause. Only when it fuses, not every render —
  // constant noise is as useless as silence.
  for (const [id, count] of counts) {
    if (count > 1) {
      console.warn(`[dedupModels] fused ${count} entries for "${id}" — renderer defense-in-depth; upstream Rust merge (model_service.rs) should not produce duplicates`)
    }
  }
  return [...byId.values()]
}
