import type { ProviderUsageWindow } from '../../../shared/types'
import type { ProviderUsageRowState } from '../settings/useProviderAccounts'

export function formatQuotaReset(resetsAt: string | undefined, locale: string): string | undefined {
  if (!resetsAt) return undefined
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return undefined
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
    .filter(value => !Number.isNaN(new Date(value).getTime()))
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
  const exhausted = selected?.snapshot?.windows.find(window => window.usedPercent >= 100)
  if (!selected || selected.status !== 'fresh' || !exhausted) return undefined
  const target: QuotaTarget = { kind: exhausted.kind, modelScope: exhausted.modelScope }
  const aggregate = classifyProviderQuota(target, rows)
  return {
    target,
    allExhausted: aggregate.allExhausted,
    resetAt: aggregate.allExhausted ? aggregate.nextResetAt : selectedQuotaReset(target, selected),
  }
}
