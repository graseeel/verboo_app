import { FileSearch, Globe, PanelLeftOpen, Smartphone, Terminal as TerminalIcon } from 'lucide-react'
import { useI18n } from '../i18n'

type TopBarProps = {
  sidebarVisible: boolean
  onToggleSidebar: () => void
  terminalOpen: boolean
  terminalUnavailableReason?: string
  onToggleTerminal: () => void
  reviewOpen: boolean
  reviewUnavailableReason?: string
  onToggleReview: () => void
  browserAvailable: boolean
  browserOpen: boolean
  onToggleBrowser: () => void
  simulatorAvailable?: boolean
  simulatorOpen?: boolean
  recordingActive?: boolean
  onToggleSimulator?: () => void
  workspacePanelsEnabled: boolean
}

export function TopBar({
  sidebarVisible,
  onToggleSidebar,
  terminalOpen,
  terminalUnavailableReason,
  onToggleTerminal,
  reviewOpen,
  reviewUnavailableReason,
  onToggleReview,
  browserAvailable,
  browserOpen,
  onToggleBrowser,
  simulatorAvailable = false,
  simulatorOpen = false,
  recordingActive = false,
  onToggleSimulator = () => {},
  workspacePanelsEnabled,
}: TopBarProps) {
  const { t } = useI18n()

  return (
    <header
      className="topbar"
      data-tauri-drag-region=""
      onDoubleClick={() => window.verboo.toggleWindowZoom()}
    >
      {/* When the sidebar is collapsed, show a reopen button here — but only
          on touch/narrow viewports where hover is unreliable. On desktop
          (pointer: fine, hover: hover) the left-edge rail handles re-opening,
          so this button is hidden via CSS to avoid duplicate controls. */}
      {!sidebarVisible && (
        <button
          className="topbar-sidebar-button ui-tooltip topbar-sidebar-button--touch"
          type="button"
          onClick={event => {
            event.stopPropagation()
            onToggleSidebar()
          }}
          data-tooltip={t('topbar.showSidebar')}
          aria-label={t('topbar.toggleSidebar')}
        >
          <PanelLeftOpen size={15} />
        </button>
      )}
      {/* Quiet drag spacer — no "ready/pronto" status near traffic lights. */}
      <div className="topbar-brand-status" data-tauri-drag-region="" aria-hidden="true" />
      <div className="topbar-actions">
        {(terminalUnavailableReason || reviewUnavailableReason) && (
          <span className="topbar-terminal-notice" role="status">
            {terminalUnavailableReason || reviewUnavailableReason}
          </span>
        )}
        <button
          className={`topbar-terminal-button ui-tooltip ${terminalOpen ? 'active' : ''}`}
          type="button"
          disabled={!workspacePanelsEnabled}
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
          disabled={!workspacePanelsEnabled}
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
        {browserAvailable && (
          <button
            className={`topbar-terminal-button ui-tooltip ${browserOpen ? 'active' : ''}`}
            type="button"
            disabled={!workspacePanelsEnabled}
            onClick={event => {
              event.stopPropagation()
              onToggleBrowser()
            }}
            data-tooltip={browserOpen ? t('topbar.minimizeBrowser') : t('topbar.openBrowser')}
            data-tooltip-align="end"
            aria-label={browserOpen ? t('topbar.minimizeBrowser') : t('topbar.openBrowser')}
          >
            <Globe size={15} />
          </button>
        )}
        {simulatorAvailable && (
          <button
            className={`topbar-terminal-button ui-tooltip ${simulatorOpen ? 'active' : ''}`}
            type="button"
            disabled={!workspacePanelsEnabled}
            onClick={event => {
              event.stopPropagation()
              onToggleSimulator()
            }}
            data-tooltip={simulatorOpen ? t('topbar.hideSimulator') : t('topbar.openSimulator')}
            data-tooltip-align="end"
            aria-label={simulatorOpen ? t('topbar.hideSimulator') : t('topbar.openSimulator')}
          >
            <Smartphone size={15} />
          </button>
        )}
        {simulatorAvailable && recordingActive && (
          <span
            className="topbar-simulator-recording"
            aria-label={t('simulator.recording.active')}
          />
        )}
      </div>
    </header>
  )
}
