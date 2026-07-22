import { useLayoutEffect, useRef } from 'react'

export type WorkspacePanelKind = 'terminal' | 'review' | 'browser'

export type UseWorkspacePanelSuspensionOptions = {
  isFullscreenView: boolean
  isChatView: boolean
  terminalOpen: boolean
  reviewOpen: boolean
  browserOpen: boolean
  closeAll: () => void
  restorePanel: (panel: WorkspacePanelKind) => void
}

export function useWorkspacePanelSuspension({
  isFullscreenView,
  isChatView,
  terminalOpen,
  reviewOpen,
  browserOpen,
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
              : undefined
      }
      wasFullscreenRef.current = true
      if (terminalOpen || reviewOpen || browserOpen) closeAll()
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
  ])

  return { workspacePanelsEnabled: !isFullscreenView }
}
