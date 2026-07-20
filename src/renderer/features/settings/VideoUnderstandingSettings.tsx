import { Film, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  VideoComponentState,
  VideoFallbackConsent,
  VideoTranscriberProgress,
} from '../../../shared/types'
import { useI18n } from '../../i18n'

type VideoUnderstandingSettingsProps = {
  consent: VideoFallbackConsent
  onConsentChange: (consent: VideoFallbackConsent) => void
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'absent' }
  | { kind: 'ready'; bytes: number }
  | { kind: 'downloading'; bytes: number; total: number }
  | { kind: 'error'; message: string }

function fromComponentState(state: VideoComponentState): ViewState {
  return state.asrModel === 'ready'
    ? { kind: 'ready', bytes: state.bytes ?? 0 }
    : { kind: 'absent' }
}

export function VideoUnderstandingSettings({ consent, onConsentChange }: VideoUnderstandingSettingsProps) {
  const { t } = useI18n()
  const [state, setState] = useState<ViewState>({ kind: 'loading' })
  const [confirmingDownload, setConfirmingDownload] = useState(false)

  async function refresh() {
    try {
      setState(fromComponentState(await window.verboo.getVideoComponentState()))
    } catch (error) {
      setState({ kind: 'error', message: String(error) })
    }
  }

  useEffect(() => {
    void refresh()
    return window.verboo.onVideoTranscriberProgress((progress: VideoTranscriberProgress) => {
      if (progress.state === 'downloading') {
        setState({ kind: 'downloading', bytes: progress.bytesDownloaded, total: progress.totalBytes })
      } else if (progress.state === 'ready') {
        setState({ kind: 'ready', bytes: progress.totalBytes })
        setConfirmingDownload(false)
      } else {
        setState({ kind: 'error', message: progress.error ?? t('videoSettings.downloadFailed') })
      }
    })
  // The bridge and translator are stable for the lifetime of the app.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function startDownload() {
    setState({ kind: 'downloading', bytes: 0, total: 147951465 })
    try {
      await window.verboo.downloadVideoTranscriber()
      await refresh()
      setConfirmingDownload(false)
    } catch (error) {
      setState({ kind: 'error', message: String(error) })
    }
  }

  async function removeModel() {
    try {
      await window.verboo.removeVideoTranscriber()
      setState({ kind: 'absent' })
    } catch (error) {
      setState({ kind: 'error', message: String(error) })
    }
  }

  const percentage = state.kind === 'downloading' && state.total > 0
    ? Math.min(100, Math.round((state.bytes / state.total) * 100))
    : 0

  return (
    <section className="settings-panel video-understanding-settings">
      <div className="settings-row">
        <Film size={16} aria-hidden="true" />
        <div>
          <strong>{t('videoSettings.title')}</strong>
          <p>{t('videoSettings.description')}</p>
        </div>
      </div>

      <div className="settings-select-row video-consent-row">
        <span>
          <strong>{t('videoSettings.consent')}</strong>
          <small>{t('videoSettings.consentDescription')}</small>
        </span>
        <div className="segmented-control" role="radiogroup" aria-label={t('videoSettings.consent')}>
          {(['ask', 'always', 'never'] as const).map(value => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={consent === value}
              className={consent === value ? 'active' : ''}
              onClick={() => onConsentChange(value)}
            >
              {t(`videoSettings.${value}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row video-model-row">
        {state.kind === 'downloading' ? <Loader2 className="t-spin" size={16} aria-hidden="true" /> : <Film size={16} aria-hidden="true" />}
        <div>
          <strong>{t('videoSettings.modelTitle')}</strong>
          <p>
            {state.kind === 'loading' && t('videoSettings.loading')}
            {state.kind === 'absent' && t('videoSettings.absent')}
            {state.kind === 'ready' && `${t('videoSettings.ready')} · ${(state.bytes / 1_000_000).toFixed(1)} MB`}
            {state.kind === 'downloading' && `${t('videoSettings.downloading')} ${percentage}%`}
            {state.kind === 'error' && state.message}
          </p>
        </div>
        {state.kind === 'ready' ? (
          <button type="button" onClick={() => void removeModel()}>{t('videoSettings.remove')}</button>
        ) : state.kind !== 'loading' && state.kind !== 'downloading' && !confirmingDownload ? (
          <button type="button" onClick={() => setConfirmingDownload(true)}>
            {state.kind === 'error' ? t('videoSettings.retry') : t('videoSettings.download')}
          </button>
        ) : null}
      </div>

      {state.kind === 'downloading' && <progress max={100} value={percentage} aria-label={t('videoSettings.downloading')} />}
      {confirmingDownload && (
        <div className="video-download-confirmation">
          <p>{t('videoSettings.confirmDescription')}</p>
          <button type="button" onClick={() => setConfirmingDownload(false)}>{t('common.cancel')}</button>
          <button type="button" onClick={() => void startDownload()}>{t('videoSettings.confirmDownload')}</button>
        </div>
      )}
      <p className="video-artifact-note">{t('videoSettings.artifactNote')}</p>
    </section>
  )
}
