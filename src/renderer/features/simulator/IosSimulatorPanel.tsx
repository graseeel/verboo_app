import { useEffect, useRef, useState } from 'react'
import { Gauge, LoaderCircle, PanelRightClose, RefreshCw, Smartphone } from 'lucide-react'
import { useI18n } from '../../i18n'
import { simulatorIssueMessageKey, simulatorStageMessageKey } from './iosSimulatorModel'
import { SimulatorSurface } from './SimulatorSurface'
import { SimulatorDevicePicker } from './SimulatorDevicePicker'
import { SimulatorControlDock } from './SimulatorControlDock'
import { SimulatorTooltipButton } from './SimulatorTooltip'
import type { SimulatorInteractionMode } from './useSimulatorInteraction'
import type {
  IosSimulatorAnnotationCapture,
  IosSimulatorAccessibilityNode,
  IosSimulatorDevice,
  IosSimulatorElementHit,
  IosSimulatorFallbackFps,
  IosSimulatorKey,
  IosSimulatorLifecycleSnapshot,
  IosSimulatorMediaFile,
  IosSimulatorPoint,
  IosSimulatorPresenceEvent,
  IosSimulatorRect,
  IosSimulatorRequirements,
  IosSimulatorStreamFps,
  IosSimulatorStreamSource,
  IosSimulatorSystemAction,
} from './iosSimulatorApi'
import type { AttachmentMeta } from '../../../shared/types'

type IosSimulatorPanelProps = {
  simulatorOpen: boolean
  simulatorWidth: number
  onSetWidth: (width: number) => void
  onClose: () => void
  requirements?: IosSimulatorRequirements
  requirementsLoading: boolean
  attachedUdid?: string
  attachedDevice?: IosSimulatorDevice
  frameDataUrl?: string
  streamUrl?: string
  streamSource?: IosSimulatorStreamSource
  effectiveFps?: number
  streamFps: IosSimulatorStreamFps
  streamRates: readonly IosSimulatorStreamFps[]
  fallbackFps: IosSimulatorFallbackFps
  fallbackRates: readonly IosSimulatorFallbackFps[]
  busyUdid?: string
  error?: string
  onAttach: (udid: string) => void
  onDetach: () => void
  lifecycle: IosSimulatorLifecycleSnapshot
  lastMediaFile?: IosSimulatorMediaFile
  onEndSimulation: () => void
  onShutdownExternalSimulation: () => void
  onSystemAction: (action: IosSimulatorSystemAction) => void
  onCaptureScreen: () => void
  onToggleRecording: () => void
  onRetryAttach: () => void
  onRetryInteraction: () => void
  onRevealOutput: (path: string) => void
  onSetStreamRate: (fps: IosSimulatorStreamFps) => void
  onSetFallbackRate: (fps: IosSimulatorFallbackFps) => void
  onTap: (point: IosSimulatorPoint) => void
  onDrag: (from: IosSimulatorPoint, to: IosSimulatorPoint, durationMs: number) => void
  onTypeText: (text: string) => void
  onPressKey: (key: IosSimulatorKey) => void
  onInspectPoint: (
    point: IosSimulatorPoint,
    exact?: boolean,
  ) => Promise<IosSimulatorElementHit | undefined>
  onCaptureAnnotation: (
    kind: 'element' | 'area',
    rect: IosSimulatorRect,
    element?: IosSimulatorAccessibilityNode | null,
  ) => Promise<IosSimulatorAnnotationCapture | undefined>
  onDeleteCapture: (paths: string[]) => Promise<void>
  onAddAnnotation: (attachment: AttachmentMeta) => void
  agentPresence?: IosSimulatorPresenceEvent
  onRefresh: () => void
  minWidth: number
  maxWidth: number
}

export function IosSimulatorPanel({
  simulatorOpen,
  simulatorWidth,
  onSetWidth,
  onClose,
  requirements,
  requirementsLoading,
  attachedUdid,
  attachedDevice,
  frameDataUrl,
  streamUrl,
  streamSource,
  effectiveFps,
  streamFps,
  streamRates,
  fallbackFps,
  fallbackRates,
  busyUdid,
  error,
  onAttach,
  onDetach,
  lifecycle,
  lastMediaFile,
  onEndSimulation,
  onShutdownExternalSimulation,
  onSystemAction,
  onCaptureScreen,
  onToggleRecording,
  onRetryAttach,
  onRetryInteraction,
  onRevealOutput,
  onSetStreamRate,
  onSetFallbackRate,
  onTap,
  onDrag,
  onTypeText,
  onPressKey,
  onInspectPoint,
  onCaptureAnnotation,
  onDeleteCapture,
  onAddAnnotation,
  agentPresence,
  onRefresh,
  minWidth,
  maxWidth,
}: IosSimulatorPanelProps) {
  const { t } = useI18n()
  const resizerRef = useRef<HTMLDivElement | null>(null)
  const [interactionMode, setInteractionMode] = useState<SimulatorInteractionMode>('interact')
  const [selectedUdid, setSelectedUdid] = useState<string | undefined>(attachedUdid)
  const [performanceOpen, setPerformanceOpen] = useState(false)

  useEffect(() => {
    if (attachedUdid) setSelectedUdid(attachedUdid)
  }, [attachedUdid])

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = simulatorWidth
    const move = (moveEvent: PointerEvent) => {
      onSetWidth(Math.max(minWidth, Math.min(maxWidth, startWidth + startX - moveEvent.clientX)))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      resizerRef.current?.releasePointerCapture(event.pointerId)
    }
    resizerRef.current?.setPointerCapture(event.pointerId)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
  }

  const device = attachedDevice ?? requirements?.devices.find(item => item.udid === attachedUdid)
  const unavailable = requirements?.issue
  const showDeviceList = Boolean(requirements?.ready && requirements.devices.length > 0)
  const handleDeviceSelect = (udid: string) => {
    setSelectedUdid(udid)
    if (udid !== attachedUdid) onAttach(udid)
  }
  const interactionFailure = lifecycle.stage === 'preparingInteraction'
    && !lifecycle.interactionReady
    && Boolean(frameDataUrl || streamUrl)
    && Boolean(lifecycle.recoverableError)
  const stageDeviceName = device?.name ?? ''

  return (
    <aside
      className={`ios-simulator-panel ${simulatorOpen ? '' : 'is-hidden'}`}
      style={{ width: simulatorOpen ? simulatorWidth : 0 }}
      aria-label={t('simulator.title')}
    >
      <div
        className="ios-simulator-resizer"
        ref={resizerRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('simulator.resize')}
        onPointerDown={startResize}
      />
      <header className="ios-simulator-header">
        <div className="ios-simulator-heading">
          <Smartphone size={16} aria-hidden="true" />
          <div>
            <strong>{t('simulator.title')}</strong>
            <span>{t('simulator.subtitle')}</span>
          </div>
        </div>
        <div className="ios-simulator-header-actions">
          <SimulatorTooltipButton
            label={t('simulator.refresh')}
            type="button"
            className="icon-button tiny"
            onClick={onRefresh}
            disabled={requirementsLoading}
            aria-label={t('simulator.refresh')}
          >
            <RefreshCw size={14} className={requirementsLoading ? 'is-spinning' : ''} />
          </SimulatorTooltipButton>
          <SimulatorTooltipButton
            label={t('topbar.hideSimulator')}
            type="button"
            className="icon-button tiny"
            onClick={onClose}
            aria-label={t('topbar.hideSimulator')}
          >
            <PanelRightClose size={15} />
          </SimulatorTooltipButton>
        </div>
      </header>

      {showDeviceList && (
        <div className="ios-simulator-device-bar">
          <SimulatorDevicePicker
            devices={requirements?.devices ?? []}
            selectedUdid={selectedUdid ?? attachedUdid}
            busyUdid={busyUdid}
            compact
            onSelect={handleDeviceSelect}
          />
          <div className="ios-simulator-device-status">
            <span role="status" aria-live="polite">
              {t(simulatorStageMessageKey(lifecycle.stage), { name: stageDeviceName })}
            </span>
            {lifecycle.ownership && (
              <span className={`ios-simulator-origin is-${lifecycle.ownership}`}>
                {t(`simulator.origin.${lifecycle.ownership}`)}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="ios-simulator-content">
        {requirementsLoading && !requirements && (
          <div className="ios-simulator-state" role="status">
            <LoaderCircle size={20} className="is-spinning" aria-hidden="true" />
            <span>{t('simulator.loading')}</span>
          </div>
        )}

        {unavailable && (
          <div className="ios-simulator-requirement" role="alert">
            <Smartphone size={24} aria-hidden="true" />
            <strong>{t('simulator.requirements.title')}</strong>
            <p>{t(simulatorIssueMessageKey(unavailable), { version: requirements?.xcodeVersion ?? '' })}</p>
            <button type="button" className="ghost-button" onClick={onRefresh}>
              {t('simulator.refresh')}
            </button>
          </div>
        )}

        {!unavailable && requirements && !showDeviceList && (
          <div className="ios-simulator-state" role="status">
            <Smartphone size={22} aria-hidden="true" />
            <span>{t('simulator.noDevices')}</span>
          </div>
        )}

        {error && (
          <div className="ios-simulator-error" role="alert">
            <span>{error}</span>
            <button type="button" className="ghost-button" onClick={onRefresh}>
              {t('simulator.refresh')}
            </button>
          </div>
        )}

        {!unavailable && lifecycle.recoverableError && (
          <div className="ios-simulator-error" role="alert">
            <span>{lifecycle.recoverableError}</span>
            <button
              type="button"
              className="ghost-button"
              onClick={interactionFailure ? onRetryInteraction : onRetryAttach}
            >
              {t(interactionFailure ? 'simulator.retryInteraction' : 'simulator.retry')}
            </button>
          </div>
        )}

        {showDeviceList && (
          <>
            {!attachedUdid && (
              <div className="ios-simulator-empty">
                <Smartphone size={28} aria-hidden="true" />
                <strong>{t('simulator.empty.title')}</strong>
                <p>{t('simulator.empty.body')}</p>
              </div>
            )}

            {attachedUdid && device && (
              <section className="ios-simulator-view" aria-label={t('simulator.previewLabel', { name: device.name })}>
                <div className="ios-simulator-frame">
                  {frameDataUrl || streamUrl ? (
                    <SimulatorSurface
                      frameDataUrl={frameDataUrl}
                      streamUrl={streamUrl}
                      deviceName={device.name}
                      previewAlt={t('simulator.previewAlt', { name: device.name })}
                      mode={interactionMode}
                      interactive={lifecycle.interactionReady && streamSource === 'mjpeg'}
                      labels={{
                        interact: t('simulator.mode.interact'),
                        selectElement: t('simulator.mode.selectElement'),
                        selectArea: t('simulator.mode.selectArea'),
                        interaction: t('simulator.interactionLabel', { name: device.name }),
                        keyboardHint: t('simulator.keyboardHint'),
                        unavailable: t('simulator.interactionUnavailable'),
                        note: t('simulator.annotation.note'),
                        notePlaceholder: t('simulator.annotation.notePlaceholder'),
                        addToChat: t('simulator.annotation.addToChat'),
                        cancel: t('common.cancel'),
                        capturing: t('simulator.annotation.capturing'),
                        selectionTooSmall: t('simulator.annotation.selectionTooSmall'),
                        elementUnavailable: t('simulator.annotation.elementUnavailable'),
                        agentActive: t('simulator.agentActive'),
                        agentBadge: t('simulator.agentBadge'),
                      }}
                      onModeChange={setInteractionMode}
                      onTap={onTap}
                      onDrag={onDrag}
                      onTypeText={onTypeText}
                      onPressKey={onPressKey}
                      onInspectPoint={onInspectPoint}
                      onCaptureAnnotation={onCaptureAnnotation}
                      onDeleteCapture={onDeleteCapture}
                      onAddAnnotation={onAddAnnotation}
                      agentPresence={agentPresence}
                    />
                  ) : (
                    <div className="ios-simulator-frame-placeholder" role="status">
                      <LoaderCircle size={20} className="is-spinning" aria-hidden="true" />
                      <span>{t('simulator.waitingForFrame')}</span>
                    </div>
                  )}
                </div>
                {lifecycle.ownership && (
                  <SimulatorControlDock
                    deviceName={device.name}
                    ownership={lifecycle.ownership}
                    interactionReady={lifecycle.interactionReady}
                    busy={Boolean(busyUdid)}
                    recording={lifecycle.recording}
                    lastMediaFile={lastMediaFile}
                    onSystemAction={onSystemAction}
                    onCaptureScreen={onCaptureScreen}
                    onToggleRecording={onToggleRecording}
                    onDetach={onDetach}
                    onEnd={onEndSimulation}
                    onShutdownExternal={onShutdownExternalSimulation}
                    onRevealOutput={onRevealOutput}
                  />
                )}
                <div className="ios-simulator-stream-bar">
                  <div className="ios-simulator-stream-status" role="status" aria-live="polite">
                    <span className="ios-simulator-stream-source">
                      {streamSource === 'mjpeg' ? t('simulator.stream.mjpeg') : t('simulator.stream.simctl')}
                    </span>
                    <span>
                      {effectiveFps != null
                        ? t('simulator.effectiveRate', { fps: effectiveFps.toFixed(1) })
                        : t('simulator.measuringRate')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ios-simulator-performance-toggle"
                    aria-expanded={performanceOpen}
                    onClick={() => setPerformanceOpen(current => !current)}
                  >
                    <Gauge size={13} aria-hidden="true" />
                    {t('simulator.performance')}
                  </button>
                </div>
                {performanceOpen && (
                  <div className="ios-simulator-performance-settings">
                    <label className="ios-simulator-rate">
                      <span>{t('simulator.streamRate')}</span>
                      <select
                        value={streamFps}
                        onChange={event => onSetStreamRate(Number(event.target.value) as IosSimulatorStreamFps)}
                      >
                        {streamRates.map(rate => <option key={rate} value={rate}>{rate} fps</option>)}
                      </select>
                    </label>
                    {streamFps === 60 && (
                      <p className="ios-simulator-performance-note" role="note">
                        {t('simulator.highFluencyWarning')}
                      </p>
                    )}
                    <label className="ios-simulator-rate">
                      <span>{t('simulator.fallbackRate')}</span>
                      <select
                        value={fallbackFps}
                        onChange={event => onSetFallbackRate(Number(event.target.value) as IosSimulatorFallbackFps)}
                      >
                        {fallbackRates.map(rate => <option key={rate} value={rate}>{rate} fps</option>)}
                      </select>
                    </label>
                    <p className="ios-simulator-disclaimer">{t('simulator.disclaimer')}</p>
                  </div>
                )}
              </section>
            )}

          </>
        )}
      </div>
    </aside>
  )
}
