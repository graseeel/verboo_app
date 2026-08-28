import { AlertTriangle, ArrowLeft, Blocks, ChevronDown, RefreshCw, Search, Settings, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AvailablePlugin, Plugin, PluginError, PluginScope, PluginSkill } from '../../../shared/plugins'
import { describePluginError } from '../../../shared/plugins'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/Toast'
import { AvailablePluginCard, InstalledPluginCard, PluginIcon, PluginSkeletonCard } from './PluginCard'
import { MarketplaceModal } from './MarketplaceModal'
import { PluginDetailView } from './PluginDetailView'
import { PluginInstallModal } from './PluginInstallModal'
import { marketplaceFriendlyName } from './marketplaceNames'
import { usePlugins } from './usePlugins'
import { invalidatePluginIconCache } from './usePluginIcon'
import { OfficialChromeIntegrationCard } from './OfficialChromeIntegrationCard'

type PluginsViewProps = {
  onClose: () => void
  onSeedComposer?: (text: string) => void
  onUsePlugin?: (payload: { skillPath?: string; pluginId: string; pluginName: string; suggestion?: string }) => void
  loadIcons?: boolean
  onManageChromeIntegration: () => void
}

// Cap of lines shown per section before the expander kicks in. Sections
// with <= CAP items render fully; > CAP shows CAP items + an expander row.
const SECTION_CAP = 6

// Deterministic title-case from kebab-case skill names.
// brainstorming → Brainstorming, dispatching-parallel-agents → Dispatching Parallel Agents.
function titleCaseSkill(name: string): string {
  return name
    .split('-')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function catalogErrorMessage(err: PluginError, t: (key: string) => string): string {
  switch (err.kind) {
    case 'network_error':
      return t('plugins.catalogError.network')
    case 'parse_error':
      return t('plugins.catalogError.parse')
    case 'timeout':
      return t('plugins.catalogError.timeout')
    default:
      return t('plugins.catalogError.unknown')
  }
}

// Expander row: 3 overlapping mini-monograms (20px, ~40% overlap) + text
// "Ver {n1}, {n2} e mais {N}". Click expands the section inline.
// `plugins` = the hidden plugins (beyond the cap) that will be revealed.
function SectionExpander({ plugins, onExpand, loadIcons = true }: {
  plugins: AvailablePlugin[]
  onExpand: () => void
  loadIcons?: boolean
}) {
  const { t } = useI18n()
  const preview = plugins.slice(0, 3)
  const remaining = plugins.length - preview.length
  const names = preview.map(p => p.name)
  return (
    <button type="button" className="plugin-section-expander" onClick={onExpand}>
      <div className="plugin-expander-stack">
        {preview.map((p, i) => (
          <div
            key={p.pluginId}
            className="plugin-expander-mini"
            style={{ zIndex: preview.length - i, marginLeft: i === 0 ? 0 : -8 }}
          >
            <PluginIcon name={p.name} id={p.pluginId} size={20} loadIcons={loadIcons} />
          </div>
        ))}
      </div>
      <span className="plugin-expander-text">
        {t('plugins.expander', { name1: names[0] ?? '', name2: names[1] ?? '', count: remaining })}
      </span>
      <ChevronDown size={14} className="plugin-expander-chevron" />
    </button>
  )
}

export function PluginsView({ onClose, onSeedComposer, onUsePlugin, loadIcons = true, onManageChromeIntegration }: PluginsViewProps) {
  const { t } = useI18n()
  const { toast } = useToast()
  const {
    installed,
    available,
    marketplaces,
    manifests,
    loading,
    availableLoading,
    error,
    availableError,
    pendingRestartPluginIds,
    refreshAll,
    install,
    enable,
    disable,
    uninstall,
    update,
    addMarketplace,
    removeMarketplace,
    dismissRestartBanner,
  } = usePlugins()

  const [query, setQuery] = useState('')
  const [installTarget, setInstallTarget] = useState<AvailablePlugin | undefined>(undefined)
  const [marketplaceOpen, setMarketplaceOpen] = useState(false)
  const [selectedPlugin, setSelectedPlugin] = useState<
    | { kind: 'installed'; plugin: Plugin }
    | { kind: 'available'; plugin: AvailablePlugin }
    | undefined
  >(undefined)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  // Track which marketplace sections are expanded (by group key).
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())
  // Tab state: 'plugins' (catalog) or 'skills' (all skills from installed).
  // Preserved when navigating to detail and back — the tab doesn't reset
  // because selectedPlugin is a separate state that swaps the render branch.
  const [activeTab, setActiveTab] = useState<'plugins' | 'skills'>('plugins')
  // Skills for ALL installed plugins, keyed by plugin id. Fetched once when
  // the Skills tab is first opened (lazy) or when installed list changes.
  const [allSkills, setAllSkills] = useState<Record<string, PluginSkill[]>>({})
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsExpanded, setSkillsExpanded] = useState(false)

  // Sentinel-based detection for the sticky search bar. CSS has no
  // :stuck pseudo-class, so we render a 1px sentinel immediately before
  // .plugins-search and observe it via IntersectionObserver against the
  // .workspace scroll container. When the sentinel scrolls out of view,
  // the bar is effectively pinned at top:0 and we toggle is-stuck so the
  // opaque ::before/::after pseudo-elements start painting. Without this,
  // those pseudo-elements would always cover the tab buttons sitting
  // directly above the bar before any scroll happens.
  const stickySentinelRef = useRef<HTMLDivElement | null>(null)
  const [isStuck, setIsStuck] = useState(false)
  useEffect(() => {
    const sentinel = stickySentinelRef.current
    if (!sentinel) return
    const scrollContainer = sentinel.closest<HTMLElement>('.workspace')
    if (!scrollContainer || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) setIsStuck(!entry.isIntersecting)
      },
      { root: scrollContainer, threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [selectedPlugin === undefined])

  // Invalidate the icon cache when manifests arrive. A plugin that returned
  // null earlier (manifests not loaded yet on the backend → no homepage →
  // null iconPath) may now have a homepage in the freshly-loaded manifest.
  // Clearing the cache lets the next render re-fetch with the new data.
  // This fixes the "lines that never called plugin_icon" bug: the first
  // fetch happened before manifests were ready, cached null, and the hook
  // never retried.
  useEffect(() => {
    if (Object.keys(manifests).length > 0) {
      invalidatePluginIconCache()
    }
  }, [manifests])

  // Fetch skills for all installed plugins when the Skills tab is opened.
  // Lazy: only fires when activeTab === 'skills' and we haven't fetched yet
  // for the current installed set. Re-fetches if installed list changes (ex:
  // after install/uninstall) to keep the skills list fresh.
  useEffect(() => {
    if (activeTab !== 'skills' || installed.length === 0) return
    let cancelled = false
    setSkillsLoading(true)
    Promise.all(
      installed.map(plugin =>
        window.verboo.pluginSkills(plugin.id)
          .then(skills => [plugin.id, skills] as const)
          .catch(() => [plugin.id, [] as PluginSkill[]] as const),
      ),
    ).then(results => {
      if (cancelled) return
      const map: Record<string, PluginSkill[]> = {}
      for (const [id, skills] of results) {
        map[id] = skills
      }
      setAllSkills(map)
      setSkillsLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab, installed])

  const normalizedQuery = query.trim().toLowerCase()

  const filteredInstalled = useMemo(() => {
    if (!normalizedQuery) return installed
    return installed.filter(p =>
      p.name.toLowerCase().includes(normalizedQuery) ||
      (p.description?.toLowerCase().includes(normalizedQuery) ?? false),
    )
  }, [installed, normalizedQuery])

  const installedIds = useMemo(() => new Set(installed.map(p => p.id)), [installed])

  const filteredAvailable = useMemo(() => {
    const notInstalled = available.filter(p => !installedIds.has(p.pluginId))
    if (!normalizedQuery) return notInstalled
    return notInstalled.filter(p =>
      p.name.toLowerCase().includes(normalizedQuery) ||
      p.description.toLowerCase().includes(normalizedQuery),
    )
  }, [available, installedIds, normalizedQuery])

  // Marketplace source stays visible as per-line meta; grouping key is the manifest category.
  const availableGroups = useMemo(() => {
    const groups = new Map<string, AvailablePlugin[]>()
    const uncategorized: AvailablePlugin[] = []
    for (const plugin of filteredAvailable) {
      const manifest = manifests[plugin.pluginId]
      const category = manifest?.category?.trim()
      if (category) {
        const list = groups.get(category) ?? []
        list.push(plugin)
        groups.set(category, list)
      } else {
        uncategorized.push(plugin)
      }
    }
    // Sort categories by count desc, then name asc for stable order.
    const sorted = [...groups.entries()].sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length
      return a[0].localeCompare(b[0])
    })
    // "Outros" always last, only if non-empty.
    if (uncategorized.length > 0) {
      sorted.push([t('plugins.categoryOthers'), uncategorized])
    }
    return sorted
  }, [filteredAvailable, manifests, t])

  // Skills tab renders this flat (Codex parity); each row carries its source plugin name.
  const flatSkills = useMemo(() => {
    const list: Array<{ skill: PluginSkill; pluginName: string }> = []
    for (const plugin of installed) {
      const skills = allSkills[plugin.id] ?? []
      for (const skill of skills) {
        list.push({ skill, pluginName: plugin.name })
      }
    }
    const filtered = normalizedQuery
      ? list.filter(({ skill }) => {
          const name = skill.name.toLowerCase()
          const desc = (skill.description ?? '').toLowerCase()
          return name.includes(normalizedQuery) || desc.includes(normalizedQuery)
        })
      : list
    return filtered.sort((a, b) => a.skill.name.localeCompare(b.skill.name))
  }, [installed, allSkills, normalizedQuery])

  function setBusy(id: string, busy: boolean) {
    setBusyIds(prev => {
      const next = new Set(prev)
      if (busy) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleSection(key: string) {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function switchTab(nextTab: 'plugins' | 'skills') {
    if (nextTab === activeTab) return
    setActiveTab(nextTab)
    setQuery('')
  }

  async function handleToggle(plugin: Plugin, enabled: boolean) {
    setBusy(plugin.id, true)
    try {
      if (enabled) {
        await enable(plugin.id, plugin.scope)
        toast(t('plugins.enable'), 'success')
      } else {
        await disable(plugin.id, plugin.scope)
        toast(t('plugins.disable'), 'success')
      }
    } catch (err) {
      toast(describePluginError(err as PluginError), 'error')
    } finally {
      setBusy(plugin.id, false)
    }
  }

  async function handleUpdate(plugin: Plugin) {
    setBusy(plugin.id, true)
    try {
      await update(plugin.id, plugin.scope)
      toast(t('plugins.update'), 'success')
    } catch (err) {
      toast(describePluginError(err as PluginError), 'error')
    } finally {
      setBusy(plugin.id, false)
    }
  }

  async function handleUninstall(plugin: Plugin) {
    if (!window.confirm(t('plugins.uninstall') + ' — ' + plugin.name)) return
    setBusy(plugin.id, true)
    try {
      await uninstall(plugin.id, plugin.scope)
      toast(t('plugins.uninstall'), 'success')
    } catch (err) {
      toast(describePluginError(err as PluginError), 'error')
    } finally {
      setBusy(plugin.id, false)
    }
  }

  async function handleInstallConfirm(scope: PluginScope) {
    if (!installTarget) return
    setBusy(installTarget.pluginId, true)
    try {
      await install(installTarget, scope)
      toast(t('plugins.install'), 'success')
    } catch (err) {
      toast(describePluginError(err as PluginError), 'error')
      throw err
    } finally {
      setBusy(installTarget.pluginId, false)
    }
  }

  async function handleInstallOneClick(plugin: AvailablePlugin) {
    setBusy(plugin.pluginId, true)
    try {
      await install(plugin, 'user')
      toast(t('plugins.install'), 'success')
    } catch (err) {
      toast(describePluginError(err as PluginError), 'error')
    } finally {
      setBusy(plugin.pluginId, false)
    }
  }

  // Testar agora: fetch the plugin's skills, seed the composer with the 1st
  // skill description (fallback: plugin description), close PluginsView,
  // and focus the composer. The text is NOT sent — user reviews + hits enter.
  async function handleTestNow(plugin: Plugin) {
    let seedText = plugin.description ?? ''
    try {
      const skills = await window.verboo.pluginSkills(plugin.id)
      if (skills[0]?.description) {
        seedText = skills[0].description
      }
    } catch {
      // skills fetch failed — fall back to plugin description (already set)
    }
    onSeedComposer?.(seedText)
  }

  const showSkeletons = loading === 'loading'
  const showError = loading === 'error' && error

  if (selectedPlugin) {
    const detailId = selectedPlugin.kind === 'installed' ? selectedPlugin.plugin.id : selectedPlugin.plugin.pluginId
    return (
      <div className="plugins-view page-surface">
        <PluginDetailView
          target={selectedPlugin}
          manifests={manifests}
          loadIcons={loadIcons}
          onBack={() => setSelectedPlugin(undefined)}
          onInstall={async (scope: PluginScope) => {
            if (selectedPlugin.kind !== 'available') return
            const pid = selectedPlugin.plugin.pluginId
            setBusy(detailId, true)
            try {
              await install(selectedPlugin.plugin, scope)
              toast(t('plugins.install'), 'success')
              // Stay on detail — re-fetch and transition to installed state.
              void window.verboo.pluginList().then(list => {
                const np = list.find(p => p.id === pid)
                if (np) setSelectedPlugin({ kind: 'installed', plugin: np })
              }).finally(refreshAll)
            } catch (err) {
              toast(describePluginError(err as PluginError), 'error')
            } finally {
              setBusy(detailId, false)
            }
          }}
          onUninstall={async () => {
            if (selectedPlugin.kind !== 'installed') return
            const plugin = selectedPlugin.plugin
            if (!window.confirm(t('plugins.uninstall') + ' — ' + plugin.name)) return
            setBusy(detailId, true)
            try {
              await uninstall(plugin.id, plugin.scope)
              toast(t('plugins.uninstall'), 'success')
              // Stay on detail as available — re-fetch and transition.
              void window.verboo.pluginAvailable().then(pa => {
                const ap = pa.available.find(p => p.pluginId === plugin.id)
                if (ap) setSelectedPlugin({ kind: 'available', plugin: ap })
              }).finally(refreshAll)
            } catch (err) {
              toast(describePluginError(err as PluginError), 'error')
            } finally {
              setBusy(detailId, false)
            }
          }}
          onUsePlugin={onUsePlugin ? (skill) => onUsePlugin(skill) : undefined}
          onToggle={async (enabled: boolean) => {
            if (selectedPlugin.kind !== 'installed') return
            const plugin = selectedPlugin.plugin
            setBusy(detailId, true)
            try {
              if (enabled) {
                await enable(plugin.id, plugin.scope)
                toast(t('plugins.enable'), 'success')
              } else {
                await disable(plugin.id, plugin.scope)
                toast(t('plugins.disable'), 'success')
              }
              // Re-fetch so the badge / enabled flag updates in-place.
              void window.verboo.pluginList().then(list => {
                const np = list.find(p => p.id === plugin.id)
                if (np) setSelectedPlugin({ kind: 'installed', plugin: np })
              }).finally(refreshAll)
            } catch (err) {
              toast(describePluginError(err as PluginError), 'error')
            } finally {
              setBusy(detailId, false)
            }
          }}
          busy={busyIds.has(detailId)}
        />
      </div>
    )
  }

  return (
    <div className="plugins-view page-surface">
      <header className="plugins-view-header">
        <div>
          <button className="profile-back" type="button" onClick={onClose}>
            <ArrowLeft size={14} />
            {t('plugins.back')}
          </button>
          <h1>{activeTab === 'skills' ? t('plugins.skillsTitle') : t('plugins.title')}</h1>
          <p>{activeTab === 'skills' ? t('plugins.skillsSubtitle') : t('plugins.subtitle')}</p>
        </div>
      </header>

      {pendingRestartPluginIds.size > 0 && (
        <div className="plugins-restart-banner">
          <RefreshCw size={14} />
          <span>{t('plugins.restartBody')}</span>
          <button type="button" onClick={dismissRestartBanner}>
            {t('plugins.restartLater')}
          </button>
        </div>
      )}

      {showError && (
        <div className="plugins-error-banner">
          <AlertTriangle size={14} />
          <span>{describePluginError(error)}</span>
          <button type="button" onClick={() => void refreshAll()}>
            {t('plugins.retry')}
          </button>
        </div>
      )}

      {/* Segmented control: Plugins | Habilidades. */}
      <div className="plugins-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'plugins'}
          className={`plugins-tab ${activeTab === 'plugins' ? 'is-active' : ''}`}
          onClick={() => switchTab('plugins')}
        >
          {t('plugins.tabs.plugins')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'skills'}
          className={`plugins-tab ${activeTab === 'skills' ? 'is-active' : ''}`}
          onClick={() => switchTab('skills')}
        >
          {t('plugins.tabs.skills')}
        </button>
      </div>

      {/* 1px sentinel watched by the IntersectionObserver above — drives is-stuck. */}
      <div ref={stickySentinelRef} className="plugins-sticky-sentinel" aria-hidden="true" style={{ height: '1px' }} />

      {/* Sticky search bar; placeholder follows the active tab. */}
      <div className={`plugins-search${isStuck ? ' is-stuck' : ''}`}>
        <Search size={15} className="plugins-search-icon" />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={activeTab === 'skills' ? t('plugins.searchSkillsPlaceholder') : t('plugins.searchPlaceholder')}
          aria-label={activeTab === 'skills' ? t('plugins.searchSkillsPlaceholder') : t('plugins.searchPlaceholder')}
        />
      </div>

      {/* Plugins tab */}
      {activeTab === 'plugins' && (
      <div>
      <section className="plugins-official-section">
        <p className="plugins-section-label">{t('plugins.chrome.section')}</p>
        <OfficialChromeIntegrationCard onManage={onManageChromeIntegration} />
      </section>
      {/* Installed icon-only strip; gear opens the marketplace modal. */}
      {!showSkeletons && installed.length > 0 && (
        <div className="plugins-installed-section">
          <div className="plugins-installed-header">
            <span className="plugins-section-label">{t('plugins.installed')}</span>
            <button
              type="button"
              className="plugins-installed-gear"
              onClick={() => setMarketplaceOpen(true)}
              aria-label={t('plugins.manageMarketplaces')}
              title={t('plugins.manageMarketplaces')}
            >
              <Settings size={15} />
            </button>
          </div>
          <div className="plugins-installed-strip" role="list">
            {installed.map(plugin => {
              const sel = selectedPlugin as { kind: string; plugin: { id: string } } | undefined
              const isActive = sel?.kind === 'installed' && sel.plugin.id === plugin.id
              return (
                <button
                  key={plugin.id}
                  type="button"
                  role="listitem"
                  className={`plugins-strip-icon ${isActive ? 'is-active' : ''} ${plugin.enabled ? 'is-enabled' : 'is-disabled'}`}
                  onClick={() => setSelectedPlugin({ kind: 'installed', plugin })}
                  title={plugin.name}
                  aria-label={plugin.name}
                >
                  <PluginIcon name={plugin.name} id={plugin.id} size={40} loadIcons={loadIcons} />
                </button>
              )
            })}
          </div>
        </div>
      )}

      {showSkeletons ? (
        <>
          <p className="plugins-section-label">{t('plugins.installed')}</p>
          <div className="plugins-lines">
            {Array.from({ length: 4 }).map((_, i) => (
              <PluginSkeletonCard key={i} delay={i * 60} />
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Installed lines */}
          {filteredInstalled.length > 0 && (
            <>
              <p className="plugins-section-label">
                {t('plugins.installed')} ({filteredInstalled.length})
              </p>
              <div className="plugins-lines">
                {filteredInstalled.map(plugin => (
                  <div key={plugin.id}>
                    <InstalledPluginCard
                      plugin={plugin}
                      onToggle={enabled => void handleToggle(plugin, enabled)}
                      onUpdate={() => void handleUpdate(plugin)}
                      onUninstall={() => void handleUninstall(plugin)}
                      onOpenDetail={() => setSelectedPlugin({ kind: 'installed', plugin })}
                      onTestNow={onSeedComposer ? () => void handleTestNow(plugin) : undefined}
                      loadIcons={loadIcons}
                      busy={busyIds.has(plugin.id)}
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Available lines, grouped by marketplace */}
          {availableLoading ? (
            <>
              <p className="plugins-section-label">{t('plugins.featured')}</p>
              <div
                className="plugins-lines"
                role="status"
                aria-label={t('plugins.loadingCatalog')}
              >
                {Array.from({ length: 6 }).map((_, i) => (
                  <PluginSkeletonCard key={i} delay={i * 60} />
                ))}
              </div>
            </>
          ) : availableError ? (
            <div className="plugins-empty">
              <div className="plugins-empty-icon"><AlertTriangle size={22} /></div>
              <p className="plugins-empty-title">{t('plugins.catalogError')}</p>
              <p className="plugins-empty-body">{catalogErrorMessage(availableError, t)}</p>
              <button type="button" className="ghost-button" onClick={() => void refreshAll()}>
                {t('plugins.retry')}
              </button>
            </div>
          ) : filteredAvailable.length === 0 ? (
            normalizedQuery && installed.length > 0 ? null : (
              <div className="plugins-empty">
                <div className="plugins-empty-icon"><Blocks size={24} /></div>
                <p className="plugins-empty-title">{t('plugins.emptyTitle')}</p>
                <p className="plugins-empty-body">{t('plugins.empty')}</p>
              </div>
            )
          ) : (
            availableGroups.map(([groupKey, plugins]) => {
              const isExpanded = expandedSections.has(groupKey)
              const visible = isExpanded ? plugins : plugins.slice(0, SECTION_CAP)
              const hasExpander = plugins.length > SECTION_CAP
              return (
                <div key={groupKey} className="plugins-section">
                  <p className="plugins-section-label">
                    {groupKey}
                  </p>
                  <div className="plugins-lines">
                    {visible.map(plugin => (
                      <div key={plugin.pluginId}>
                        <AvailablePluginCard
                          plugin={plugin}
                          onInstall={() => void handleInstallOneClick(plugin)}
                          onOpenDetail={() => setSelectedPlugin({ kind: 'available', plugin })}
                          loadIcons={loadIcons}
                          busy={busyIds.has(plugin.pluginId)}
                        />
                      </div>
                    ))}
                  </div>
                  {hasExpander && !isExpanded && (
                    <SectionExpander
                      plugins={plugins.slice(SECTION_CAP)}
                      onExpand={() => toggleSection(groupKey)}
                      loadIcons={loadIcons}
                    />
                  )}
                  {hasExpander && isExpanded && (
                    <button
                      type="button"
                      className="plugin-section-expander"
                      onClick={() => toggleSection(groupKey)}
                    >
                      <ChevronDown size={14} className="plugin-expander-chevron is-up" />
                      <span className="plugin-expander-text">{t('plugins.showLess')}</span>
                    </button>
                  )}
                </div>
              )
            })
          )}
        </>
      )}
      </div>
      )}

      {/* Skills tab */}
      {activeTab === 'skills' && (
      <div>
        {skillsLoading ? (
          <div className="plugins-lines">
            {Array.from({ length: 4 }).map((_, i) => (
              <PluginSkeletonCard key={i} delay={i * 60} />
            ))}
          </div>
        ) : flatSkills.length === 0 ? (
          <div className="plugins-empty">
            <div className="plugins-empty-icon"><Zap size={24} /></div>
            <p className="plugins-empty-title">{t('plugins.skillsEmptyTitle')}</p>
            <p className="plugins-empty-body">{t('plugins.skillsEmptyBody')}</p>
            <button type="button" className="ghost-button" onClick={() => switchTab('plugins')}>
              {t('plugins.skillsEmptyCta')}
            </button>
          </div>
        ) : (
          <>
            <div className="plugins-lines">
              {(skillsExpanded ? flatSkills : flatSkills.slice(0, SECTION_CAP)).map(({ skill, pluginName }) => (
                <div key={skill.skillPath}>
                  <div className="plugin-line plugin-line--skill" role="button" tabIndex={0}>
                    <div className="plugin-skill-icon plugin-skill-icon--line" aria-hidden="true">
                      <Zap size={16} />
                    </div>
                    <div className="plugin-line-body">
                      <div className="plugin-line-name">{titleCaseSkill(skill.name)}</div>
                      {skill.description && (
                        <div className="plugin-line-desc">{skill.description}</div>
                      )}
                      <div className="plugin-line-meta">{pluginName}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {flatSkills.length > SECTION_CAP && (
              <button
                type="button"
                className="plugin-section-expander"
                onClick={() => setSkillsExpanded(open => !open)}
              >
                {skillsExpanded ? (
                  <>
                    <ChevronDown size={14} className="plugin-expander-chevron is-up" />
                    <span className="plugin-expander-text">{t('plugins.showLess')}</span>
                  </>
                ) : (
                  <span className="plugin-expander-text">
                    {t('plugins.skillsExpander', {
                      name1: titleCaseSkill(flatSkills[SECTION_CAP].skill.name),
                      name2: titleCaseSkill(flatSkills[SECTION_CAP + 1]?.skill.name ?? ''),
                      count: flatSkills.length - SECTION_CAP,
                    })}
                  </span>
                )}
              </button>
            )}
          </>
        )}
      </div>
      )}

      {installTarget && (
        <PluginInstallModal
          plugin={installTarget}
          onConfirm={handleInstallConfirm}
          onClose={() => setInstallTarget(undefined)}
        />
      )}

      {marketplaceOpen && (
        <MarketplaceModal
          marketplaces={marketplaces}
          onAdd={addMarketplace}
          onRemove={removeMarketplace}
          onClose={() => setMarketplaceOpen(false)}
        />
      )}
    </div>
  )
}
