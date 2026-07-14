import { AlertTriangle, ArrowLeft, Blocks, RefreshCw, Search, Store } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AvailablePlugin, Plugin, PluginError, PluginScope } from '../../../shared/plugins'
import { describePluginError } from '../../../shared/plugins'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/Toast'
import { AvailablePluginCard, InstalledPluginCard, PluginSkeletonCard } from './PluginCard'
import { MarketplaceModal } from './MarketplaceModal'
import { PluginInstallModal } from './PluginInstallModal'
import { usePlugins } from './usePlugins'

type PluginsViewProps = {
  onClose: () => void
}

// Plugins marketplace view. Loads real data from the CLI via the Tauri
// bridge (pluginList + marketplaceList in parallel, then pluginAvailable
// which is slower and shows skeletons). Install/enable/disable/uninstall/
// update all hit the real backend — no mocks.
export function PluginsView({ onClose }: PluginsViewProps) {
  const { t } = useI18n()
  const { toast } = useToast()
  const {
    installed,
    available,
    marketplaces,
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
  // Track which plugin ids have an in-flight mutation (for per-card spinners).
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())

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
    // Exclude already-installed plugins from the Available section.
    const notInstalled = available.filter(p => !installedIds.has(p.pluginId))
    if (!normalizedQuery) return notInstalled
    return notInstalled.filter(p =>
      p.name.toLowerCase().includes(normalizedQuery) ||
      p.description.toLowerCase().includes(normalizedQuery),
    )
  }, [available, installedIds, normalizedQuery])

  // Group available by marketplace name — gives the user a clear provenance
  // signal (which marketplace each plugin comes from).
  const availableGroups = useMemo(() => {
    const groups = new Map<string, AvailablePlugin[]>()
    for (const plugin of filteredAvailable) {
      const key = plugin.marketplaceName
      const list = groups.get(key) ?? []
      list.push(plugin)
      groups.set(key, list)
    }
    return [...groups.entries()]
  }, [filteredAvailable])

  function setBusy(id: string, busy: boolean) {
    setBusyIds(prev => {
      const next = new Set(prev)
      if (busy) next.add(id)
      else next.delete(id)
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

  const showSkeletons = loading === 'loading'
  const showError = loading === 'error' && error

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
        <button
          type="button"
          className="ghost-button"
          onClick={() => setMarketplaceOpen(true)}
        >
          <Store size={15} />
          {t('plugins.manageMarketplaces')}
        </button>
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

      <div className="plugins-search">
        <Search size={15} className="plugins-search-icon" />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('plugins.searchPlaceholder')}
          aria-label={t('plugins.searchPlaceholder')}
        />
      </div>

      {showSkeletons ? (
        <>
          <p className="plugins-section-label">{t('plugins.installed')}</p>
          <div className="plugins-grid">
            {Array.from({ length: 4 }).map((_, i) => (
              <PluginSkeletonCard key={i} delay={i * 60} />
            ))}
          </div>
        </>
      ) : (
        <>
          {/* ── Installed ─────────────────────────────────────────── */}
          <p className="plugins-section-label">
            {t('plugins.installed')} ({filteredInstalled.length})
          </p>
          {filteredInstalled.length === 0 ? (
            <div className="plugins-empty">
              <div className="plugins-empty-icon"><Blocks size={24} /></div>
              <p className="plugins-empty-title">{t('plugins.noInstalled')}</p>
            </div>
          ) : (
            <div className="plugins-grid">
              {filteredInstalled.slice(0, 8).map((plugin, i) => (
                <div key={plugin.id} style={{ animationDelay: `${i * 40}ms` }}>
                  <InstalledPluginCard
                    plugin={plugin}
                    onToggle={enabled => void handleToggle(plugin, enabled)}
                    onUpdate={() => void handleUpdate(plugin)}
                    onUninstall={() => void handleUninstall(plugin)}
                    busy={busyIds.has(plugin.id)}
                  />
                </div>
              ))}
            </div>
          )}

          {/* ── Available ────────────────────────────────────────── */}
          {availableLoading ? (
            <>
              <p className="plugins-section-label">{t('plugins.featured')}</p>
              <div className="plugins-grid">
                {Array.from({ length: 6 }).map((_, i) => (
                  <PluginSkeletonCard key={i} delay={i * 60} />
                ))}
              </div>
            </>
          ) : availableError ? (
            // Catalog fetch failed but installed plugins are showing — scoped
            // empty state with retry, NOT a full-page error banner.
            <div className="plugins-empty">
              <div className="plugins-empty-icon"><AlertTriangle size={22} /></div>
              <p className="plugins-empty-title">{t('plugins.catalogError')}</p>
              <p className="plugins-empty-body">{t('plugins.catalogErrorBody')}</p>
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
            availableGroups.map(([groupKey, plugins]) => (
              <div key={groupKey}>
                <p className="plugins-section-label">
                  {t('plugins.featured')} — {groupKey}
                </p>
                <div className="plugins-grid">
                  {plugins.slice(0, 8).map((plugin, i) => (
                    <div key={plugin.pluginId} style={{ animationDelay: `${i * 40}ms` }}>
                      <AvailablePluginCard
                        plugin={plugin}
                        onInstall={() => setInstallTarget(plugin)}
                        busy={busyIds.has(plugin.pluginId)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))
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
