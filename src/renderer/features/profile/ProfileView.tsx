import { ArrowUpRight, Camera, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { AvatarSettings, ProfileActivityDay, ProfileResult } from '../../../shared/types'
import { formatStandardNumber, useI18n, type Translator } from '../../i18n'
import { AvatarIcon } from '../../components/AvatarIcon'
import { AVATAR_PALETTE, AVATAR_PRESETS, renderPreset } from './avatarPresets'

type ProfileViewProps = {
  profile: ProfileResult
  loading: boolean
  avatarSettings?: AvatarSettings
  onRefresh: () => void
  onManagePlan: () => void
  onUpdateAvatar: (settings: AvatarSettings) => void
}

export function ProfileView({ profile, loading, avatarSettings, onRefresh, onManagePlan, onUpdateAvatar }: ProfileViewProps) {
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

      {/* ── Avatar section ──────────────────────────────────── */}
      <section className="profile-panel avatar-editor-panel">
        <div className="avatar-editor-main">
          <div className="avatar-editor-preview">
            <AvatarIcon settings={avatarSettings} name={profile.user?.name ?? profile.plan?.name ?? ''} size={56} />
          </div>
          <div className="avatar-editor-upload">
            <label className="avatar-editor-upload-btn">
              <Camera size={14} />
              <span>{t('settings.avatarUpload')}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only"
                onChange={async e => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  if (file.size > 10 * 1024 * 1024) return
                  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return
                  const img = await createImageBitmap(file)
                  const size = Math.min(img.width, img.height)
                  const canvas = document.createElement('canvas')
                  canvas.width = 120; canvas.height = 120
                  const ctx = canvas.getContext('2d')!
                  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
                  ctx.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, 120, 120)
                  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, file.type, 0.92))
                  if (!blob) return
                  const base64 = await new Promise<string>(r => {
                    const fr = new FileReader()
                    fr.onload = () => r((fr.result as string).split(',')[1])
                    fr.readAsDataURL(blob!)
                  })
                  const path = await window.verboo.saveAvatarBlob(base64, file.type)
                  onUpdateAvatar({ kind: 'upload', uploadPath: path })
                }}
              />
            </label>
          </div>
        </div>

        <div className="avatar-editor-colors">
          {AVATAR_PALETTE.map(color => (
            <button key={color} type="button"
              className={`avatar-editor-swatch ${(avatarSettings?.presetColor ?? '#6B7280') === color ? 'is-active' : ''}`}
              style={{ backgroundColor: color }}
              onClick={() => onUpdateAvatar({ kind: 'preset', presetId: avatarSettings?.presetId ?? 'cat', presetColor: color })}
              aria-label={color}
            />
          ))}
        </div>

        <div className="avatar-editor-grid">
          {Object.entries(AVATAR_PRESETS).slice(0, 24).map(([id, preset]) => (
            <button key={id} type="button"
              className={`avatar-editor-icon ${avatarSettings?.presetId === id ? 'is-active' : ''}`}
              onClick={() => onUpdateAvatar({ kind: 'preset', presetId: id, presetColor: avatarSettings?.presetColor ?? '#6B7280' })}
              title={t(preset.labelKey)}
            >
              {renderPreset(id, avatarSettings?.presetColor ?? '#6B7280')}
            </button>
          ))}
        </div>

        {(avatarSettings && avatarSettings.kind !== 'initials') && (
          <button type="button" className="avatar-editor-reset" onClick={() => onUpdateAvatar({ kind: 'initials' })}>
            <RotateCcw size={12} />
            {t('settings.avatarReset')}
          </button>
        )}
      </section>

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
