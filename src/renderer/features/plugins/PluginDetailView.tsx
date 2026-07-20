import { ArrowLeft, ChevronDown, Download, ExternalLink, Play, Power, Trash2, Zap } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AvailablePlugin, MarketplaceManifestMap, Plugin, PluginDetail, PluginError, PluginScope, PluginSkill } from '../../../shared/plugins'
import { describePluginError, OFFICIAL_MARKETPLACES } from '../../../shared/plugins'
import { useI18n } from '../../i18n'
import { monogramColor, pluginHue, PluginIcon } from './PluginCard'
import { marketplaceFriendlyName } from './marketplaceNames'

type DetailTarget =
  | { kind: 'installed'; plugin: Plugin }
  | { kind: 'available'; plugin: AvailablePlugin }

type PluginDetailViewProps = {
  target: DetailTarget
  manifests: MarketplaceManifestMap
  loadIcons?: boolean
  onBack: () => void
  onInstall?: (scope: PluginScope) => Promise<void>
  onUninstall?: () => Promise<void>
  onToggle?: (enabled: boolean) => Promise<void>
  onUsePlugin?: (payload: { skillPath?: string; pluginId: string; pluginName: string; suggestion?: string }) => void
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
export function PluginDetailView({ target, manifests, loadIcons = true, onBack, onInstall, onUninstall, onToggle, onUsePlugin, busy, error }: PluginDetailViewProps) {
  const { t } = useI18n()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detail, setDetail] = useState<PluginDetail | undefined>(undefined)
  const [skills, setSkills] = useState<PluginSkill[]>([])
  const isInstalled = target.kind === 'installed'
  const [skillsLoading, setSkillsLoading] = useState(!isInstalled)
  const [resting, setResting] = useState(true)
  const [isHeaderStuck, setIsHeaderStuck] = useState(false)
  const headerObserverRef = useRef<IntersectionObserver | undefined>(undefined)

  // ── Mouse parallax for hero mesh ──────────────────────────────────
  // pointermove (rAF-throttled to ~30fps) updates --mouse-x/--mouse-y (0-1)
  // on the hero element. CSS layers shift positions by different factors
  // (parallax). Each update re-resolves 4+ radial-gradients = repaint of
  // the hero area, so we gate to every other frame (~33ms) — visually
  // identical to 60fps for a decorative drift, halves paint cost.
  // Disabled under reduced-motion and on touch/coarse pointers.
  const heroRef = useRef<HTMLDivElement | null>(null)
  const rafId = useRef<number | undefined>(undefined)
  const lastUpdateMs = useRef(0)
  const PARALLAX_MIN_INTERVAL_MS = 33
  const reduceMotion = useRef(
    typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const canHover = useRef(
    typeof window !== 'undefined'
      && window.matchMedia('(hover: hover) and (pointer: fine)').matches,
  )

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!canHover.current || reduceMotion.current) return
    const el = heroRef.current
    if (!el) return
    const now = event.timeStamp
    if (now - lastUpdateMs.current < PARALLAX_MIN_INTERVAL_MS) return
    const rect = el.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width
    const y = (event.clientY - rect.top) / rect.height
    if (rafId.current !== undefined) return
    if (resting) setResting(false)
    rafId.current = requestAnimationFrame(() => {
      rafId.current = undefined
      lastUpdateMs.current = now
      el.style.setProperty('--mouse-x', x.toFixed(3))
      el.style.setProperty('--mouse-y', y.toFixed(3))
    })
  }, [resting])

  const handlePointerLeave = useCallback(() => {
    if (!canHover.current || reduceMotion.current) return
    const el = heroRef.current
    if (!el) return
    if (rafId.current !== undefined) {
      cancelAnimationFrame(rafId.current)
      rafId.current = undefined
    }
    setResting(true)
    // Reset to center (0.5, 0.5). Because --mouse-x/--mouse-y are registered
    // as @property <number>, the browser interpolates between current values
    // and 0.5 over the transition declared on the mesh — resting variant uses
    // 700ms var(--dropdown-ease), active tracking 160ms linear.
    el.style.setProperty('--mouse-x', '0.5')
    el.style.setProperty('--mouse-y', '0.5')
  }, [])

  useEffect(() => {
    return () => {
      if (rafId.current !== undefined) cancelAnimationFrame(rafId.current)
    }
  }, [])

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
      setSkillsLoading(false)
      return
    }
    let cancelled = false
    setSkillsLoading(true)
    window.verboo.pluginDetail(pluginId).then(d => { if (!cancelled) setDetail(d) }).catch(() => {})
    window.verboo.pluginSkills(pluginId).then(s => { if (!cancelled) { setSkills(s); setSkillsLoading(false) } }).catch(() => { if (!cancelled) setSkillsLoading(false) })
    return () => { cancelled = true }
  }, [isInstalled, pluginId])

  // Chip phrase: 1st skill description (installed with skills), fallback
  // to plugin description. Empty desc → chip shows monogram+name only.
  const chipPhrase = skills[0]?.description ?? fullDescription

  // Up to 3 suggestion pills derived from skills.
  // ITEM C: prefill NUNCA mais recebe descrição. Se o manifest tiver examples
  // (e marketplace ∈ OFFICIAL_MARKETPLACES) → primeiro exemplo vira prefill.
  // Sem examples → suggestion = '' (só @token + espaço, usuário digita).
  const isOfficial = pluginId.split('@')[1] ? OFFICIAL_MARKETPLACES.includes(pluginId.split('@')[1]) : false
  const manifestEntry = manifests[pluginId]
  const manifestExamples = isOfficial ? manifestEntry?.examples : undefined
  const heroSuggestions = useMemo(() => {
    if (skills.length > 0) {
      return skills.slice(0, 3).map(s => {
        const fullDesc = s.description ?? ''
        const firstSentence = fullDesc.match(/^(.+?\.)(?:\s|$)/)?.[1] ?? fullDesc
        const firstExample = manifestExamples?.[0]
        return {
          skillPath: s.skillPath,
          pillLabel: s.name,
          pillDesc: (firstExample ?? firstSentence).length > 56
            ? (firstExample ?? firstSentence).slice(0, 56) + '…'
            : (firstExample ?? firstSentence),
          fullSuggestion: firstExample ?? '',
        }
      })
    }
    if (chipPhrase) {
      return [{
        skillPath: undefined,
        pillLabel: name,
        pillDesc: chipPhrase.length > 56 ? chipPhrase.slice(0, 56) + '…' : chipPhrase,
        fullSuggestion: manifestExamples?.[0] ?? '',
      }]
    }
    return []
  }, [skills, pluginId, name, chipPhrase, manifestExamples])

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

      {/* Sticky header sentinel — callback ref per container (no dangling observer). */}
      <div ref={node => {
        headerObserverRef.current?.disconnect()
        if (!node || typeof IntersectionObserver === 'undefined') return
        const scrollContainer = node.closest<HTMLElement>('.workspace')
        if (!scrollContainer) return
        headerObserverRef.current = new IntersectionObserver(
          entries => setIsHeaderStuck(!entries[0].isIntersecting),
          { root: scrollContainer, threshold: 0 },
        )
        headerObserverRef.current.observe(node)
      }} className="plugins-sticky-sentinel" />

      {/* Sticky header */}
      <div className={`plugin-detail-header${isHeaderStuck ? ' is-stuck' : ''}`}>
        <div className="plugin-detail-header-left">
          <PluginIcon name={name} id={pluginId} size={56} loadIcons={loadIcons} />
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
              {onUsePlugin && skills.length > 0 && (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => onUsePlugin({ skillPath: skills[0]?.skillPath, pluginId, pluginName: name, suggestion: '' })}
                >
                  <Play size={14} />
                  {t('plugins.testNow')}
                </button>
              )}
              <button
                type="button"
                className="ghost-button"
                onClick={() => void onToggle?.(!enabled)}
                disabled={busy}
              >
                {busy ? <span className="btn-spinner" /> : <Power size={14} />}
                {busy ? t('plugins.disabling') : (enabled ? t('plugins.disable') : t('plugins.enable'))}
              </button>
              <button
                type="button"
                className="plugin-uninstall-btn"
                onClick={() => void onUninstall?.()}
                disabled={busy}
              >
                {busy ? <span className="btn-spinner" /> : <Trash2 size={14} />}
                {busy ? t('plugins.uninstalling') : t('plugins.uninstall')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="plugin-install-pill"
              onClick={() => void onInstall?.('user')}
              disabled={busy}
            >
              {busy ? <span className="btn-spinner" /> : <Download size={14} />}
              {busy ? t('plugins.installing') : t('plugins.install')}
            </button>
          )}
        </div>
      </div>

      {/* Hero band — Verboo violet mesh + glass chip. Mouse parallax
          shifts mesh layers by different factors (disabled under
          reduced-motion / touch). */}
      <div
        ref={heroRef}
        className={`plugin-detail-hero${resting ? ' is-resting' : ''}`}
        style={{
          '--plugin-hero-color': monogramColor(pluginId),
          '--plugin-hero-hue': pluginHue(pluginId),
          '--mouse-x': '0.5',
          '--mouse-y': '0.5',
        } as React.CSSProperties}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        <div className="plugin-detail-hero-mesh" aria-hidden="true" />
        <div className="plugin-detail-hero-content" style={{ minHeight: skillsLoading ? '120px' : heroSuggestions.length <= 1 ? '180px' : heroSuggestions.length === 2 ? '200px' : '224px' } as React.CSSProperties}>
          {skillsLoading ? (
            <div className="plugin-hero-pills"><div className="plugin-hero-pill plugin-skel-pulse" /></div>
          ) : heroSuggestions.length > 0 && (
            <div className="plugin-hero-pills">
              {heroSuggestions.map(({ skillPath, pillLabel, pillDesc, fullSuggestion }: { skillPath: string | undefined; pillLabel: string; pillDesc: string; fullSuggestion: string }) => {
                if (isInstalled && onUsePlugin) {
                  return (
                    <button key={skillPath ?? pillLabel} className="plugin-hero-pill" type="button" onClick={() => onUsePlugin({ skillPath, pluginId, pluginName: name, suggestion: fullSuggestion })}>
                      <PluginIcon name={name} id={pluginId} size={20} loadIcons={loadIcons} />
                      <div className="plugin-hero-pill-text">
                        <span className="plugin-hero-pill-name">{pillLabel}</span>
                        <span className="plugin-hero-pill-desc">{pillDesc}</span>
                      </div>
                      <ArrowLeft size={14} className="plugin-hero-pill-arrow" />
                    </button>
                  )
                }
                return (
                  <div key={skillPath ?? pillLabel} className="plugin-hero-pill plugin-hero-pill-static">
                    <PluginIcon name={name} id={pluginId} size={20} loadIcons={loadIcons} />
                    <div className="plugin-hero-pill-text">
                      <span className="plugin-hero-pill-name">{pillLabel}</span>
                      <span className="plugin-hero-pill-desc">{pillDesc}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
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
