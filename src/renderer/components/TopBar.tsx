import { FileSearch, PanelLeftClose, PanelLeftOpen, Terminal as TerminalIcon } from 'lucide-react'
import { SlotText } from 'slot-text/react'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'
import { useI18n } from '../i18n'

type TopBarProps = {
  sidebarVisible: boolean
  statusLabel: string
  onToggleSidebar: () => void
  terminalOpen: boolean
  terminalUnavailableReason?: string
  onToggleTerminal: () => void
  reviewOpen: boolean
  reviewUnavailableReason?: string
  onToggleReview: () => void
}

export function TopBar({
  sidebarVisible,
  statusLabel,
  onToggleSidebar,
  terminalOpen,
  terminalUnavailableReason,
  onToggleTerminal,
  reviewOpen,
  reviewUnavailableReason,
  onToggleReview,
}: TopBarProps) {
  const { t } = useI18n()

  return (
    <header
      className="topbar"
      data-tauri-drag-region=""
      onDoubleClick={() => window.verboo.toggleWindowZoom()}
    >
      <button
        className="topbar-sidebar-button ui-tooltip"
        type="button"
        onClick={event => {
          event.stopPropagation()
          onToggleSidebar()
        }}
        data-tooltip={sidebarVisible ? t('topbar.hideSidebar') : t('topbar.showSidebar')}
        aria-label={t('topbar.toggleSidebar')}
      >
        {sidebarVisible ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
      </button>
      <div
        className="topbar-brand-status"
        data-tauri-drag-region=""
        aria-label={`Verboo ${statusLabel}`}
      >
        <img className="topbar-mark" src={mascotUrl} alt="Verboo" />
        <span className="topbar-status-text">
          <SlotText text={statusLabel} options={{ direction: 'up', duration: 180, stagger: 14, bounce: 0.2, interrupt: true }} />
        </span>
      </div>
      <div className="topbar-actions">
        {(terminalUnavailableReason || reviewUnavailableReason) && (
          <span className="topbar-terminal-notice" role="status">
            {terminalUnavailableReason || reviewUnavailableReason}
          </span>
        )}
        <button
          className={`topbar-terminal-button ui-tooltip ${terminalOpen ? 'active' : ''}`}
          type="button"
          onClick={event => {
            event.stopPropagation()
            onToggleTerminal()
          }}
          data-tooltip={terminalOpen ? t('topbar.hideTerminal') : t('topbar.openTerminal')}
          data-tooltip-align="end"
          aria-label={terminalOpen ? t('topbar.hideTerminal') : t('topbar.openTerminal')}
        >
          <TerminalIcon size={15} />
        </button>
        <button
          className={`topbar-terminal-button ui-tooltip ${reviewOpen ? 'active' : ''}`}
          type="button"
          onClick={event => {
            event.stopPropagation()
            onToggleReview()
          }}
          data-tooltip={reviewOpen ? t('topbar.hideReview') : t('topbar.openReview')}
          data-tooltip-align="end"
          aria-label={reviewOpen ? t('topbar.hideReview') : t('topbar.openReview')}
        >
          <FileSearch size={15} />
        </button>
      </div>
    </header>
  )
}
