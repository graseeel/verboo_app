import type { ExternalProviderId, ProviderUsageSnapshot, ProviderUsageWindow } from '../../../shared/types'
import { useI18n } from '../../i18n'
import type { ProviderUsageRowState } from './useProviderAccounts'

export function visibleProviderWindows(snapshot: ProviderUsageSnapshot): ProviderUsageWindow[] {
  if (snapshot.provider === 'codex') {
    return snapshot.windows.filter(window => window.kind === 'weekly' || window.kind === 'model-scoped-weekly')
  }
  return snapshot.windows.filter(window =>
    window.kind === 'session' || window.kind === 'weekly' || window.kind === 'model-scoped-weekly',
  )
}

export function formatProviderReset(resetsAt: string | undefined, locale: string): string | undefined {
  if (!resetsAt) return undefined
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function kindLabel(provider: ExternalProviderId, window: ProviderUsageWindow, t: (key: string) => string): string {
  if (window.kind === 'session') return t('settings.provider.fiveHours')
  if (window.kind === 'weekly') return t('settings.provider.weekly')
  return window.displayLabel || (provider === 'codex' ? t('settings.provider.weekly') : window.modelScope ?? 'Scoped')
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
        const reset = formatProviderReset(window.resetsAt, language)
        return (
          <div className="provider-usage-window" key={window.id}>
            <div className="provider-usage-window-head">
              <strong>{kindLabel(state.snapshot!.provider, window, t)}</strong>
              <span>{printed}%</span>
            </div>
            <div className="provider-usage-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={width}>
              <span style={{ width: `${width}%` }} />
            </div>
            <small>{reset ?? t('settings.provider.resetNotReported')}</small>
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
