import { useCallback, useEffect, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'

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
let snapshotPending = false

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

async function captureSnapshotIfNeeded(browserOpen: boolean): Promise<void> {
  if (!browserOpen || snapshotPending || snapshotDataUrl) return
  snapshotPending = true
  try {
    // Rust exposes browser_snapshot which returns { ms, bytes, path }.
    // Convert the temp file path to a URL the webview can load as an img src.
    const result = await invoke<{ ms: number; bytes: number; path: string }>('browser_snapshot')
    snapshotDataUrl = convertFileSrc(result.path)
  } catch {
    // Snapshot failed — shade will be a blank area (acceptable fallback
    // per ADR-0002: "feio, mas nunca quebrado")
    snapshotDataUrl = null
  } finally {
    snapshotPending = false
  }
}

function clearSnapshot() {
  snapshotDataUrl = null
}

export type OverlayShadeState = {
  /** Whether any overlay is currently shading the browser */
  isShading: boolean
  /** The captured snapshot data URL, or null if no snapshot */
  snapshotDataUrl: string | null
  /** Register an overlay. Returns an unregister function. */
  register: (shades?: boolean) => () => void
}

export function useOverlayShade(browserOpen: boolean): OverlayShadeState {
  const [, forceUpdate] = useState(0)
  const idRef = useRef(`overlay-${++nextId}`)

  useEffect(() => {
    return subscribe(() => forceUpdate(n => n + 1))
  }, [])

  const isShading = hasShadingOverlays()

  // Capture snapshot when first shading overlay opens
  useEffect(() => {
    if (isShading && browserOpen) {
      void captureSnapshotIfNeeded(browserOpen)
    }
  }, [isShading, browserOpen])

  // Clear snapshot when all shading overlays close
  useEffect(() => {
    if (!isShading) {
      // Delay clear so the transition can use the snapshot
      const timer = setTimeout(clearSnapshot, 300)
      return () => clearTimeout(timer)
    }
  }, [isShading])

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
  snapshotDataUrl = null
  snapshotPending = false
  listeners.clear()
}
