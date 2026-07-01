import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { SlotText } from 'slot-text/react'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'

type TopBarProps = {
  sidebarVisible: boolean
  statusLabel: string
  onToggleSidebar: () => void
}

export function TopBar({ sidebarVisible, statusLabel, onToggleSidebar }: TopBarProps) {
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
      <div className="topbar-brand-status" aria-label={`Verboo ${statusLabel}`}>
        <img className="topbar-mark" src={mascotUrl} alt="Verboo" />
        <span className="topbar-status-text">
          <SlotText text={statusLabel} options={{ direction: 'up', duration: 180, stagger: 14, bounce: 0.2, interrupt: true }} />
        </span>
      </div>
    </header>
  )
}
