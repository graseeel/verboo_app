import { EllipsisVertical, FileSearch, Globe, PanelLeftOpen, Terminal as TerminalIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import type { SimulatorPlatform } from '../features/simulator/simulatorPlatform'

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
  platform?: NodeJS.Platform
  onOpenSimulator?: (platform: SimulatorPlatform) => void
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
  platform = 'darwin',
  onOpenSimulator = () => {},
  workspacePanelsEnabled,
}: TopBarProps) {
  const { t } = useI18n()
  const [simulatorMenuOpen, setSimulatorMenuOpen] = useState(false)
  const simulatorMenuId = useId()
  const simulatorMenuRef = useRef<HTMLDivElement>(null)
  const simulatorTriggerRef = useRef<HTMLButtonElement>(null)
  const simulatorOptionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const focusOnOpenRef = useRef<number | null>(null)
  const simulatorOptions: Array<{ platform: SimulatorPlatform; label: string }> = [
    ...(platform === 'darwin'
      ? [{ platform: 'ios' as const, label: t('topbar.iosSimulator') }]
      : []),
    { platform: 'android', label: t('topbar.androidEmulator') },
  ]

  useEffect(() => {
    if (!simulatorMenuOpen) return

    const handleOutsidePointer = (event: PointerEvent) => {
      if (!simulatorMenuRef.current?.contains(event.target as Node)) setSimulatorMenuOpen(false)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setSimulatorMenuOpen(false)
      simulatorTriggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', handleOutsidePointer)
    window.addEventListener('keydown', handleEscape, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer)
      window.removeEventListener('keydown', handleEscape, { capture: true })
    }
  }, [simulatorMenuOpen])

  useEffect(() => {
    if (!simulatorMenuOpen || focusOnOpenRef.current === null) return
    simulatorOptionRefs.current[focusOnOpenRef.current]?.focus()
    focusOnOpenRef.current = null
  }, [simulatorMenuOpen])

  function openSimulatorMenu(focusIndex?: number) {
    focusOnOpenRef.current = focusIndex ?? null
    setSimulatorMenuOpen(true)
  }

  function handleSimulatorMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const options = simulatorOptionRefs.current.filter((option): option is HTMLButtonElement => Boolean(option))
    if (!options.length) return
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement)
    let nextIndex: number | undefined
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = options.length - 1
    if (nextIndex !== undefined) {
      event.preventDefault()
      options[nextIndex]?.focus()
    } else if (event.key === 'Tab') {
      setSimulatorMenuOpen(false)
    }
  }

  return (
    <header
      className="topbar"
      data-tauri-drag-region="deep"
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
      <div className="topbar-actions" data-tauri-drag-region="false">
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
          <div
            className="topbar-simulator-menu-wrap"
            ref={simulatorMenuRef}
            data-topbar-simulator-menu-open={simulatorMenuOpen ? 'true' : undefined}
          >
            {/* Suppress the tooltip while the menu is open (PA-36) — the CSS
                tooltip renders below the trigger and would paint OVER the open
                menu items. Menus never show the trigger tooltip. The base.css
                `:not([data-tooltip])` guard keeps the empty ::after from
                painting while the attribute is gone. */}
            <button
              ref={simulatorTriggerRef}
              className={`topbar-terminal-button ui-tooltip ${simulatorOpen || simulatorMenuOpen ? 'active' : ''}`}
              type="button"
              disabled={!workspacePanelsEnabled}
              onClick={event => {
                event.stopPropagation()
                setSimulatorMenuOpen(open => !open)
              }}
              onKeyDown={event => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                openSimulatorMenu(event.key === 'ArrowUp' ? simulatorOptions.length - 1 : 0)
              }}
              data-tooltip={simulatorMenuOpen ? undefined : t('topbar.simulators')}
              data-tooltip-align="end"
              aria-label={t('topbar.simulators')}
              aria-haspopup="menu"
              aria-expanded={simulatorMenuOpen}
              aria-controls={simulatorMenuOpen ? simulatorMenuId : undefined}
            >
              <EllipsisVertical size={16} />
              {recordingActive && (
                <span
                  className="topbar-simulator-recording"
                  aria-label={t('simulator.recording.active')}
                />
              )}
            </button>
            {simulatorMenuOpen && (
              <div
                id={simulatorMenuId}
                className="topbar-simulator-menu popover-panel"
                role="menu"
                aria-label={t('topbar.simulators')}
                onKeyDown={handleSimulatorMenuKeyDown}
              >
                {simulatorOptions.map((option, index) => (
                  <button
                    key={option.platform}
                    ref={element => { simulatorOptionRefs.current[index] = element }}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setSimulatorMenuOpen(false)
                      onOpenSimulator(option.platform)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  )
}
