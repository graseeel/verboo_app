import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ArrowLeft, ArrowRight, Globe, MousePointer2, PanelRightClose, Pencil, Plus, RefreshCw, RotateCcw } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useOverlayShade } from './useOverlayShade'
import type { AnnotationMode } from './useBrowserPanel'

type BrowserPanelProps = {
  browserOpen: boolean
  browserWidth: number
  annotationMode: AnnotationMode
  onSetWidth: (width: number) => void
  onClose: () => void
  onTogglePencil: () => void
  onToggleArrow: () => void
  minWidth: number
}

export function BrowserPanel({
  browserOpen,
  browserWidth,
  annotationMode,
  onSetWidth,
  onClose,
  onTogglePencil,
  onToggleArrow,
  minWidth,
}: BrowserPanelProps) {
  const { t } = useI18n()
  const panelRef = useRef<HTMLElement | null>(null)
  const resizerRef = useRef<HTMLDivElement | null>(null)
  const { isShading, snapshotDataUrl } = useOverlayShade(browserOpen)
  const [url, setUrl] = useState('')
  const [inputValue, setInputValue] = useState('')
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [alive, setAlive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(false)
  const rafIdRef = useRef(0)
  const pendingBoundsRef = useRef<{ width: number; height: number; x: number; y: number } | null>(null)

  const PANEL_TOP = 36 // titlebar height

  // ── ResizeObserver → throttle rAF → browser_set_bounds ──
  useEffect(() => {
    if (!browserOpen || !panelRef.current) return
    const panel = panelRef.current

    function flushBounds() {
      rafIdRef.current = 0
      const bounds = pendingBoundsRef.current
      if (!bounds || !aliveRef.current) return
      void invoke('browser_set_bounds', bounds).catch(() => {})
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width < 1 || height < 1) continue
        pendingBoundsRef.current = {
          x: Math.max(0, window.innerWidth - width - 12),
          y: PANEL_TOP,
          width,
          height: Math.max(200, height),
        }
        if (!rafIdRef.current) {
          rafIdRef.current = requestAnimationFrame(flushBounds)
        }
      }
    })

    observer.observe(panel)
    return () => {
      observer.disconnect()
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = 0
      }
    }
  }, [browserOpen])

  // ── Also sync bounds on window resize ──
  useEffect(() => {
    if (!browserOpen) return
    function onResize() {
      if (!aliveRef.current || !panelRef.current) return
      const rect = panelRef.current.getBoundingClientRect()
      if (rect.width < 1) return
      void invoke('browser_set_bounds', {
        x: Math.max(0, window.innerWidth - rect.width - 12),
        y: PANEL_TOP,
        width: rect.width,
        height: Math.max(200, rect.height),
      }).catch(() => {})
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [browserOpen])

  // ── Create / destroy webview on open/close ──
  useEffect(() => {
    if (browserOpen && !aliveRef.current) {
      setError(null)
      const rect = panelRef.current?.getBoundingClientRect()
      const bounds = rect && rect.width > 1
        ? {
            x: Math.max(0, window.innerWidth - rect.width - 12),
            y: PANEL_TOP,
            width: rect.width,
            height: Math.max(200, rect.height),
          }
        : { x: Math.max(0, window.innerWidth - browserWidth - 12), y: PANEL_TOP, width: browserWidth, height: 600 }
      void invoke<string>('browser_create', bounds).then(() => {
        aliveRef.current = true
        setAlive(true)
      }).catch((err) => {
        setError(String(err))
      })
    }
    if (!browserOpen && aliveRef.current) {
      aliveRef.current = false
      setAlive(false)
      void invoke('browser_destroy').catch(() => {})
    }
  }, [browserOpen, browserWidth])

  const handleRecreate = useCallback(() => {
    setError(null)
    aliveRef.current = false
    setAlive(false)
    void invoke('browser_destroy').catch(() => {}).finally(() => {
      const rect = panelRef.current?.getBoundingClientRect()
      const bounds = rect && rect.width > 1
        ? {
            x: Math.max(0, window.innerWidth - rect.width - 12),
            y: PANEL_TOP,
            width: rect.width,
            height: Math.max(200, rect.height),
          }
        : { x: Math.max(0, window.innerWidth - browserWidth - 12), y: PANEL_TOP, width: browserWidth, height: 600 }
      void invoke<string>('browser_create', bounds).then(() => {
        aliveRef.current = true
        setAlive(true)
      }).catch((err) => {
        setError(String(err))
      })
    })
  }, [browserWidth])

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      if (aliveRef.current) {
        aliveRef.current = false
        void invoke('browser_destroy').catch(() => {})
      }
    }
  }, [])

  // ── Navigation ──
  const handleNavigate = useCallback((targetUrl: string) => {
    let finalUrl = targetUrl.trim()
    if (!finalUrl) return
    // Allow localhost without protocol
    if (!/^https?:\/\//i.test(finalUrl)) {
      if (/^localhost(:\d+)?(\/.*)?$/i.test(finalUrl)) {
        finalUrl = `http://${finalUrl}`
      } else {
        finalUrl = `https://${finalUrl}`
      }
    }
    setUrl(finalUrl)
    setInputValue(finalUrl)
    void invoke('browser_navigate', { url: finalUrl }).catch(() => {})
  }, [])

  const handleUrlKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      handleNavigate(inputValue)
    }
  }, [inputValue, handleNavigate])

  const handleBack = useCallback(() => {
    void invoke('browser_back').catch(() => {})
  }, [])

  const handleForward = useCallback(() => {
    void invoke('browser_forward').catch(() => {})
  }, [])

  const handleReload = useCallback(() => {
    if (url) handleNavigate(url)
  }, [url, handleNavigate])

  // ── Resizer drag ──
  const handleResizerPointerDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = browserWidth

    function handlePointerMove(moveEvent: PointerEvent) {
      const delta = startX - moveEvent.clientX
      onSetWidth(startWidth + delta)
    }

    function stopResize() {
      document.querySelector('.app-layout')?.classList.remove('is-resizing')
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
    }

    document.querySelector('.app-layout')?.classList.add('is-resizing')
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
  }, [browserWidth, onSetWidth])

  return (
    <aside
      ref={panelRef}
      className={`browser-panel ${browserOpen ? 'is-open' : 'is-hidden'} ${annotationMode === 'pencil' ? 'mode-pencil' : ''} ${annotationMode === 'arrow' ? 'mode-arrow' : ''}`}
      style={{ width: browserOpen ? browserWidth : 0 }}
      aria-hidden={!browserOpen}
    >
      <div
        className="browser-resizer"
        onPointerDown={handleResizerPointerDown}
      />

      {/* Tab bar */}
      <div className="browser-tabs">
        <button type="button" className="browser-tab" disabled>
          <Globe size={12} />
          {url ? new URL(url).hostname : t('browser.newTab')}
        </button>
        <button
          type="button"
          className="browser-tab-add ui-tooltip"
          disabled
          data-tooltip={t('browser.tabsComingSoon')}
          data-tooltip-align="end"
        >
          <Plus size={13} />
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="browser-nav-button"
          onClick={onClose}
          data-tooltip={t('topbar.hideBrowser')}
          data-tooltip-align="end"
        >
          <PanelRightClose size={14} />
        </button>
      </div>

      {/* Toolbar */}
      <div className="browser-toolbar">
        <button
          type="button"
          className="browser-nav-button"
          onClick={handleBack}
          disabled={!alive || !canGoBack}
          data-tooltip={t('browser.back')}
          data-tooltip-align="end"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="browser-nav-button"
          onClick={handleForward}
          disabled={!alive || !canGoForward}
          data-tooltip={t('browser.forward')}
          data-tooltip-align="end"
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className="browser-nav-button"
          onClick={handleReload}
          disabled={!alive || !url}
          data-tooltip={t('browser.reload')}
          data-tooltip-align="end"
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          className={`browser-nav-button ui-tooltip ${annotationMode === 'pencil' ? 'active' : ''}`}
          onClick={onTogglePencil}
          disabled={!alive}
          data-tooltip={annotationMode === 'pencil' ? t('browser.pencilMode') : t('browser.pencil')}
          data-tooltip-align="end"
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className={`browser-nav-button ui-tooltip ${annotationMode === 'arrow' ? 'active' : ''}`}
          onClick={onToggleArrow}
          disabled={!alive}
          data-tooltip={annotationMode === 'arrow' ? t('browser.arrowMode') : t('browser.arrow')}
          data-tooltip-align="end"
        >
          <MousePointer2 size={13} />
        </button>
        <input
          className="browser-url-input"
          type="text"
          value={inputValue}
          onChange={event => setInputValue(event.target.value)}
          onKeyDown={handleUrlKeyDown}
          placeholder={t('browser.urlPlaceholder')}
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {/* Content — webview is native, this is the empty/error state fallback */}
      <div className="browser-content">
        {!url && !error && (
          <div className="browser-empty-state">
            {t('browser.emptyState')}
          </div>
        )}
        {error && (
          <div className="browser-empty-state">
            <p>{t('browser.error')}</p>
            <button type="button" className="browser-nav-button" onClick={handleRecreate} style={{ marginTop: 8 }}>
              <RotateCcw size={13} />
              {' '}
              {t('browser.recreate')}
            </button>
          </div>
        )}

        {/* Overlay shade (ADR-0002): captures snapshot → hides webview → shows static img */}
        <div className={`browser-shade ${isShading ? 'is-active' : ''}`}>
          {snapshotDataUrl && (
            <img className="browser-shade-img" src={snapshotDataUrl} alt="" draggable={false} />
          )}
        </div>
      </div>
    </aside>
  )
}
