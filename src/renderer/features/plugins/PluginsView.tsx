import { AlertTriangle, ArrowLeft, Blocks, ChevronDown, RefreshCw, Search, Settings } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AvailablePlugin, Plugin, PluginError, PluginScope } from '../../../shared/plugins'
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

type PluginsViewProps = {
  onClose: () => void
  onSeedComposer?: (text: string) => void
  loadIcons?: boolean
}

// Cap of lines shown per section before the expander kicks in. Sections
// with <= CAP items render fully; > CAP shows CAP items + an expander row.
const SECTION_CAP = 6

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

export function PluginsView({ onClose, onSeedComposer, loadIcons = true }: PluginsViewProps) {
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

  // Group available plugins by category from marketplace manifests. Plugins
  // without a category go to "Outros" (always last). Sections ordered by
  // count desc. The marketplace source stays visible as discrete meta on
  // each line (not as the group key anymore).
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

  // ── Detail view branch ────────────────────────────────────────────
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
            setBusy(detailId, true)
            try {
              await install(selectedPlugin.plugin, scope)
              toast(t('plugins.install'), 'success')
              setSelectedPlugin(undefined)
            } catch (err) {
              toast(describePluginError(err as PluginError), 'error')
              throw err
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
              setSelectedPlugin(undefined)
            } catch (err) {
              toast(describePluginError(err as PluginError), 'error')
            } finally {
              setBusy(detailId, false)
            }
          }}
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
          <h1>{t('plugins.title')}</h1>
          <p>{t('plugins.subtitle')}</p>
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

      {/* Sticky search — stays fixed at top while list scrolls.
          Header (title+subtitle) scrolls away normally. */}
      <div className="plugins-search">
        <Search size={15} className="plugins-search-icon" />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('plugins.searchPlaceholder')}
          aria-label={t('plugins.searchPlaceholder')}
        />
      </div>

      {/* Installed icon-only strip — 40px monograms, no names.
          Gear icon opens marketplace modal (replaces big header button). */}
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
          {/* ── Installed lines ──────────────────────────────────── */}
          {filteredInstalled.length > 0 && (
            <>
              <p className="plugins-section-label">
                {t('plugins.installed')} ({filteredInstalled.length})
              </p>
              <div className="plugins-lines">
                {filteredInstalled.map((plugin, i) => (
                  <div key={plugin.id} style={{ animationDelay: `${i * 40}ms` }}>
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

          {/* ── Available lines (grouped by marketplace) ─────────── */}
          {availableLoading ? (
            <>
              <p className="plugins-section-label">{t('plugins.featured')}</p>
              <div className="plugins-lines">
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
                <p className="plugins-empty-title">{t('plugins.loadingCatalog')}</p>
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
                    {visible.map((plugin, i) => (
                      <div key={plugin.pluginId} style={{ animationDelay: `${i * 40}ms` }}>
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
