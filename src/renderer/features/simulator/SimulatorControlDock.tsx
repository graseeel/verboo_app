import { useEffect, useRef, useState, type ComponentType } from 'react'
import {
  Camera,
  Power,
  Unplug,
  Video,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { SimulatorTooltipButton } from './SimulatorTooltip'
import type {
  IosSimulatorMediaFile,
  IosSimulatorOwnership,
  IosSimulatorRecordingState,
  IosSimulatorSystemAction,
} from './iosSimulatorApi'

type SimulatorControlDockProps<A extends string = IosSimulatorSystemAction> = {
  deviceName: string
  ownership: IosSimulatorOwnership
  interactionReady: boolean
  busy: boolean
  /** Injectable system controls (PA-27); defaults to the iOS set below.
   *  Android passes back/home/recents/notifications/rotate (frozen contract
   *  §system_action). */
  actions: readonly SystemControl<A>[]
  onSystemAction: (action: A) => void
  /** Media group (screenshot / recording / saved-file feedback). Shared by
   *  iOS and Android; callers may hide it for capability-gated backends. */
  mediaControls?: boolean
  recording?: IosSimulatorRecordingState
  lastMediaFile?: IosSimulatorMediaFile
  onCaptureScreen?: () => void
  onToggleRecording?: () => void
  onDetach?: () => void
  onEnd: () => void
  onShutdownExternal?: () => void
  onRevealOutput?: (path: string) => void
}

type SystemControl<A extends string = IosSimulatorSystemAction> = {
  action: A
  label: string
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>
}

function formatElapsed(startedAtMs: number, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAtMs) / 1000))
  const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, '0')
  const seconds = (elapsedSeconds % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
}

export function SimulatorControlDock<A extends string = IosSimulatorSystemAction>({
  deviceName,
  ownership,
  interactionReady,
  busy,
  actions,
  mediaControls = true,
  recording = { state: 'idle' },
  lastMediaFile,
  onSystemAction,
  onCaptureScreen,
  onToggleRecording,
  onDetach,
  onEnd,
  onShutdownExternal,
  onRevealOutput,
}: SimulatorControlDockProps<A>) {
  const { t } = useI18n()
  const [confirmingEnd, setConfirmingEnd] = useState<'owned' | 'external' | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const endButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (recording.state !== 'recording') return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [recording.state, recording.state === 'recording' ? recording.startedAtMs : undefined])

  useEffect(() => {
    if (confirmingEnd) cancelButtonRef.current?.focus()
  }, [confirmingEnd])

  const systemControls = actions
  const recordingLabel = recording.state === 'recording'
    ? t('simulator.control.stopRecording')
    : recording.state === 'starting'
      ? t('simulator.recording.starting')
      : recording.state === 'finalizing'
        ? t('simulator.recording.finalizing')
        : t('simulator.control.startRecording')
  const recordingBusy = recording.state === 'starting' || recording.state === 'finalizing'
  const endLabel = ownership === 'verboo'
    ? t('simulator.control.end')
    : t('simulator.control.endExternal')

  const cancelEnd = () => {
    setConfirmingEnd(null)
    endButtonRef.current?.focus()
  }

  return (
    <>
      <div className="ios-simulator-control-dock" aria-label={t('simulator.controlDock')}>
        <div className="ios-simulator-control-group">
          {systemControls.map(({ action, label, icon: Icon }) => (
            <SimulatorTooltipButton
              key={action}
              label={label}
              type="button"
              className="ios-simulator-dock-button"
              aria-label={label}
              disabled={!interactionReady || busy}
              onClick={() => onSystemAction(action)}
            >
              <Icon size={16} aria-hidden />
            </SimulatorTooltipButton>
          ))}
        </div>
        {mediaControls && (
        <div className="ios-simulator-control-group">
          <SimulatorTooltipButton
            label={t('simulator.control.screenshot')}
            type="button"
            className="ios-simulator-dock-button"
            aria-label={t('simulator.control.screenshot')}
            onClick={onCaptureScreen}
          >
            <Camera size={16} aria-hidden />
          </SimulatorTooltipButton>
          <SimulatorTooltipButton
            label={recordingLabel}
            type="button"
            className="ios-simulator-dock-button"
            aria-label={recordingLabel}
            disabled={recordingBusy}
            onClick={onToggleRecording}
          >
            <Video size={16} aria-hidden />
          </SimulatorTooltipButton>
          {recording.state === 'recording' && (
            <span className="ios-simulator-recording-time" aria-live="off">
              {formatElapsed(recording.startedAtMs, now)}
            </span>
          )}
        </div>
        )}
        <div className="ios-simulator-control-group">
          {ownership === 'external' && onDetach && (
            <SimulatorTooltipButton
              label={t('simulator.control.detach')}
              type="button"
              className="ios-simulator-dock-button"
              aria-label={t('simulator.control.detach')}
              onClick={onDetach}
            >
              <Unplug size={16} aria-hidden />
            </SimulatorTooltipButton>
          )}
          <SimulatorTooltipButton
            ref={endButtonRef}
            label={endLabel}
            type="button"
            className="ios-simulator-dock-button"
            aria-label={endLabel}
            onClick={() => setConfirmingEnd(ownership === 'verboo' ? 'owned' : 'external')}
          >
            <Power size={16} aria-hidden />
          </SimulatorTooltipButton>
        </div>
      </div>

      {mediaControls && (recording.state === 'starting' || recording.state === 'finalizing') && (
        <div className="ios-simulator-recording-status" role="status" aria-live="polite">
          {recording.state === 'starting' ? t('simulator.recording.starting') : t('simulator.recording.finalizing')}
        </div>
      )}

      {mediaControls && lastMediaFile && (
        <div className="ios-simulator-media-feedback" role="status" aria-live="polite">
          <span>{t('simulator.media.saved', { fileName: lastMediaFile.fileName })}</span>
          {onRevealOutput && (
            <button
              type="button"
              className="ghost-button"
              onClick={() => onRevealOutput(lastMediaFile.path)}
            >
              {t('simulator.media.reveal')}
            </button>
          )}
        </div>
      )}

      {confirmingEnd && (
        <div
          className="ios-simulator-end-confirmation"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ios-simulator-end-title"
          onKeyDown={event => {
            if (event.key === 'Escape') cancelEnd()
          }}
        >
          <strong id="ios-simulator-end-title">
            {t(confirmingEnd === 'external' ? 'simulator.endExternal.title' : 'simulator.end.title', { name: deviceName })}
          </strong>
          <p>{t(confirmingEnd === 'external' ? 'simulator.endExternal.body' : 'simulator.end.body')}</p>
          <div>
            <button ref={cancelButtonRef} type="button" className="ghost-button" onClick={cancelEnd}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                const action = confirmingEnd
                setConfirmingEnd(null)
                if (action === 'external') onShutdownExternal?.()
                else onEnd()
              }}
            >
              {t(confirmingEnd === 'external' ? 'simulator.endExternal.confirm' : 'simulator.end.confirm')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
