import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'

type TopBarProps = {
  sidebarVisible: boolean
  onToggleSidebar: () => void
}

export function TopBar({ sidebarVisible, onToggleSidebar }: TopBarProps) {
  return (
    <header className="topbar" onDoubleClick={() => window.verboo.toggleWindowZoom()}>
      <button
        className="topbar-sidebar-button"
        type="button"
        onClick={event => {
          event.stopPropagation()
          onToggleSidebar()
        }}
        title="Alternar barra lateral (⌘B)"
        aria-label="Alternar barra lateral"
      >
        {sidebarVisible ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
      </button>
      <img className="topbar-mark" src={mascotUrl} alt="Verboo" />
    </header>
  )
}
