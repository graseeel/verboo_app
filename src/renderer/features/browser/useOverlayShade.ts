import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

// Central registry for overlays that need to shade the browser webview.
// When any overlay with shades:true opens, we capture a snapshot of the
// webview, hide the native view, and show a static <img> placeholder.
// When the last shading overlay closes, we restore the live webview.
//
// ADR-0002: "Sombra por snapshot como exceção" — the same webview_snapshot
// serves both annotation crop and overlay shade (two uses, one implementation).

type OverlayEntry = { id: string; shades: boolean }

let nextId = 0

// Singleton state shared across all hook instances
const listeners = new Set<() => void>()
let overlays: OverlayEntry[] = []
let snapshotDataUrl: string | null = null
let snapshotPath: string | null = null
let snapshotPending = false

const MODAL_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"][aria-modal="true"]',
  '.modal-backdrop',
  '.video-fallback-backdrop',
].join(',')

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function emit() {
  for (const listener of listeners) listener()
}

function hasShadingOverlays(): boolean {
  return overlays.some(o => o.shades)
}

function registerOverlay(id: string, shades: boolean) {
  overlays = [...overlays, { id, shades }]
  emit()
}

function unregisterOverlay(id: string) {
  overlays = overlays.filter(o => o.id !== id)
  emit()
}

async function captureSnapshotIfNeeded(browserOpen: boolean, browserVisible: boolean, activeTabId?: string, activeTabGeneration?: number): Promise<void> {
  if (!browserOpen || !browserVisible || snapshotPending || snapshotDataUrl) return
  if (!activeTabId) return  // No active webview to capture
  snapshotPending = true
  try {
    const result = await invoke<{ ms: number; bytes: number; path: string; dataUrl: string }>('browser_snapshot', {
      tabId: activeTabId,
      generation: activeTabGeneration ?? 0,
    })
    if (hasShadingOverlays()) {
      snapshotPath = result.path
      snapshotDataUrl = result.dataUrl
    } else {
      void invoke('browser_delete_temp_files', { paths: [result.path] }).catch(() => {})
    }
  } catch {
    // Snapshot failed — shade will be a blank area (acceptable fallback
    // per ADR-0002: "feio, mas nunca quebrado")
    snapshotDataUrl = null
  } finally {
    snapshotPending = false
    emit()
  }

  // The native child sits above renderer DOM. Only hide it after the static
  // replacement is ready, and only if the overlay is still open.
  if (hasShadingOverlays() && browserOpen && browserVisible) {
    await invoke('browser_session_set_visible', { visible: false }).catch(() => {})
  }
}

function clearSnapshot() {
  const path = snapshotPath
  snapshotPath = null
  snapshotDataUrl = null
  if (path) void invoke('browser_delete_temp_files', { paths: [path] }).catch(() => {})
}

export type OverlayShadeState = {
  /** Whether any overlay is currently shading the browser */
  isShading: boolean
  /** The captured snapshot data URL, or null if no snapshot */
  snapshotDataUrl: string | null
  /** Register an overlay. Returns an unregister function. */
  register: (shades?: boolean) => () => void
}

export function useOverlayShade(browserOpen: boolean, browserVisible = browserOpen, activeTabId?: string, activeTabGeneration?: number): OverlayShadeState {
  const [, forceUpdate] = useState(0)
  const [restorePending, setRestorePending] = useState(false)
  const idRef = useRef(`overlay-${++nextId}`)
  const wasShadingRef = useRef(false)

  useEffect(() => {
    return subscribe(() => forceUpdate(n => n + 1))
  }, [])

  // Native child webviews sit above renderer DOM. Observe true modal surfaces
  // centrally so a newly added dialog cannot accidentally punch through just
  // because its component forgot to register with the browser panel.
  useEffect(() => {
    if (!browserOpen) return
    let release: (() => void) | null = null
    const sync = () => {
      const modalPresent = Boolean(document.querySelector(MODAL_SELECTOR))
      if (modalPresent && !release) {
        const entry = createOverlayShadeEntry(true)
        release = entry.release
      } else if (!modalPresent && release) {
        release()
        release = null
      }
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'class', 'role'],
    })
    sync()
    return () => {
      observer.disconnect()
      release?.()
    }
  }, [browserOpen])

  const wantsShade = hasShadingOverlays()
  const isShading = wantsShade || restorePending

  // Capture snapshot when first shading overlay opens
  useEffect(() => {
    if (wantsShade && browserOpen && browserVisible) {
      wasShadingRef.current = true
      setRestorePending(false)
      void captureSnapshotIfNeeded(browserOpen, browserVisible, activeTabId, activeTabGeneration)
    }
  }, [wantsShade, browserOpen, browserVisible])

  // Clear snapshot when all shading overlays close
  useEffect(() => {
    if (wantsShade || !wasShadingRef.current) return

    // Keep the static shade visible through the overlay's exit transition;
    // showing the native child earlier would punch through the fading DOM.
    setRestorePending(true)
    const timer = setTimeout(() => {
      wasShadingRef.current = false
      clearSnapshot()
      emit()
      if (browserOpen && browserVisible) {
        void invoke('browser_session_set_visible', { visible: true }).catch(() => {})
      }
      setRestorePending(false)
    }, 140)
    return () => clearTimeout(timer)
  }, [wantsShade, browserOpen, browserVisible])

  const register = useCallback((shades = false) => {
    const id = `${idRef.current}-${++nextId}`
    registerOverlay(id, shades)
    return () => unregisterOverlay(id)
  }, [])

  return { isShading, snapshotDataUrl, register }
}

// Standalone function for components that don't use the hook
// (e.g., modals rendered outside the browser panel tree)
export function createOverlayShadeEntry(shades = false): { id: string; release: () => void } {
  const id = `overlay-${++nextId}`
  registerOverlay(id, shades)
  return {
    id,
    release: () => unregisterOverlay(id),
  }
}

// Reset singleton state — for testing only
export function _resetOverlayShadeForTests() {
  overlays = []
  if (snapshotPath) void invoke('browser_delete_temp_files', { paths: [snapshotPath] }).catch(() => {})
  snapshotPath = null
  snapshotDataUrl = null
  snapshotPending = false
  listeners.clear()
}
