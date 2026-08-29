import type { ExternalProviderId, ProviderUsageSnapshot, ProviderUsageWindow } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { parseResetsAt } from '../providers/providerQuotaPresentation'
import type { ProviderUsageRowState } from './useProviderAccounts'

export function visibleProviderWindows(snapshot: ProviderUsageSnapshot): ProviderUsageWindow[] {
  if (snapshot.provider === 'codex') {
    return snapshot.windows.filter(window =>
      window.kind === 'weekly' ||
      window.kind === 'model-scoped-weekly' ||
      ((window.kind === 'session' || window.kind === 'unknown') && validWindowMinutes(window.windowMinutes) !== undefined),
    )
  }
  return snapshot.windows.filter(window =>
    window.kind === 'session' || window.kind === 'weekly' || window.kind === 'model-scoped-weekly',
  )
}

export function formatProviderReset(resetsAt: string | undefined, locale: string): string | undefined {
  const date = parseResetsAt(resetsAt)
  if (!date) return undefined
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function validWindowMinutes(windowMinutes: number | undefined): number | undefined {
  if (!Number.isInteger(windowMinutes) || (windowMinutes ?? 0) <= 0) return undefined
  return windowMinutes
}

export function formatProviderWindowDuration(windowMinutes: number | undefined, locale: string): string | undefined {
  const minutes = validWindowMinutes(windowMinutes)
  if (minutes === undefined) return undefined

  const [value, unit]: [number, 'day' | 'hour' | 'minute'] = minutes % (24 * 60) === 0
    ? [minutes / (24 * 60), 'day']
    : minutes % 60 === 0
      ? [minutes / 60, 'hour']
      : [minutes, 'minute']

  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value)
}

function kindLabel(window: ProviderUsageWindow, t: (key: string) => string, locale: string): string {
  const duration = formatProviderWindowDuration(window.windowMinutes, locale)
  if (duration) {
    if (window.kind !== 'model-scoped-weekly') return duration
    const scope = window.modelScope || 'Scoped'
    return `${scope.charAt(0).toUpperCase()}${scope.slice(1)} · ${duration}`
  }
  if (window.kind === 'session') return t('settings.provider.fiveHours')
  if (window.kind === 'weekly') return t('settings.provider.weekly')
  // A3 — model-scoped-weekly: NUNCA imprima o displayLabel cru do CLI
  // ("Fable Weekly" vaza inglês). O rótulo é {modelScope capitalizado} + a
  // palavra semanal/weekly LOCALIZADA (pt: "Fable semanal"; en: "Fable
  // Weekly").
  const scope = window.modelScope || 'Scoped'
  return `${scope.charAt(0).toUpperCase()}${scope.slice(1)} ${t('settings.provider.weekly')}`
}

export function ProviderUsageWindows({ state }: { state: ProviderUsageRowState }) {
  const { language, t } = useI18n()
  if (state.status === 'unavailable' && !state.snapshot) {
    return <p className="provider-usage-state is-error">{t('settings.provider.usageUnavailable')}</p>
  }
  if (state.status === 'loading' && !state.snapshot) {
    return <p className="provider-usage-state">{t('common.validating')}…</p>
  }
  if (!state.snapshot) return null
  const windows = visibleProviderWindows(state.snapshot)
  const hasClaudeMax = state.snapshot.provider === 'claude' &&
    (state.snapshot.plan?.id ?? '').toLowerCase().includes('max')
  const hasFable = windows.some(window => window.kind === 'model-scoped-weekly')
  const updated = formatProviderReset(state.snapshot.fetchedAt, language)
  return (
    <div className={`provider-usage-windows${state.status === 'stale' ? ' is-stale' : ''}`}>
      {state.status === 'stale' && (
        <p className="provider-usage-state is-stale">
          {t('settings.provider.stale', { time: updated ?? t('common.unknown') })}
        </p>
      )}
      {windows.map(window => {
        const printed = Math.round(window.usedPercent)
        const width = Math.min(100, Math.max(0, window.usedPercent))
        const remaining = 100 - printed
        const reset = formatProviderReset(window.resetsAt, language)
        const bandClass = printed >= 100
          ? ' is-exhausted'
          : printed >= 80
            ? ' is-warning'
            : ''
        const valueText = t('settings.provider.usedPercent', { percent: printed })
          + ', '
          + t('settings.provider.remainingPercent', { percent: Math.max(0, remaining) })
        return (
          <div className={`provider-usage-window${bandClass}`} key={window.id}>
            <div className="provider-usage-window-head">
              <strong>{kindLabel(window, t, language)}</strong>
              <span>{t('settings.provider.usedPercent', { percent: printed })}</span>
            </div>
            <div className="provider-usage-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={width} aria-valuetext={valueText}>
              <span style={{ width: `${width}%` }} />
            </div>
            <small>{reset ?? t('settings.provider.resetNotReported')}{reset ? ` · ${t('settings.provider.remainingPercent', { percent: Math.max(0, remaining) })}` : ''}</small>
          </div>
        )
      })}
      {hasClaudeMax && !hasFable && (
        <p className="provider-usage-state">{t('settings.provider.notReportedByClaude')}</p>
      )}
      {windows.length === 0 && !hasClaudeMax && (
        <p className="provider-usage-state">{t('settings.provider.usageUnavailable')}</p>
      )}
    </div>
  )
}
