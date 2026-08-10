import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss'

export type ContextMenuItem = {
  key: string
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export type ContextMenuState = {
  x: number
  y: number
  items: ContextMenuItem[]
}

// Right-click menu (shadcn DropdownMenu pattern): fixed-position panel at the
// pointer, clamped to the viewport, dismissed by outside click or Escape.
export function ContextMenu({ menu, onClose }: { menu?: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useOutsideDismiss(ref, Boolean(menu), onClose)

  useLayoutEffect(() => {
    const panel = ref.current
    if (!panel || !menu) return
    const rect = panel.getBoundingClientRect()
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8)
    const y = Math.min(menu.y, window.innerHeight - rect.height - 8)
    panel.style.left = `${Math.max(8, x)}px`
    panel.style.top = `${Math.max(8, y)}px`
  }, [menu])

  if (!menu) return null

  return (
    <div ref={ref} className="context-menu popover-panel t-dropdown is-open" role="menu">
      {menu.items.map(item => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={`context-menu-item ${item.danger ? 'danger' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return
            onClose()
            item.onSelect()
          }}
        >
          {item.icon && <span className="context-menu-icon" aria-hidden="true">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  )
}
