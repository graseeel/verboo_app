import { Download, MoreHorizontal, Power, RefreshCw, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { AvailablePlugin, Plugin } from '../../../shared/plugins'
import { useI18n } from '../../i18n'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'

type InstalledCardProps = {
  plugin: Plugin
  onUpdate: () => void
  onToggle: (enabled: boolean) => void
  onUninstall: () => void
  onOpenDetail: () => void
  busy?: boolean
}

// Installed plugin card. Codex-inspired: the whole card is clickable (opens
// the detail view), and a ⋯ menu on the right holds the actions — Update,
// Enable/Disable (label depends on current state), Uninstall. The toggle
// moved to the detail view to keep the card surface clean.
export function InstalledPluginCard({ plugin, onUpdate, onToggle, onUninstall, onOpenDetail, busy }: InstalledCardProps) {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useOutsideDismiss(menuRef, menuOpen, () => setMenuOpen(false))

  return (
    <div
      className={`plugin-card plugin-card--installed ${plugin.enabled ? 'is-enabled' : 'is-disabled'}`}
      onClick={onOpenDetail}
      role="button"
      tabIndex={0}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenDetail() } }}
    >
      <div className="plugin-card-head">
        <div className="plugin-card-title">
          <span className="plugin-card-name">{plugin.name}</span>
          <span className="plugin-card-version">v{plugin.version}</span>
        </div>
        <div className="plugin-card-menu-wrap" ref={menuRef} onClick={event => event.stopPropagation()}>
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
                className="plugin-card-menu-item"
                onClick={() => { setMenuOpen(false); onToggle(!plugin.enabled) }}
              >
                <Power size={14} />
                {plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
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
      {plugin.description && <p className="plugin-card-desc">{plugin.description}</p>}
      <div className="plugin-card-foot">
        <span className="plugin-card-scope">{t(`plugins.scope.${plugin.scope}`)}</span>
        <span className="plugin-card-state">{plugin.enabled ? t('plugins.enabled') : t('plugins.disabled')}</span>
      </div>
    </div>
  )
}

type AvailableCardProps = {
  plugin: AvailablePlugin
  onInstall: () => void
  onOpenDetail: () => void
  busy?: boolean
}

// Available plugin card. Click opens detail; Install button is a quick action
// that stops propagation so it doesn't double-trigger the card click.
export function AvailablePluginCard({ plugin, onInstall, onOpenDetail, busy }: AvailableCardProps) {
  const { t } = useI18n()
  return (
    <div
      className="plugin-card plugin-card--available"
      onClick={onOpenDetail}
      role="button"
      tabIndex={0}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenDetail() } }}
    >
      <div className="plugin-card-head">
        <div className="plugin-card-title">
          <span className="plugin-card-name">{plugin.name}</span>
        </div>
        <button
          type="button"
          className="plugin-install-btn"
          onClick={event => { event.stopPropagation(); onInstall() }}
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
// when real data arrives. Staggered via inline animation-delay.
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
