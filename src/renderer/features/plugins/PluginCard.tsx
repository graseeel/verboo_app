import { createPortal } from 'react-dom'
import { Download, MoreHorizontal, Power, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AvailablePlugin, Plugin } from '../../../shared/plugins'
import { useI18n } from '../../i18n'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'

// ── Monogram ────────────────────────────────────────────────────────
// Deterministic initials + color from a plugin id/name. Gives each plugin
// a recognizable avatar without storing icons. Color is hashed to a palette
// so the same plugin always gets the same hue.
const MONOGRAM_PALETTE = [
  '#7c3aed', '#2563eb', '#0891b2', '#059669', '#ca8a04',
  '#dc2626', '#db2777', '#4f46e5', '#0d9488', '#ea580c',
]

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

function monogramInitials(name: string): string {
  const parts = name.replace(/[@/]/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

function monogramColor(seed: string): string {
  return MONOGRAM_PALETTE[hashString(seed) % MONOGRAM_PALETTE.length]
}

export function PluginMonogram({ name, id, size = 36 }: { name: string; id: string; size?: number }) {
  const color = monogramColor(id || name)
  return (
    <div
      className="plugin-monogram"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 70%, black))`,
      }}
      aria-hidden="true"
    >
      {monogramInitials(name)}
    </div>
  )
}

// ── Portal menu (F1) ────────────────────────────────────────────────
// The menu renders via createPortal(document.body) with position:fixed so
// it never clips inside overflow:hidden parents. Coords come from the
// trigger's getBoundingClientRect; we flip above the trigger if there's
// not enough room below.
type MenuItem = { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }

function PortalMenu({ triggerRef, items, onClose }: {
  triggerRef: React.RefObject<HTMLElement | null>
  items: MenuItem[]
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const menuWidth = 176
    const menuHeight = items.length * 36 + 8
    const viewportH = window.innerHeight
    const spaceBelow = viewportH - rect.bottom
    const flip = spaceBelow < menuHeight + 8 && rect.top > menuHeight + 8
    const top = flip ? rect.top - menuHeight - 4 : rect.bottom + 4
    // Clamp left so the menu doesn't overflow the right edge.
    const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8))
    setCoords({ top, left })
  }, [triggerRef, items.length])

  useOutsideDismiss(menuRef, true, onClose)

  return createPortal(
    <div
      ref={menuRef}
      className="plugin-card-menu t-dropdown is-open"
      style={{ position: 'fixed', top: coords.top, left: coords.left, zIndex: 200 }}
      role="menu"
    >
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={`plugin-card-menu-item ${item.danger ? 'plugin-card-menu-item--danger' : ''}`}
          onClick={() => { onClose(); item.onClick() }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

// ── Installed card ──────────────────────────────────────────────────
type InstalledCardProps = {
  plugin: Plugin
  onUpdate: () => void
  onToggle: (enabled: boolean) => void
  onUninstall: () => void
  onOpenDetail: () => void
  busy?: boolean
}

export function InstalledPluginCard({ plugin, onUpdate, onToggle, onUninstall, onOpenDetail, busy }: InstalledCardProps) {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const menuItems: MenuItem[] = [
    { icon: <RefreshCw size={14} />, label: t('plugins.update'), onClick: onUpdate },
    { icon: <Power size={14} />, label: plugin.enabled ? t('plugins.disable') : t('plugins.enable'), onClick: () => onToggle(!plugin.enabled) },
    { icon: <Trash2 size={14} />, label: t('plugins.uninstall'), onClick: onUninstall, danger: true },
  ]

  return (
    <div
      className={`plugin-card plugin-card--installed ${plugin.enabled ? 'is-enabled' : 'is-disabled'}`}
      onClick={onOpenDetail}
      role="button"
      tabIndex={0}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenDetail() } }}
    >
      <div className="plugin-card-row">
        <PluginMonogram name={plugin.name} id={plugin.id} />
        <div className="plugin-card-body">
          <div className="plugin-card-title">
            <span className="plugin-card-name">{plugin.name}</span>
            <span className="plugin-card-version">v{plugin.version}</span>
          </div>
          {plugin.description && <p className="plugin-card-desc">{plugin.description}</p>}
          <div className="plugin-card-foot">
            <span className="plugin-card-marketplace">{t(`plugins.scope.${plugin.scope}`)}</span>
            <span className="plugin-card-state">{plugin.enabled ? t('plugins.enabled') : t('plugins.disabled')}</span>
          </div>
        </div>
        <div className="plugin-card-actions" onClick={event => event.stopPropagation()}>
          <button
            ref={triggerRef}
            type="button"
            className="plugin-card-menu-trigger"
            onClick={() => setMenuOpen(open => !open)}
            disabled={busy}
            aria-label={t('plugins.actions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={16} />
          </button>
        </div>
      </div>
      {menuOpen && (
        <PortalMenu
          triggerRef={triggerRef}
          items={menuItems}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  )
}

// ── Available card (F2: one-click install) ──────────────────────────
type AvailableCardProps = {
  plugin: AvailablePlugin
  onInstall: () => void
  onOpenDetail: () => void
  busy?: boolean
}

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
      <div className="plugin-card-row">
        <PluginMonogram name={plugin.name} id={plugin.pluginId} />
        <div className="plugin-card-body">
          <div className="plugin-card-title">
            <span className="plugin-card-name">{plugin.name}</span>
          </div>
          <p className="plugin-card-desc">{plugin.description}</p>
          <div className="plugin-card-foot">
            <span className="plugin-card-marketplace">{plugin.marketplaceName}</span>
            {plugin.installCount > 0 && (
              <span className="plugin-card-installs">{plugin.installCount} {t('plugins.installs')}</span>
            )}
          </div>
        </div>
        <div className="plugin-card-actions" onClick={event => event.stopPropagation()}>
          <button
            type="button"
            className="plugin-install-btn"
            onClick={onInstall}
            disabled={busy}
            aria-label={t('plugins.install')}
          >
            {busy ? <RefreshCw size={13} className="t-spin" /> : <Download size={13} />}
            <span>{busy ? t('plugins.installing') : t('plugins.install')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Skeleton ────────────────────────────────────────────────────────
type SkeletonCardProps = { delay: number }

export function PluginSkeletonCard({ delay }: SkeletonCardProps) {
  return (
    <div className="plugin-card plugin-card--skeleton" style={{ animationDelay: `${delay}ms` }}>
      <div className="plugin-card-row">
        <div className="plugin-skel-monogram" />
        <div className="plugin-card-body">
          <div className="plugin-skel-line plugin-skel-line--title" />
          <div className="plugin-skel-line plugin-skel-line--desc" />
          <div className="plugin-skel-line plugin-skel-line--desc plugin-skel-line--short" />
        </div>
        <div className="plugin-skel-line plugin-skel-line--install" />
      </div>
    </div>
  )
}
