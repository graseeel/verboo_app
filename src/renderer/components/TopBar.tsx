import { PanelLeftClose, PanelLeftOpen, Terminal as TerminalIcon } from 'lucide-react'
import { SlotText } from 'slot-text/react'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'

type TopBarProps = {
  sidebarVisible: boolean
  statusLabel: string
  onToggleSidebar: () => void
  terminalOpen: boolean
  terminalUnavailableReason?: string
  onToggleTerminal: () => void
}

export function TopBar({
  sidebarVisible,
  statusLabel,
  onToggleSidebar,
  terminalOpen,
  terminalUnavailableReason,
  onToggleTerminal,
}: TopBarProps) {
  return (
    <header className="topbar" onDoubleClick={() => window.verboo.toggleWindowZoom()}>
      <button
        className="topbar-sidebar-button ui-tooltip"
        type="button"
        onClick={event => {
          event.stopPropagation()
          onToggleSidebar()
        }}
        data-tooltip={sidebarVisible ? 'Ocultar barra lateral' : 'Mostrar barra lateral'}
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
      <div className="topbar-actions">
        {terminalUnavailableReason && (
          <span className="topbar-terminal-notice" role="status">
            {terminalUnavailableReason}
          </span>
        )}
        <button
          className={`topbar-terminal-button ui-tooltip ${terminalOpen ? 'active' : ''}`}
          type="button"
          onClick={event => {
            event.stopPropagation()
            onToggleTerminal()
          }}
          data-tooltip={terminalOpen ? 'Ocultar terminal local' : 'Abrir terminal local'}
          data-tooltip-align="end"
          aria-label={terminalOpen ? 'Close local terminal' : 'Open local terminal'}
        >
          <TerminalIcon size={15} />
        </button>
      </div>
    </header>
  )
}
