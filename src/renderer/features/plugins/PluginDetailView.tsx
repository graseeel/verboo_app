import { ArrowLeft, ChevronDown, Download, Power, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { AvailablePlugin, Plugin, PluginError, PluginScope } from '../../../shared/plugins'
import { describePluginError } from '../../../shared/plugins'
import { useI18n } from '../../i18n'
import { monogramColor, PluginMonogram } from './PluginCard'
import { marketplaceFriendlyName } from './marketplaceNames'

type DetailTarget =
  | { kind: 'installed'; plugin: Plugin }
  | { kind: 'available'; plugin: AvailablePlugin }

type PluginDetailViewProps = {
  target: DetailTarget
  onBack: () => void
  onInstall?: (scope: PluginScope) => Promise<void>
  onUninstall?: () => Promise<void>
  onToggle?: (enabled: boolean) => Promise<void>
  busy?: boolean
  error?: PluginError
}

// Plugin detail view — Codex-inspired hero structure:
// 1. Breadcrumb (Plugins > name)
// 2. Header row: monogram 56px + title + marketplace subtitle + badge + actions
// 3. Hero band: full-width mesh gradient with animated drift, glass chip
// 4. Body: full description
// 5. Collapsible "Detalhes técnicos" (accordion, default collapsed)
export function PluginDetailView({ target, onBack, onInstall, onUninstall, onToggle, busy, error }: PluginDetailViewProps) {
  const { t } = useI18n()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const isInstalled = target.kind === 'installed'

  const name = isInstalled ? target.plugin.name : target.plugin.name
  const description = isInstalled ? target.plugin.description : target.plugin.description
  const rawMarketplace = isInstalled ? (target.plugin.id.split('@').pop() ?? '') : target.plugin.marketplaceName
  const marketplace = marketplaceFriendlyName(rawMarketplace)
  const version = isInstalled ? target.plugin.version : undefined
  const scope = isInstalled ? target.plugin.scope : undefined
  const installPath = isInstalled ? target.plugin.installPath : undefined
  const pluginId = isInstalled ? target.plugin.id : target.plugin.pluginId
  const enabled = isInstalled ? target.plugin.enabled : false

  return (
    <div className="plugin-detail page-surface">
      {/* Breadcrumb */}
      <nav className="plugin-detail-breadcrumb" aria-label="breadcrumb">
        <button type="button" className="plugin-detail-crumb plugin-detail-crumb--link" onClick={onBack}>
          {t('plugins.title')}
        </button>
        <span className="plugin-detail-crumb-sep">/</span>
        <span className="plugin-detail-crumb plugin-detail-crumb--current">{name}</span>
      </nav>

      {/* Header row: monogram + title/subtitle/badge + actions */}
      <div className="plugin-detail-header">
        <div className="plugin-detail-header-left">
          <PluginMonogram name={name} id={pluginId} size={56} />
          <div className="plugin-detail-header-text">
            <h1 className="plugin-detail-name">{name}</h1>
            <p className="plugin-detail-subtitle">{marketplace}</p>
          </div>
          {isInstalled && (
            <span className={`plugin-detail-badge ${enabled ? 'is-on' : 'is-off'}`}>
              {enabled ? t('plugins.enabled') : t('plugins.disabled')}
            </span>
          )}
        </div>
        <div className="plugin-detail-header-actions">
          {isInstalled ? (
            <>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void onToggle?.(!enabled)}
                disabled={busy}
              >
                <Power size={14} />
                {enabled ? t('plugins.disable') : t('plugins.enable')}
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void onUninstall?.()}
                disabled={busy}
              >
                <Trash2 size={14} />
                {t('plugins.uninstall')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="primary-button"
              onClick={() => void onInstall?.('user')}
              disabled={busy}
            >
              <Download size={14} />
              {t('plugins.install')}
            </button>
          )}
        </div>
      </div>

      {/* Hero band — full-width mesh gradient with animated drift.
          --plugin-hero-color is seeded from the plugin id so the same plugin
          always gets the same hue (matches the monogram). Mesh layers in CSS
          use this var with --accent fallback. */}
      <div
        className="plugin-detail-hero"
        style={{ '--plugin-hero-color': monogramColor(pluginId) } as React.CSSProperties}
      >
        <div className="plugin-detail-hero-mesh" aria-hidden="true" />
        <div className="plugin-detail-hero-content">
          {/* Glass chip "Exemplo de uso" — presentational only, role=group,
              NOT a button. No navigation, no @ prefill, no toast. */}
          <div className="plugin-hero-chip" role="group" aria-label={t('plugins.detail.exampleLabel')}>
            <PluginMonogram name={name} id={pluginId} size={28} />
            <span className="plugin-hero-chip-text">
              {t('plugins.detail.exampleUse')}
            </span>
            <ArrowLeft size={13} className="plugin-hero-chip-arrow" />
          </div>
        </div>
      </div>

      {error && (
        <div className="plugins-error-banner">
          <span>{describePluginError(error)}</span>
        </div>
      )}

      {/* Body: full description */}
      {description && (
        <p className="plugin-detail-body-desc">{description}</p>
      )}

      {/* Collapsible "Detalhes técnicos" — accordion, default collapsed.
          De-emphasizes filesystem paths/ids behind a disclosure so the hero
          and description stay the focus. */}
      <section className="plugin-detail-tech">
        <button
          type="button"
          className="plugin-detail-tech-trigger"
          onClick={() => setDetailsOpen(open => !open)}
          aria-expanded={detailsOpen}
        >
          <span>{t('plugins.detail.techDetails')}</span>
          <ChevronDown size={15} className={`plugin-detail-tech-chevron ${detailsOpen ? 'is-open' : ''}`} />
        </button>
        <div className={`plugin-detail-tech-panel ${detailsOpen ? 'is-open' : ''}`}>
          <dl className="plugin-detail-info-grid">
            <dt className="plugin-detail-info-key">{t('plugins.detail.id')}</dt>
            <dd className="plugin-detail-info-val"><code>{pluginId}</code></dd>

            {version && (
              <>
                <dt className="plugin-detail-info-key">{t('plugins.detail.version')}</dt>
                <dd className="plugin-detail-info-val">v{version}</dd>
              </>
            )}

            {scope && (
              <>
                <dt className="plugin-detail-info-key">{t('plugins.scopeLabel')}</dt>
                <dd className="plugin-detail-info-val">{t(`plugins.scope.${scope}`)}</dd>
              </>
            )}

            {installPath && (
              <>
                <dt className="plugin-detail-info-key">{t('plugins.detail.path')}</dt>
                <dd className="plugin-detail-info-val"><code>{installPath}</code></dd>
              </>
            )}

            {isInstalled && target.plugin.installedAt && (
              <>
                <dt className="plugin-detail-info-key">{t('plugins.detail.installedAt')}</dt>
                <dd className="plugin-detail-info-val">{new Date(target.plugin.installedAt).toLocaleDateString()}</dd>
              </>
            )}

            {isInstalled && target.plugin.gitCommitSha && (
              <>
                <dt className="plugin-detail-info-key">{t('plugins.detail.commit')}</dt>
                <dd className="plugin-detail-info-val"><code>{target.plugin.gitCommitSha.slice(0, 8)}</code></dd>
              </>
            )}
          </dl>
        </div>
      </section>
    </div>
  )
}
