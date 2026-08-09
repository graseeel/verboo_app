import { useLayoutEffect, useRef } from 'react'

export type WorkspacePanelKind = 'terminal' | 'review' | 'browser' | 'simulator'

export type UseWorkspacePanelSuspensionOptions = {
  isFullscreenView: boolean
  isChatView: boolean
  terminalOpen: boolean
  reviewOpen: boolean
  browserOpen: boolean
  simulatorOpen?: boolean
  closeAll: () => void
  restorePanel: (panel: WorkspacePanelKind) => void
}

export function useWorkspacePanelSuspension({
  isFullscreenView,
  isChatView,
  terminalOpen,
  reviewOpen,
  browserOpen,
  simulatorOpen = false,
  closeAll,
  restorePanel,
}: UseWorkspacePanelSuspensionOptions) {
  const suspendedPanelRef = useRef<WorkspacePanelKind | undefined>(undefined)
  const wasFullscreenRef = useRef(false)

  useLayoutEffect(() => {
    if (isFullscreenView) {
      if (!wasFullscreenRef.current) {
        suspendedPanelRef.current = terminalOpen
          ? 'terminal'
          : reviewOpen
            ? 'review'
            : browserOpen
              ? 'browser'
              : simulatorOpen
                ? 'simulator'
                : undefined
      }
      wasFullscreenRef.current = true
      if (terminalOpen || reviewOpen || browserOpen || simulatorOpen) closeAll()
      return
    }

    wasFullscreenRef.current = false
    if (!isChatView || !suspendedPanelRef.current) return
    const panel = suspendedPanelRef.current
    suspendedPanelRef.current = undefined
    restorePanel(panel)
  }, [
    browserOpen,
    closeAll,
    isChatView,
    isFullscreenView,
    restorePanel,
    reviewOpen,
    terminalOpen,
    simulatorOpen,
  ])

  return { workspacePanelsEnabled: !isFullscreenView }
}
