/**
 * Pure helpers for the reasoning-effort integration between FE preferences
 * and AgentTurnRequest payloads. Extracted from App.tsx so the rules can be
 * unit-tested without rendering React.
 *
 * Two values leave this module:
 *
 *  - {@link validOverride}: the effort to put on the wire. Only set when the
 *    user has explicitly saved a preference AND it is still in the model's
 *    `effortLevels`. Preserves `"none"` when the model offers it — the
 *    backend/CLI differentiates "absent" (apply model default) from
 *    `"none"` (suppress reasoning). Never falls back to `defaultEffort`.
 *
 *  - {@link displayEffort}: what the UI pill shows. Same rule as
 *    `validOverride`, but falls back to `reasoning.defaultEffort` so the
 *    selector still reflects a meaningful level when no preference is set.
 */

import type { ModelReasoning } from '../../../shared/types'

/**
 * Resolve the user-saved effort override, validating it against the model's
 * current `effortLevels`. Returns `undefined` when:
 *  - the model has no reasoning config,
 *  - no preference is saved for this model,
 *  - the saved value is no longer in `effortLevels` (stale).
 *
 * IMPORTANT: `"none"` is a legitimate return value when the model offers it
 * in `effortLevels` and the user picked it. Callers must NOT coerce `"none"`
 * to `undefined` — that strips a deliberate user choice.
 */
export function validOverride(
  effortByModel: Record<string, string> | undefined,
  modelId: string | undefined,
  reasoning: ModelReasoning | undefined,
): string | undefined {
  if (!modelId || !reasoning) return undefined
  const levels = reasoning.effortLevels ?? []
  if (levels.length === 0) return undefined
  const saved = effortByModel?.[modelId]
  if (!saved) return undefined
  return levels.includes(saved) ? saved : undefined
}

/**
 * Effort to render in the UI pill. Same precedence as {@link validOverride},
 * but falls back to `reasoning.defaultEffort` when no override is set so the
 * pill still shows a meaningful level. Returns `undefined` only when the
 * model has no reasoning config.
 */
export function displayEffort(
  effortByModel: Record<string, string> | undefined,
  modelId: string | undefined,
  reasoning: ModelReasoning | undefined,
): string | undefined {
  const override = validOverride(effortByModel, modelId, reasoning)
  if (override !== undefined) return override
  return reasoning?.defaultEffort
}

/**
 * Decide which preference map is the source of truth at startup, and whether
 * a one-time migration from localStorage is needed.
 *
 * Backend (`settings.effortByModel`) is durable source — when it has any
 * entries, it wins and localStorage is treated as already-migrated. When the
 * backend is empty, fall back to the localStorage map and signal that it
 * should be persisted to the backend.
 *
 * Returns `{ prefs, migrate }` where `migrate` is the payload to send via
 * `updateUserSettings({ effortByModel: migrate })` when migration is needed
 * (or `undefined` when no migration is needed).
 */
export function migrateEffortPrefs(
  backendPrefs: Record<string, string> | undefined,
  lsPrefs: Record<string, string> | undefined,
): { prefs: Record<string, string>; migrate: Record<string, string> | undefined } {
  const hasBackend = backendPrefs && Object.keys(backendPrefs).length > 0
  if (hasBackend) {
    return { prefs: backendPrefs!, migrate: undefined }
  }
  const hasLs = lsPrefs && Object.keys(lsPrefs).length > 0
  if (hasLs) {
    return { prefs: lsPrefs!, migrate: lsPrefs! }
  }
  return { prefs: {}, migrate: undefined }
}
