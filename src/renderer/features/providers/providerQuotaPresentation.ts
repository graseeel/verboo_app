import type { ProviderUsageWindow } from '../../../shared/types'
import type { ProviderUsageRowState } from '../settings/useProviderAccounts'

/**
 * Parses a provider reset timestamp into a valid Date, tolerating the
 * microsecond+offset ISO format the provider API emits (captured real value:
 * "2026-08-10T16:00:00.349529+00:00").
 *
 * The ECMAScript Date Time String Format defines fractional seconds as
 * exactly three digits (milliseconds). `new Date()` accepts longer fractions
 * and rejects surrounding whitespace only by engine leniency, so we normalize
 * the fraction to three digits and trim before parsing — every engine renders
 * the same reset time. Returns undefined for missing or unparseable values so
 * callers keep the honest "not reported" fallback.
 */
export function parseResetsAt(resetsAt: string | undefined): Date | undefined {
  if (!resetsAt) return undefined
  const normalized = resetsAt
    .trim()
    .replace(/\.(\d+)/, (_, fraction: string) => `.${fraction.slice(0, 3).padEnd(3, '0')}`)
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function formatQuotaReset(resetsAt: string | undefined, locale: string): string | undefined {
  const date = parseResetsAt(resetsAt)
  if (!date) return undefined
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export type QuotaTarget = {
  kind: ProviderUsageWindow['kind']
  modelScope?: string
}

export type QuotaAggregate = {
  allExhausted: boolean
  nextResetAt?: string
}

export function classifyProviderQuota(
  target: QuotaTarget,
  rows: ProviderUsageRowState[],
): QuotaAggregate {
  if (rows.length === 0) return { allExhausted: false }
  const matches = rows.map(row => {
    if (row.status !== 'fresh' || !row.snapshot) return undefined
    return row.snapshot.windows.find(window =>
      window.kind === target.kind && window.modelScope === target.modelScope && window.usedPercent >= 100,
    )
  })
  if (matches.some(window => window === undefined)) return { allExhausted: false }
  const resets = matches
    .flatMap(window => window?.resetsAt ? [window.resetsAt] : [])
    .filter(value => parseResetsAt(value) !== undefined)
    .sort()
  return { allExhausted: true, nextResetAt: resets[0] }
}

export function selectedQuotaReset(
  target: QuotaTarget,
  row: ProviderUsageRowState | undefined,
): string | undefined {
  if (!row?.snapshot || row.status !== 'fresh') return undefined
  return row.snapshot.windows.find(window =>
    window.kind === target.kind && window.modelScope === target.modelScope && window.usedPercent >= 100,
  )?.resetsAt
}

/** Finds the first exhausted window owned by the selected account and reports
 * whether that exact window is exhausted for every freshly refreshed account.
 * The target is returned from provider data instead of guessing a plan or
 * model scope, so new provider windows remain forward-compatible. */
export function selectedExhaustedQuota(
  rows: ProviderUsageRowState[],
  selectedAccountId: string,
): { target: QuotaTarget; allExhausted: boolean; resetAt?: string } | undefined {
  const selected = rows.find(row => row.account.accountId === selectedAccountId)
  const exhausted = selected?.snapshot?.windows.filter(window => window.usedPercent >= 100) ?? []
  // A provider may expose independent windows (for example base and Fable).
  // Without an explicit target from the provider error, choosing the first
  // exhausted window would show a potentially incorrect reset time.
  if (!selected || selected.status !== 'fresh' || exhausted.length !== 1) return undefined
  const [targetWindow] = exhausted
  if (!targetWindow) return undefined
  const target: QuotaTarget = { kind: targetWindow.kind, modelScope: targetWindow.modelScope }
  const aggregate = classifyProviderQuota(target, rows)
  return {
    target,
    allExhausted: aggregate.allExhausted,
    resetAt: aggregate.allExhausted ? aggregate.nextResetAt : selectedQuotaReset(target, selected),
  }
}
