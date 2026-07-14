import { Check, Download, MoreHorizontal, Power, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AvailablePlugin, Plugin, PluginScope } from '../../../shared/plugins'
import { useI18n } from '../../i18n'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'

type InstalledCardProps = {
  plugin: Plugin
  onToggle: (enabled: boolean) => void
  onUpdate: () => void
  onUninstall: () => void
  busy?: boolean
}

// Installed plugin card: name, version, description, enable toggle, and a
// ⋯ menu with Update + Uninstall. The toggle is optimistic — the parent
// flips state immediately and reverts on error.
export function InstalledPluginCard({ plugin, onToggle, onUpdate, onUninstall, busy }: InstalledCardProps) {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useOutsideDismiss(menuRef, menuOpen, () => setMenuOpen(false))

  return (
    <div className={`plugin-card plugin-card--installed ${plugin.enabled ? 'is-enabled' : 'is-disabled'}`}>
      <div className="plugin-card-head">
        <div className="plugin-card-title">
          <span className="plugin-card-name">{plugin.name}</span>
          <span className="plugin-card-version">v{plugin.version}</span>
        </div>
        <button
          type="button"
          className={`plugin-toggle ${plugin.enabled ? 'is-on' : 'is-off'}`}
          onClick={() => onToggle(!plugin.enabled)}
          disabled={busy}
          aria-pressed={plugin.enabled}
          aria-label={plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
          title={plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
        >
          <span className="plugin-toggle-knob" />
        </button>
      </div>
      {plugin.description && <p className="plugin-card-desc">{plugin.description}</p>}
      <div className="plugin-card-foot">
        <span className="plugin-card-scope">{t(`plugins.scope.${plugin.scope}`)}</span>
        <div className="plugin-card-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="plugin-card-menu-trigger"
            onClick={() => setMenuOpen(open => !open)}
            disabled={busy}
            aria-label={t('plugins.actions')}
          >
            <MoreHorizontal size={15} />
          </button>
          {menuOpen && (
            <div className="t-dropdown is-open plugin-card-menu">
              <button
                type="button"
                className="plugin-card-menu-item"
                onClick={() => { setMenuOpen(false); onUpdate() }}
              >
                <RefreshCw size={14} />
                {t('plugins.update')}
              </button>
              <button
                type="button"
                className="plugin-card-menu-item plugin-card-menu-item--danger"
                onClick={() => { setMenuOpen(false); onUninstall() }}
              >
                <Trash2 size={14} />
                {t('plugins.uninstall')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

type AvailableCardProps = {
  plugin: AvailablePlugin
  onInstall: () => void
  busy?: boolean
}

// Available plugin card (Featured grid): name, description, marketplace,
// install count, and an Install button. No toggle — it's not installed yet.
export function AvailablePluginCard({ plugin, onInstall, busy }: AvailableCardProps) {
  const { t } = useI18n()
  return (
    <div className="plugin-card plugin-card--available">
      <div className="plugin-card-head">
        <div className="plugin-card-title">
          <span className="plugin-card-name">{plugin.name}</span>
        </div>
        <button
          type="button"
          className="plugin-install-btn"
          onClick={onInstall}
          disabled={busy}
        >
          {busy ? <RefreshCw size={14} className="t-spin" /> : <Download size={14} />}
          {t('plugins.install')}
        </button>
      </div>
      <p className="plugin-card-desc">{plugin.description}</p>
      <div className="plugin-card-foot">
        <span className="plugin-card-marketplace">{plugin.marketplaceName}</span>
        {plugin.installCount > 0 && (
          <span className="plugin-card-installs">{plugin.installCount} {t('plugins.installs')}</span>
        )}
      </div>
    </div>
  )
}

type SkeletonCardProps = { delay: number }

// Loading placeholder — matches the card footprint so the grid doesn't jump
// when real data arrives. Staggered via inline transition-delay.
export function PluginSkeletonCard({ delay }: SkeletonCardProps) {
  return (
    <div className="plugin-card plugin-card--skeleton" style={{ animationDelay: `${delay}ms` }}>
      <div className="plugin-card-head">
        <div className="plugin-skel-line plugin-skel-line--title" />
        <div className="plugin-skel-line plugin-skel-line--toggle" />
      </div>
      <div className="plugin-skel-line plugin-skel-line--desc" />
      <div className="plugin-skel-line plugin-skel-line--desc plugin-skel-line--short" />
      <div className="plugin-card-foot">
        <div className="plugin-skel-line plugin-skel-line--foot" />
      </div>
    </div>
  )
}

// Re-export for convenience — consumers can import all variants from one module.
export { Check, Power }
