import { ArrowUpRight, RefreshCw, ShieldCheck } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { ProfileActivityDay, ProfileResult } from '../../../shared/types'
import { formatStandardNumber, useI18n, type Translator } from '../../i18n'

type ProfileViewProps = {
  profile: ProfileResult
  loading: boolean
  onRefresh: () => void
  onManagePlan: () => void
}

export function ProfileView({ profile, loading, onRefresh, onManagePlan }: ProfileViewProps) {
  const { language, t } = useI18n()
  const summary = profile.summary
  const activity = profile.activity ?? []

  return (
    <div className="profile-view page-surface">
      <header className="view-heading">
        <div>
          <h1>{t('profile.title')}</h1>
          <p>{t('profile.subtitle')}</p>
        </div>
        <button className="ghost-button" type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} />
          {loading ? t('profile.refreshing') : t('common.refresh')}
        </button>
      </header>

      {profile.status !== 'ready' && (
        <section className="profile-warning">
          <ShieldCheck size={17} />
          <span>{t('profile.warning')}</span>
        </section>
      )}

      {profile.error && profile.status === 'ready' && (
        <section className="profile-warning subtle">
          <span>{t('profile.partialWarning')}</span>
        </section>
      )}

      <section className="profile-grid">
        <MetricCard label={t('profile.totalTokens')} value={formatOptional(summary?.totalTokens, language, t)} />
        <MetricCard label={t('profile.input')} value={formatOptional(summary?.tokensInTotal, language, t)} />
        <MetricCard label={t('profile.output')} value={formatOptional(summary?.tokensOutTotal, language, t)} />
        <MetricCard label={t('profile.requests')} value={formatOptional(summary?.reqTotal, language, t)} />
      </section>

      {/* Only show the activity panel when the account API actually returns a
          per-day breakdown. The usage/summary endpoint often returns totals
          only, and an empty "no real value" heatmap looked broken (B2). */}
      {activity.length > 0 && (
        <section className="profile-panel">
          <div className="panel-heading">
            <div>
              <h2>{t('profile.activityDays')}</h2>
              <p>{t('profile.activeDays', { count: profile.activeDays ?? 0 })}</p>
            </div>
          </div>
          <ActivityHeatmap days={activity} />
        </section>
      )}

      <section className="profile-panel plan-panel">
        <div>
          <h2>{profile.plan?.name ?? t('profile.planUnavailable')}</h2>
          <p>{profile.plan?.status ? t('profile.planStatus', { status: profile.plan.status }) : t('profile.planPending')}</p>
          {profile.plan?.priceLabel && <strong>{profile.plan.priceLabel}</strong>}
          {profile.plan?.models?.length && (
            <p className="plan-models">{profile.plan.models.slice(0, 8).join(', ')}</p>
          )}
        </div>
        <button className="primary-action" type="button" onClick={onManagePlan}>
          {t('profile.managePlan')}
          <ArrowUpRight size={15} />
        </button>
      </section>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function ActivityHeatmap({ days }: { days: ProfileActivityDay[] }) {
  const { language, t } = useI18n()
  if (!days.length) {
    return <div className="heatmap-empty">{t('profile.heatmapEmpty')}</div>
  }

  const max = Math.max(...days.map(day => day.count), 1)
  return (
    <div className="heatmap" aria-label={t('profile.heatmapAria')}>
      {days.slice(-365).map(day => (
        <span
          key={day.date}
          className="heatmap-cell"
          title={`${day.date}: ${t('profile.requestsCount', { count: formatOptional(day.count, language, t) })}`}
          style={{ '--intensity': String(Math.max(0.12, day.count / max)) } as CSSProperties}
        />
      ))}
    </div>
  )
}

function formatOptional(value: number | undefined, language: 'en-US' | 'pt-BR', t: Translator): string {
  if (value === undefined) return t('profile.unavailable')
  return formatStandardNumber(value, language)
}
