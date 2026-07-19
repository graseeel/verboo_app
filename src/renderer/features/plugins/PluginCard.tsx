import { createPortal } from 'react-dom'
import { Download, MessageSquare, MoreHorizontal, Power, RefreshCw, Trash2 } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { AvailablePlugin, Plugin } from '../../../shared/plugins'
import { useI18n } from '../../i18n'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { usePluginIcon } from './usePluginIcon'
import { OFFICIAL_MARKETPLACES } from '../../../shared/plugins'
import verbooIconUrl from '../../../../assets/branding/verboo-mascot.png'

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

// Exported so PluginDetailView can seed the hero mesh with the same hue as
// the monogram — same plugin = same color, always. The mesh layers read
// --plugin-hero-color (set inline on the hero) and fall back to --accent.
export function monogramColor(seed: string): string {
  return MONOGRAM_PALETTE[hashString(seed) % MONOGRAM_PALETTE.length]
}

// Hue (0-360) derived from the same hash — useful for HSL-based mesh layers
// that need a single hue channel rather than a fixed palette swatch.
export function pluginHue(seed: string): number {
  return hashString(seed) % 360
}

export function PluginMonogram({ name, id, size = 36, iconUrl }: { name: string; id: string; size?: number; iconUrl?: string | null }) {
  const color = monogramColor(id || name)
  return (
    <div
      className={`plugin-monogram ${iconUrl ? 'has-icon' : ''}`}
      style={{
        width: size,
        height: size,
        // Gradient bg lives on the initials layer, not the container — so
        // when the icon fades in, the container shows a neutral theme-aware
        // bg (for transparent PNGs) instead of the colored gradient.
        '--mono-color': color,
      } as React.CSSProperties}
      aria-hidden="true"
    >
      {/* Initials layer — fades out when the icon arrives (crossfade). */}
      <span
        className="plugin-monogram-initials"
        style={{
          background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 70%, black))`,
        }}
      >
        {monogramInitials(name)}
      </span>
      {iconUrl && (
        <img
          src={iconUrl}
          alt=""
          className="plugin-monogram-img"
          loading="lazy"
          draggable={false}
          onError={event => {
            // Hide the img on error — initials layer fades back in.
            (event.currentTarget as HTMLImageElement).style.display = 'none'
            const container = event.currentTarget.parentElement
            container?.classList.remove('has-icon')
          }}
        />
      )}
    </div>
  )
}

// PluginIcon — renders monogram immediately, swaps to <img> when the icon
// URL arrives (opacity transition). Uses usePluginIcon hook with session
// cache. `loadIcons` = false (privacy setting) → monogram only, no fetch.
// ITEM D: plugins from OFFICIAL_MARKETPLACES get the bundled Verboo icon,
// bypassing monogram and icon service entirely.
export function PluginIcon({ name, id, size = 36, loadIcons = true }: { name: string; id: string; size?: number; loadIcons?: boolean }) {
  const marketplace = id?.split('@')[1]
  const isOfficial = marketplace ? OFFICIAL_MARKETPLACES.includes(marketplace) : false
  if (isOfficial) {
    return (
      <span className="plugin-monogram" style={{ width: size, height: size }}>
        <img src={verbooIconUrl} alt="" className="plugin-monogram-img" style={{ opacity: 1, borderRadius: size * 0.25 }} />
      </span>
    )
  }
  const { iconUrl } = usePluginIcon(id, loadIcons)
  return <PluginMonogram name={name} id={id} size={size} iconUrl={iconUrl} />
}

// ── Portal menu ─────────────────────────────────────────────────────
// Renders via createPortal(document.body) with position:fixed so it never
// clips inside overflow:hidden parents. Coords from trigger rect; flips
// above if not enough room below.
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

// ── Installed line (W1: borderless row, not card) ───────────────────
type InstalledLineProps = {
  plugin: Plugin
  onUpdate: () => void
  onToggle: (enabled: boolean) => void
  onUninstall: () => void
  onOpenDetail: () => void
  onTestNow?: () => void
  loadIcons?: boolean
  busy?: boolean
}

export function InstalledPluginCard({ plugin, onUpdate, onToggle, onUninstall, onOpenDetail, onTestNow, loadIcons = true, busy }: InstalledLineProps) {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // Menu order (Codex): Testar agora / Gerenciar (detail) / separator / Desinstalar.
  // Testar agora only shows if onTestNow is wired (App provides the composer seed).
  const menuItems: MenuItem[] = []
  if (onTestNow) {
    menuItems.push({ icon: <MessageSquare size={14} />, label: t('plugins.testNow'), onClick: onTestNow })
  }
  menuItems.push({ icon: <Power size={14} />, label: t('plugins.manage'), onClick: onOpenDetail })
  menuItems.push({ icon: <RefreshCw size={14} />, label: t('plugins.update'), onClick: onUpdate })
  menuItems.push({ icon: <Power size={14} />, label: plugin.enabled ? t('plugins.disable') : t('plugins.enable'), onClick: () => onToggle(!plugin.enabled) })
  // Separator is implicit: danger items render with top border.
  menuItems.push({ icon: <Trash2 size={14} />, label: t('plugins.uninstall'), onClick: onUninstall, danger: true })

  return (
    <div
      className={`plugin-line plugin-line--installed ${plugin.enabled ? 'is-enabled' : 'is-disabled'}`}
      onClick={onOpenDetail}
      role="button"
      tabIndex={0}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenDetail() } }}
    >
      <PluginIcon name={plugin.name} id={plugin.id} size={44} loadIcons={loadIcons} />
      <div className="plugin-line-body">
        <div className="plugin-line-name">{plugin.name}</div>
        {plugin.description && <div className="plugin-line-desc">{plugin.description}</div>}
      </div>
      <div className="plugin-line-actions" onClick={event => event.stopPropagation()}>
        <button
          ref={triggerRef}
          type="button"
          className="plugin-line-menu-trigger"
          onClick={() => setMenuOpen(open => !open)}
          disabled={busy}
          aria-label={t('plugins.actions')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <MoreHorizontal size={18} />
        </button>
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

// ── Available line (W1: borderless row + Install pill outline) ──────
type AvailableLineProps = {
  plugin: AvailablePlugin
  onInstall: () => void
  onOpenDetail: () => void
  loadIcons?: boolean
  busy?: boolean
}

export function AvailablePluginCard({ plugin, onInstall, onOpenDetail, loadIcons = true, busy }: AvailableLineProps) {
  const { t } = useI18n()
  return (
    <div
      className="plugin-line plugin-line--available"
      onClick={onOpenDetail}
      role="button"
      tabIndex={0}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenDetail() } }}
    >
      <PluginIcon name={plugin.name} id={plugin.pluginId} size={44} loadIcons={loadIcons} />
      <div className="plugin-line-body">
        <div className="plugin-line-name">{plugin.name}</div>
        <div className="plugin-line-desc">{plugin.description}</div>
        <div className="plugin-line-meta">{plugin.marketplaceName}</div>
      </div>
      <div className="plugin-line-actions" onClick={event => event.stopPropagation()}>
        <button
          type="button"
          className={`plugin-install-btn${busy ? ' is-busy' : ''}`}
          onClick={onInstall}
          disabled={busy}
          aria-label={t('plugins.install')}
        >
          {busy ? <RefreshCw size={13} className="t-spin" /> : <Download size={13} />}
          <span>{busy ? t('plugins.installing') : t('plugins.install')}</span>
        </button>
      </div>
    </div>
  )
}

// ── Skeleton line ───────────────────────────────────────────────────
type SkeletonLineProps = { delay: number }

export function PluginSkeletonCard({ delay }: SkeletonLineProps) {
  return (
    <div className="plugin-line plugin-line--skeleton" style={{ animationDelay: `${delay}ms` }}>
      <div className="plugin-skel-monogram plugin-skel-monogram--44" />
      <div className="plugin-line-body">
        <div className="plugin-skel-line plugin-skel-line--title" />
        <div className="plugin-skel-line plugin-skel-line--desc" />
      </div>
    </div>
  )
}
