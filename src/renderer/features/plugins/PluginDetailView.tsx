import { ArrowLeft, Blocks, Download, Power, Trash2 } from 'lucide-react'
import type { AvailablePlugin, Plugin, PluginError, PluginScope } from '../../../shared/plugins'
import { describePluginError } from '../../../shared/plugins'
import { useI18n } from '../../i18n'

// Union type for the detail view — it handles both installed (Plugin) and
// available (AvailablePlugin) shapes. The parent decides which to pass based
// on whether the user clicked an installed card or an available card.
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

// Plugin detail view. Breadcrumb (Plugins > name), header with name/version/
// marketplace/description, an Informações section (scope, path, ids), and
// action buttons. For installed plugins: Enable toggle + Uninstall. For
// available plugins: Install. A hero placeholder sits at the top — no fake
// screenshots, just a clean branded block.
export function PluginDetailView({ target, onBack, onInstall, onUninstall, onToggle, busy, error }: PluginDetailViewProps) {
  const { t } = useI18n()
  const isInstalled = target.kind === 'installed'
  const plugin = isInstalled ? target.plugin : target.plugin

  const name = isInstalled ? target.plugin.name : target.plugin.name
  const description = isInstalled ? target.plugin.description : target.plugin.description
  const marketplace = isInstalled ? target.plugin.id.split('@').pop() : target.plugin.marketplaceName
  const version = isInstalled ? target.plugin.version : undefined
  const scope = isInstalled ? target.plugin.scope : undefined
  const installPath = isInstalled ? target.plugin.installPath : undefined
  const pluginId = isInstalled ? target.plugin.id : target.plugin.pluginId
  const enabled = isInstalled ? target.plugin.enabled : false

  return (
    <div className="plugin-detail page-surface">
      <button className="profile-back" type="button" onClick={onBack}>
        <ArrowLeft size={14} />
        {t('plugins.detail.backToList')}
      </button>

      {/* Breadcrumb: Plugins > name */}
      <nav className="plugin-detail-breadcrumb" aria-label="breadcrumb">
        <span className="plugin-detail-crumb">{t('plugins.title')}</span>
        <span className="plugin-detail-crumb-sep">/</span>
        <span className="plugin-detail-crumb plugin-detail-crumb--current">{name}</span>
      </nav>

      {/* Hero placeholder — clean branded block, no fake screenshots */}
      <div className="plugin-detail-hero">
        <div className="plugin-detail-hero-icon">
          <Blocks size={32} />
        </div>
        <div className="plugin-detail-hero-text">
          <h1 className="plugin-detail-name">{name}</h1>
          <div className="plugin-detail-meta">
            {version && <span className="plugin-detail-version">v{version}</span>}
            {marketplace && <span className="plugin-detail-marketplace">{marketplace}</span>}
            {isInstalled && (
              <span className={`plugin-detail-state ${enabled ? 'is-on' : 'is-off'}`}>
                {enabled ? t('plugins.enabled') : t('plugins.disabled')}
              </span>
            )}
          </div>
          {description && <p className="plugin-detail-desc">{description}</p>}
        </div>
      </div>

      {error && (
        <div className="plugins-error-banner">
          <span>{describePluginError(error)}</span>
        </div>
      )}

      {/* Actions */}
      <div className="plugin-detail-actions">
        <button type="button" className="ghost-button" onClick={onBack}>
          <ArrowLeft size={14} />
          {t('plugins.detail.back')}
        </button>
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

      {/* Informações section */}
      <section className="plugin-detail-info">
        <h2 className="plugins-section-label">{t('plugins.detail.info')}</h2>
        <dl className="plugin-detail-info-grid">
          <dt className="plugin-detail-info-key">{t('plugins.detail.id')}</dt>
          <dd className="plugin-detail-info-val"><code>{pluginId}</code></dd>

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
      </section>
    </div>
  )
}
