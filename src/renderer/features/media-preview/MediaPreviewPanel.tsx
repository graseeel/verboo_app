import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { PanelRightClose } from 'lucide-react'
import type { TranscriptMediaAttachment } from '../../components/Transcript'
import { useI18n } from '../../i18n'

type MediaPreviewPanelProps = {
  media: TranscriptMediaAttachment
  open: boolean
  width: number
  minWidth: number
  maxWidth: number
  onClose: () => void
  onSetWidth: (width: number) => void
}

export const MEDIA_PREVIEW_TRANSITION_MS = 220

export function MediaPreviewPanel({
  media,
  open,
  width,
  minWidth,
  maxWidth,
  onClose,
  onSetWidth,
}: MediaPreviewPanelProps) {
  const { t } = useI18n()
  const resizerRef = useRef<HTMLDivElement | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [mediaLoaded, setMediaLoaded] = useState(false)
  const [source, setSource] = useState<string>()
  const isVideo = media.kind === 'video'

  useEffect(() => {
    let cancelled = false
    setLoadError(false)
    setMediaLoaded(false)
    setSource(undefined)
    void window.verboo.allowMediaPreviewFile(media.path)
      .then(allowedPath => {
        if (cancelled) return
        const nextSource = window.verboo.fileUrl(allowedPath)
        if (nextSource) setSource(nextSource)
        else setLoadError(true)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [media.path])

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const layout = document.querySelector('.app-layout')
    layout?.classList.add('is-resizing')
    const move = (moveEvent: PointerEvent) => {
      onSetWidth(Math.max(minWidth, Math.min(maxWidth, startWidth + startX - moveEvent.clientX)))
    }
    const stop = () => {
      layout?.classList.remove('is-resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (resizerRef.current?.hasPointerCapture?.(event.pointerId)) {
        resizerRef.current.releasePointerCapture(event.pointerId)
      }
    }
    resizerRef.current?.setPointerCapture(event.pointerId)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', stop, { once: true })
  }

  return (
    <aside
      className="media-preview-panel"
      style={{
        width,
        '--media-preview-transition-duration': `${MEDIA_PREVIEW_TRANSITION_MS}ms`,
      } as CSSProperties}
      data-open={String(open)}
      aria-hidden={!open}
      inert={!open}
      role="region"
      aria-label={t('mediaPreview.title')}
    >
      <div
        className="media-preview-resizer"
        ref={resizerRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('mediaPreview.resize')}
        aria-valuemin={Math.min(minWidth, maxWidth)}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        onPointerDown={startResize}
      />
      <header className="media-preview-header">
        <div className="media-preview-heading">
          <strong>{t('mediaPreview.title')}</strong>
          <span title={media.path}>{media.name}</span>
        </div>
        <button
          type="button"
          className="icon-button tiny"
          onClick={onClose}
          aria-label={t('mediaPreview.close')}
          title={t('mediaPreview.close')}
        >
          <PanelRightClose size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="media-preview-content">
        {loadError ? (
          <div className="media-preview-error" role="alert">
            <strong>{t('mediaPreview.loadError')}</strong>
            <span>{media.name}</span>
          </div>
        ) : source && isVideo ? (
          <video
            key={media.path}
            className={`media-preview-video ${mediaLoaded ? 'is-ready' : ''}`}
            src={source}
            aria-label={media.name}
            controls
            preload="metadata"
            playsInline
            onLoadedMetadata={() => setMediaLoaded(true)}
            onError={() => setLoadError(true)}
          />
        ) : source ? (
          <img
            key={media.path}
            className={`media-preview-image ${mediaLoaded ? 'is-ready' : ''}`}
            src={source}
            alt={media.name}
            loading="lazy"
            onLoad={() => setMediaLoaded(true)}
            onError={() => setLoadError(true)}
          />
        ) : null}
      </div>
    </aside>
  )
}
