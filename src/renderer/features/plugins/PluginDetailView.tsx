import { ArrowLeft, ChevronDown, Download, ExternalLink, Power, Trash2, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AvailablePlugin, MarketplaceManifestMap, Plugin, PluginDetail, PluginError, PluginScope, PluginSkill } from '../../../shared/plugins'
import { describePluginError } from '../../../shared/plugins'
import { useI18n } from '../../i18n'
import { monogramColor, pluginHue, PluginMonogram } from './PluginCard'
import { marketplaceFriendlyName } from './marketplaceNames'

type DetailTarget =
  | { kind: 'installed'; plugin: Plugin }
  | { kind: 'available'; plugin: AvailablePlugin }

type PluginDetailViewProps = {
  target: DetailTarget
  manifests: MarketplaceManifestMap
  onBack: () => void
  onInstall?: (scope: PluginScope) => Promise<void>
  onUninstall?: () => Promise<void>
  onToggle?: (enabled: boolean) => Promise<void>
  busy?: boolean
  error?: PluginError
}

// Plugin detail view — Codex-inspired rich detail:
// 1. Breadcrumb (Plugins > name)
// 2. Sticky header: monogram 56px + title + marketplace subtitle + badge + actions
// 3. Hero band: violet mesh + glass chip (1st skill desc or plugin desc)
// 4. Full description paragraph (manifest description if richer)
// 5. Habilidades section (installed only, skill count gray)
// 6. Informações table (Desenvolvedor/Categoria/Versão/Site — omit missing)
// 7. Collapsible "Detalhes técnicos" (ID, path, dates)
export function PluginDetailView({ target, manifests, onBack, onInstall, onUninstall, onToggle, busy, error }: PluginDetailViewProps) {
  const { t } = useI18n()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detail, setDetail] = useState<PluginDetail | undefined>(undefined)
  const [skills, setSkills] = useState<PluginSkill[]>([])
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

  // Manifest metadata (category, author, homepage, richer description).
  const manifest = manifests[pluginId]
  const fullDescription = detail?.manifestDescription ?? manifest?.description ?? description
  const author = detail?.authorName ?? manifest?.author
  const category = manifest?.category
  const homepage = detail?.manifestHomepage ?? manifest?.homepage

  // Fetch rich detail + skills for installed plugins only. Available plugins
  // don't have on-disk manifests/skills yet — the section is omitted.
  useEffect(() => {
    if (!isInstalled) {
      setDetail(undefined)
      setSkills([])
      return
    }
    let cancelled = false
    window.verboo.pluginDetail(pluginId).then(d => { if (!cancelled) setDetail(d) }).catch(() => {})
    window.verboo.pluginSkills(pluginId).then(s => { if (!cancelled) setSkills(s) }).catch(() => {})
    return () => { cancelled = true }
  }, [isInstalled, pluginId])

  // Chip phrase: 1st skill description (installed with skills), fallback
  // to plugin description. Empty desc → chip shows monogram+name only.
  const chipPhrase = skills[0]?.description ?? fullDescription

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

      {/* Sticky header */}
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
                className="plugin-uninstall-btn"
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
              className="plugin-install-pill"
              onClick={() => void onInstall?.('user')}
              disabled={busy}
            >
              <Download size={14} />
              {t('plugins.install')}
            </button>
          )}
        </div>
      </div>

      {/* Hero band — Verboo violet mesh + glass chip */}
      <div
        className="plugin-detail-hero"
        style={{
          '--plugin-hero-color': monogramColor(pluginId),
          '--plugin-hero-hue': pluginHue(pluginId),
        } as React.CSSProperties}
      >
        <div className="plugin-detail-hero-mesh" aria-hidden="true" />
        <div className="plugin-detail-hero-content">
          <div className="plugin-hero-chip" role="group" aria-label={name}>
            <PluginMonogram name={name} id={pluginId} size={32} />
            <div className="plugin-hero-chip-text">
              <span className="plugin-hero-chip-name">{name}</span>
              {chipPhrase && (
                <span className="plugin-hero-chip-desc">
                  {chipPhrase.length > 90 ? chipPhrase.slice(0, 90) + '…' : chipPhrase}
                </span>
              )}
            </div>
            <div className="plugin-hero-chip-arrow" aria-hidden="true">
              <ArrowLeft size={16} />
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="plugins-error-banner">
          <span>{describePluginError(error)}</span>
        </div>
      )}

      {/* Full description paragraph */}
      {fullDescription && (
        <p className="plugin-detail-body-desc">{fullDescription}</p>
      )}

      {/* Habilidades section — installed only. Skill count gray (Codex style). */}
      {isInstalled && skills.length > 0 && (
        <section className="plugin-detail-skills">
          <div className="plugin-detail-skills-header">
            <h2 className="plugins-section-label">{t('plugins.detail.skills')}</h2>
            <span className="plugin-detail-skills-count">{skills.length}</span>
          </div>
          <div className="plugin-detail-skills-list">
            {skills.map(skill => (
              <div key={skill.skillPath} className="plugin-skill-row">
                <div className="plugin-skill-icon" aria-hidden="true">
                  <Zap size={14} />
                </div>
                <div className="plugin-skill-body">
                  <div className="plugin-skill-name">{skill.name}</div>
                  {skill.description && (
                    <div className="plugin-skill-desc">{skill.description}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Informações table — omit rows when data missing. */}
      {(author || category || version || homepage) && (
        <section className="plugin-detail-info-section">
          <h2 className="plugins-section-label">{t('plugins.detail.information')}</h2>
          <dl className="plugin-detail-info-grid">
            {author && (
              <>
                <dt className="plugin-detail-info-key">{t('plugins.detail.developer')}</dt>
                <dd className="plugin-detail-info-val">{author}</dd>
              </>
            )}
            {category && (
              <>
                <dt className="plugin-detail-info-key">{t('plugins.detail.category')}</dt>
                <dd className="plugin-detail-info-val">{category}</dd>
              </>
            )}
            {version && (
              <>
                <dt className="plugin-detail-info-key">{t('plugins.detail.version')}</dt>
                <dd className="plugin-detail-info-val">v{version}</dd>
              </>
            )}
            {homepage && (
              <>
                <dt className="plugin-detail-info-key">{t('plugins.detail.site')}</dt>
                <dd className="plugin-detail-info-val">
                  <a href={homepage} target="_blank" rel="noopener noreferrer" className="plugin-detail-link">
                    {homepage}
                    <ExternalLink size={11} />
                  </a>
                </dd>
              </>
            )}
          </dl>
        </section>
      )}

      {/* Collapsible "Detalhes técnicos" — ID + filesystem paths */}
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
