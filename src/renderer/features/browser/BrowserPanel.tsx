import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ArrowLeft, ArrowRight, Globe, MousePointer2, PanelRightClose, Pencil, Plus, RefreshCw, RotateCcw } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useOverlayShade } from './useOverlayShade'
import type { AnnotationMode, BrowserNavigationRequest, BrowserReloadRequest } from './useBrowserPanel'
import { browserContentBounds } from './browserBounds'
import {
  createAnnotationAttachment,
  deleteBrowserCapture,
  deleteBrowserTempFiles,
  parseBrowserPageMessage,
  type AnnotationCandidate,
  type AnnotationCaptureReport,
  type BrowserPageMessage,
} from './browserAnnotations'
import type { AttachmentMeta } from '../../../shared/types'

type BrowserPanelProps = {
  browserOpen: boolean
  browserWidth: number
  annotationMode: AnnotationMode
  onSetWidth: (width: number) => void
  onClose: () => void
  onTogglePencil: () => void
  onToggleArrow: () => void
  onAddAnnotation: (attachment: AttachmentMeta) => void
  navigationRequest?: BrowserNavigationRequest
  onNavigationHandled: (id: string) => void
  reloadRequest?: BrowserReloadRequest
  onUrlChange: (url: string) => void
  onReloadSnapshot: (attachment: AttachmentMeta, request: BrowserReloadRequest) => void
  onReloadHandled: (id: string) => void
  minWidth: number
  maxWidth: number
}

export function BrowserPanel({
  browserOpen,
  browserWidth,
  annotationMode,
  onSetWidth,
  onClose,
  onTogglePencil,
  onToggleArrow,
  onAddAnnotation,
  navigationRequest,
  onNavigationHandled,
  reloadRequest,
  onUrlChange,
  onReloadSnapshot,
  onReloadHandled,
  minWidth,
  maxWidth,
}: BrowserPanelProps) {
  const { t } = useI18n()
  const panelRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const resizerRef = useRef<HTMLDivElement | null>(null)
  const [url, setUrl] = useState('')
  const { isShading, snapshotDataUrl } = useOverlayShade(browserOpen, Boolean(url))
  const [inputValue, setInputValue] = useState('')
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [alive, setAlive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(false)
  const rafIdRef = useRef(0)
  const transitionRafRef = useRef(0)
  const transitionDeadlineRef = useRef(0)
  const lastBoundsKeyRef = useRef('')
  const pendingAnnotationsRef = useRef(new Map<string, {
    candidate: AnnotationCandidate
    capture: Promise<AnnotationCaptureReport>
  }>())
  const pendingReloadRef = useRef<{ request: BrowserReloadRequest; processing: boolean } | null>(null)
  const lastAnnotationRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const manualPresenceRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const handledReloadIdsRef = useRef(new Set<string>())
  const reloadTimerRef = useRef(0)

  const evaluateBrowser = useCallback((script: string) => {
    return invoke('browser_evaluate_script', { script }).catch(() => undefined)
  }, [])

  const syncInjectedState = useCallback(() => {
    const copy = {
      pencilTitle: t('browser.miniModalWhy'),
      arrowTitle: t('browser.miniModalElement'),
      pencilPlaceholder: t('browser.miniModalPlaceholder'),
      arrowPlaceholder: t('browser.miniModalPlaceholder'),
      cancel: t('common.cancel'),
      add: t('browser.miniModalSend'),
    }
    void evaluateBrowser([
      'if (window.__verbooBrowser) {',
      `window.__verbooBrowser.setCopy(${JSON.stringify(copy)});`,
      `window.__verbooBrowser.setMode(${JSON.stringify(annotationMode)});`,
      '}',
    ].join(''))
  }, [annotationMode, evaluateBrowser, t])

  const completeInjectedAnnotation = useCallback((token: string) => {
    void evaluateBrowser([
      'if (window.__verbooBrowser) {',
      `window.__verbooBrowser.complete(${JSON.stringify(token)});`,
      `window.__verbooBrowser.setMode(${JSON.stringify(annotationMode)});`,
      '}',
    ].join(''))
  }, [annotationMode, evaluateBrowser])

  const finishPostEditReload = useCallback((request: BrowserReloadRequest) => {
    window.clearTimeout(reloadTimerRef.current)
    reloadTimerRef.current = window.setTimeout(() => {
      if (pendingReloadRef.current?.request.id !== request.id) return
      void invoke<{ ms: number; bytes: number; path: string }>('browser_snapshot')
        .then(snapshot => {
          if (pendingReloadRef.current?.request.id !== request.id) {
            void deleteBrowserTempFiles([snapshot.path]).catch(() => {})
            return
          }
          onReloadSnapshot({
            path: snapshot.path,
            name: t('browser.resultAttachment'),
            size: snapshot.bytes,
            kind: 'image',
            mediaType: 'image/png',
            extractedText: t('browser.resultAttachmentDescription'),
            extractionStatus: 'extracted',
          }, request)
        })
        .catch(() => {})
        .finally(() => {
          if (pendingReloadRef.current?.request.id !== request.id) return
          void evaluateBrowser(
            `window.__verbooBrowser && window.__verbooBrowser.showPresence(${JSON.stringify(request.targetRect)});`,
          )
          pendingReloadRef.current = null
          onReloadHandled(request.id)
        })
    }, 180)
  }, [evaluateBrowser, onReloadHandled, onReloadSnapshot, t])

  const handlePageMessage = useCallback((message: BrowserPageMessage) => {
    if (message.type === 'page-ready') {
      if (message.url !== 'about:blank') {
        setUrl(message.url)
        setInputValue(message.url)
        onUrlChange(message.url)
      }
      setCanGoBack(message.historyLength > 1)
      syncInjectedState()

      for (const [token, pending] of pendingAnnotationsRef.current) {
        if (pending.candidate.url !== message.url) {
          pendingAnnotationsRef.current.delete(token)
          void pending.capture.then(deleteBrowserCapture).catch(() => {})
          completeInjectedAnnotation(token)
          continue
        }
        void evaluateBrowser([
          'if (window.__verbooBrowser) {',
          `window.__verbooBrowser.restoreCandidate(${JSON.stringify(pending.candidate)});`,
          '}',
        ].join('')).then(() => pending.capture.then(() => evaluateBrowser(
          `window.__verbooBrowser && window.__verbooBrowser.openNoteModal(${JSON.stringify(token)});`,
        ))).catch(() => {})
      }

      const pendingReload = pendingReloadRef.current
      if (pendingReload && message.url !== pendingReload.request.url) {
        window.clearTimeout(reloadTimerRef.current)
        pendingReloadRef.current = null
        onReloadHandled(pendingReload.request.id)
      }
      return
    }

    if (message.type === 'page-loaded') {
      const pendingReload = pendingReloadRef.current
      if (pendingReload && !pendingReload.processing && message.url === pendingReload.request.url) {
        pendingReload.processing = true
        finishPostEditReload(pendingReload.request)
      } else if (manualPresenceRef.current) {
        const rect = manualPresenceRef.current
        manualPresenceRef.current = null
        window.setTimeout(() => {
          void evaluateBrowser(
            `window.__verbooBrowser && window.__verbooBrowser.showPresence(${JSON.stringify(rect)});`,
          )
        }, 120)
      }
      return
    }

    if (message.type === 'annotation-candidate') {
      const expectedMode: AnnotationMode = message.kind === 'pen' ? 'pencil' : 'arrow'
      if (annotationMode !== expectedMode || pendingAnnotationsRef.current.size > 0 || message.url !== url) return
      lastAnnotationRectRef.current = message.rect
      const capture = invoke<AnnotationCaptureReport>('browser_capture_annotation', {
        request: { rect: message.rect, viewport: message.viewport },
      })
      pendingAnnotationsRef.current.set(message.token, { candidate: message, capture })
      void capture.then(() => evaluateBrowser(
        `window.__verbooBrowser && window.__verbooBrowser.openNoteModal(${JSON.stringify(message.token)});`,
      )).catch(() => {
        pendingAnnotationsRef.current.delete(message.token)
        completeInjectedAnnotation(message.token)
      })
      return
    }

    if (message.type === 'annotation-cancel') {
      const pending = pendingAnnotationsRef.current.get(message.token)
      pendingAnnotationsRef.current.delete(message.token)
      if (pending) void pending.capture.then(deleteBrowserCapture).catch(() => {})
      completeInjectedAnnotation(message.token)
      return
    }

    const pending = pendingAnnotationsRef.current.get(message.token)
    if (!pending) return
    pendingAnnotationsRef.current.delete(message.token)
    void pending.capture.then(capture => {
      onAddAnnotation(createAnnotationAttachment(pending.candidate, message.note, capture))
      completeInjectedAnnotation(message.token)
    }).catch(() => completeInjectedAnnotation(message.token))
  }, [annotationMode, completeInjectedAnnotation, evaluateBrowser, finishPostEditReload, onAddAnnotation, onReloadHandled, onUrlChange, syncInjectedState, url])

  // A webview nativa deve cobrir SÓ a caixa .browser-content (abaixo de
  // tabs+toolbar), medida ao vivo, pra nunca sobrepor a chrome React. O
  // fallback cobre o tick pré-layout (contentRef ainda sem medida); ele é
  // corrigido logo em seguida pelo ResizeObserver → browser_set_bounds.
  const computeBounds = useCallback(() => {
    const rect = contentRef.current?.getBoundingClientRect()
    return browserContentBounds({
      rect: rect ?? null,
      browserWidth,
      viewportWidth: window.innerWidth,
    })
  }, [browserWidth])

  const syncBounds = useCallback(() => {
    if (!aliveRef.current) return
    const bounds = computeBounds()
    const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
    if (key === lastBoundsKeyRef.current) return
    lastBoundsKeyRef.current = key
    void invoke('browser_set_bounds', { bounds }).catch(() => {})
  }, [computeBounds])

  const trackBoundsThroughTransition = useCallback(() => {
    transitionDeadlineRef.current = performance.now() + 360
    if (transitionRafRef.current) return

    const tick = () => {
      syncBounds()
      if (performance.now() < transitionDeadlineRef.current) {
        transitionRafRef.current = requestAnimationFrame(tick)
      } else {
        transitionRafRef.current = 0
      }
    }

    transitionRafRef.current = requestAnimationFrame(tick)
  }, [syncBounds])

  // ── ResizeObserver → throttle rAF → browser_set_bounds ──
  useEffect(() => {
    if (!browserOpen || !contentRef.current) return
    const content = contentRef.current

    function flushBounds() {
      rafIdRef.current = 0
      syncBounds()
    }

    const observer = new ResizeObserver(() => {
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(flushBounds)
      }
    })

    observer.observe(content)
    return () => {
      observer.disconnect()
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = 0
      }
    }
  }, [browserOpen, syncBounds])

  // ResizeObserver does not fire when the grid animation changes only the
  // panel's position. Follow the transition frame-by-frame and commit one
  // final measurement on transitionend so the native child never remains at
  // an intermediate x coordinate.
  useEffect(() => {
    if (!browserOpen) return
    const layout = panelRef.current?.closest('.app-layout')
    if (!layout) return

    const onTransitionRun = (event: Event) => {
      if ((event as TransitionEvent).propertyName === 'grid-template-columns') {
        trackBoundsThroughTransition()
      }
    }
    const onTransitionEnd = (event: Event) => {
      if ((event as TransitionEvent).propertyName === 'grid-template-columns') {
        syncBounds()
      }
    }

    layout.addEventListener('transitionrun', onTransitionRun)
    layout.addEventListener('transitionend', onTransitionEnd)
    return () => {
      layout.removeEventListener('transitionrun', onTransitionRun)
      layout.removeEventListener('transitionend', onTransitionEnd)
    }
  }, [browserOpen, syncBounds, trackBoundsThroughTransition])

  // ── Also sync bounds on window resize ──
  useEffect(() => {
    if (!browserOpen) return
    function onResize() {
      onSetWidth(browserWidth)
      trackBoundsThroughTransition()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [browserOpen, browserWidth, onSetWidth, trackBoundsThroughTransition])

  // Drain the page→app channel while the native child is alive. Polling keeps
  // the command surface small and messages are consumed exactly once.
  useEffect(() => {
    if (!browserOpen || !alive) return
    let active = true
    let draining = false
    const drain = async () => {
      if (!active || draining) return
      draining = true
      try {
        const messages = await invoke<string[]>('browser_drain_messages')
        if (Array.isArray(messages)) {
          for (const raw of messages) {
            const message = parseBrowserPageMessage(raw)
            if (message) handlePageMessage(message)
          }
        }
      } catch {
        // A navigation can briefly replace the message handler; retry next tick.
      } finally {
        draining = false
      }
    }
    void drain()
    const timer = window.setInterval(() => { void drain() }, 80)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [alive, browserOpen, handlePageMessage])

  useEffect(() => {
    if (alive) syncInjectedState()
  }, [alive, syncInjectedState])

  useEffect(() => {
    if (!alive || !url) return
    let active = true
    let consecutiveFailures = 0
    const timer = window.setInterval(() => {
      void invoke('browser_healthcheck').then(() => {
        consecutiveFailures = 0
      }).catch(() => {
        if (!active) return
        consecutiveFailures += 1
        if (consecutiveFailures < 3) return
        active = false
        window.clearInterval(timer)
        aliveRef.current = false
        setAlive(false)
        setError(t('browser.error'))
        void invoke('browser_set_visible', { visible: false }).catch(() => {})
        void invoke('browser_destroy').catch(() => {})
      })
    }, 2_500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [alive, t, url])

  useEffect(() => {
    if (!alive || !reloadRequest || !url || handledReloadIdsRef.current.has(reloadRequest.id)) return
    handledReloadIdsRef.current.add(reloadRequest.id)
    if (url !== reloadRequest.url) {
      onReloadHandled(reloadRequest.id)
      return
    }
    pendingReloadRef.current = { request: reloadRequest, processing: false }
    void invoke('browser_reload').catch(() => {
      pendingReloadRef.current = null
      onReloadHandled(reloadRequest.id)
    })
  }, [alive, onReloadHandled, reloadRequest, url])

  // ── Create / destroy webview on open/close ──
  useEffect(() => {
    if (browserOpen && !aliveRef.current) {
      setError(null)
      lastBoundsKeyRef.current = ''
      void invoke('browser_create', { bounds: computeBounds(), url: url || null }).then(() => {
        aliveRef.current = true
        setAlive(true)
        trackBoundsThroughTransition()
        return invoke('browser_set_visible', { visible: Boolean(url) })
      }).catch((err) => {
        setError(String(err))
      })
    }
    if (!browserOpen && aliveRef.current) {
      aliveRef.current = false
      setAlive(false)
      for (const pending of pendingAnnotationsRef.current.values()) {
        void pending.capture.then(deleteBrowserCapture).catch(() => {})
      }
      pendingAnnotationsRef.current.clear()
      const pendingReload = pendingReloadRef.current
      if (pendingReload) onReloadHandled(pendingReload.request.id)
      pendingReloadRef.current = null
      window.clearTimeout(reloadTimerRef.current)
      void invoke('browser_destroy').catch(() => {})
    }
  }, [browserOpen, browserWidth, computeBounds, onReloadHandled, trackBoundsThroughTransition, url])

  const handleRecreate = useCallback(() => {
    setError(null)
    aliveRef.current = false
    setAlive(false)
    lastBoundsKeyRef.current = ''
    void invoke('browser_destroy').catch(() => {}).finally(() => {
      void invoke('browser_create', { bounds: computeBounds(), url: url || null }).then(() => {
        aliveRef.current = true
        setAlive(true)
        trackBoundsThroughTransition()
        return invoke('browser_set_visible', { visible: Boolean(url) })
      }).catch((err) => {
        setError(String(err))
      })
    })
  }, [computeBounds, trackBoundsThroughTransition, url])

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      if (aliveRef.current) {
        aliveRef.current = false
        void invoke('browser_destroy').catch(() => {})
      }
      if (transitionRafRef.current) {
        cancelAnimationFrame(transitionRafRef.current)
        transitionRafRef.current = 0
      }
      window.clearTimeout(reloadTimerRef.current)
      for (const pending of pendingAnnotationsRef.current.values()) {
        void pending.capture.then(deleteBrowserCapture).catch(() => {})
      }
      pendingAnnotationsRef.current.clear()
    }
  }, [])

  // ── Navigation ──
  const handleNavigate = useCallback((targetUrl: string) => {
    const finalUrl = normalizeBrowserUrl(targetUrl)
    if (!finalUrl) {
      setError(t('browser.invalidUrl'))
      void invoke('browser_set_visible', { visible: false }).catch(() => {})
      return
    }
    setUrl(finalUrl)
    setInputValue(finalUrl)
    setCanGoForward(false)
    setError(null)
    void invoke('browser_navigate', { url: finalUrl })
      .then(() => invoke('browser_set_visible', { visible: true }))
      .catch((err) => {
        setError(String(err))
        void invoke('browser_set_visible', { visible: false }).catch(() => {})
      })
  }, [t])

  useEffect(() => {
    if (!alive || !navigationRequest) return
    handleNavigate(navigationRequest.url)
    onNavigationHandled(navigationRequest.id)
  }, [alive, handleNavigate, navigationRequest, onNavigationHandled])

  const handleUrlKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      handleNavigate(inputValue)
    }
  }, [inputValue, handleNavigate])

  const handleBack = useCallback(() => {
    void invoke('browser_back').then(() => setCanGoForward(true)).catch(() => {})
  }, [])

  const handleForward = useCallback(() => {
    void invoke('browser_forward').then(() => setCanGoForward(false)).catch(() => {})
  }, [])

  const handleReload = useCallback(() => {
    if (url) {
      manualPresenceRef.current = lastAnnotationRectRef.current
      setError(null)
      void invoke('browser_reload').catch((err) => {
        setError(String(err))
        void invoke('browser_set_visible', { visible: false }).catch(() => {})
      })
    }
  }, [url])

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
        role="separator"
        aria-orientation="vertical"
        aria-label={t('browser.resize')}
        aria-valuemin={Math.min(minWidth, maxWidth)}
        aria-valuemax={maxWidth}
        aria-valuenow={browserWidth}
      />

      {/* Tab bar */}
      <div className="browser-tabs">
        <button type="button" className="browser-tab" disabled>
          <Globe size={12} />
          {url ? browserTabLabel(url) : t('browser.newTab')}
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
          className="browser-nav-button ui-tooltip"
          onClick={onClose}
          aria-label={t('topbar.hideBrowser')}
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
          className="browser-nav-button ui-tooltip"
          onClick={handleBack}
          disabled={!alive || !canGoBack}
          aria-label={t('browser.back')}
          data-tooltip={t('browser.back')}
          data-tooltip-align="end"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="browser-nav-button ui-tooltip"
          onClick={handleForward}
          disabled={!alive || !canGoForward}
          aria-label={t('browser.forward')}
          data-tooltip={t('browser.forward')}
          data-tooltip-align="end"
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className="browser-nav-button ui-tooltip"
          onClick={handleReload}
          disabled={!alive || !url}
          aria-label={t('browser.reload')}
          data-tooltip={t('browser.reload')}
          data-tooltip-align="end"
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          className={`browser-nav-button ui-tooltip ${annotationMode === 'pencil' ? 'active' : ''}`}
          onClick={onTogglePencil}
          disabled={!alive || !url}
          aria-label={annotationMode === 'pencil' ? t('browser.pencilMode') : t('browser.pencil')}
          data-tooltip={annotationMode === 'pencil' ? t('browser.pencilMode') : t('browser.pencil')}
          data-tooltip-align="end"
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className={`browser-nav-button ui-tooltip ${annotationMode === 'arrow' ? 'active' : ''}`}
          onClick={onToggleArrow}
          disabled={!alive || !url}
          aria-label={annotationMode === 'arrow' ? t('browser.arrowMode') : t('browser.arrow')}
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
      <div className="browser-content" ref={contentRef}>
        {!url && !error && (
          <div className="browser-empty-state">
            {t('browser.emptyState')}
          </div>
        )}
        {error && (
          <div className="browser-empty-state" role="alert">
            <p>{error === t('browser.invalidUrl') ? error : t('browser.error')}</p>
            <button type="button" className="browser-recreate-button" onClick={handleRecreate}>
              <RotateCcw size={13} />
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

function normalizeBrowserUrl(rawValue: string): string | null {
  let value = rawValue.trim()
  if (!value) return null
  if (/^localhost(?::\d+)?(?:\/.*)?$/i.test(value)) {
    value = `http://${value}`
  } else if (!/^[a-z][a-z\d+.-]*:/i.test(value)) {
    value = `https://${value}`
  }

  try {
    const parsed = new URL(value)
    if (!['http:', 'https:', 'about:', 'file:'].includes(parsed.protocol)) return null
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.hostname) return null
    return value
  } catch {
    return null
  }
}

function browserTabLabel(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname || parsed.pathname || parsed.protocol.replace(':', '')
  } catch {
    return url
  }
}
