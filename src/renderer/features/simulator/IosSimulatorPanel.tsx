import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Bell,
  GalleryHorizontal,
  Gauge,
  Home,
  LoaderCircle,
  PanelRightClose,
  RefreshCw,
  RotateCw,
  SlidersHorizontal,
  Smartphone,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { simulatorStageMessageKey } from './iosSimulatorModel'
import { SimulatorOnboarding } from './SimulatorOnboarding'
import { SimulatorSurface } from './SimulatorSurface'
import { SimulatorDevicePicker } from './SimulatorDevicePicker'
import { SimulatorControlDock } from './SimulatorControlDock'
import { SimulatorTooltipButton } from './SimulatorTooltip'
import { AndroidEmulatorLegacyCard, AndroidOnboarding } from './AndroidOnboarding'
import { AndroidDevicePicker } from './AndroidDevicePicker'
import {
  ANDROID_EMULATOR_STREAM_RATES,
  androidDeviceDisplayLabel,
  normalizeAndroidStreamFps,
} from './androidEmulatorModel'
import type { AndroidEmulatorSystemAction } from './androidEmulatorApi'
import { useAndroidEmulatorPanel } from './useAndroidEmulatorPanel'
import {
  androidEmulatorKeyForKeyboardEvent,
  type SimulatorInteractionMode,
} from './useSimulatorInteraction'
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
import type { SimulatorPlatformRequest } from './simulatorPlatform'

type IosSimulatorPanelProps = {
  simulatorOpen: boolean
  simulatorWidth: number
  onSetWidth: (width: number) => void
  onClose: () => void
  onAndroidOpenRequested?: () => void
  platformRequest?: SimulatorPlatformRequest
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
  onRefresh: () => Promise<number | undefined>
  /** Host OS (App.tsx passes config.platform). The iOS tab exists only on
   *  darwin; the Android tab is always available (PA-25 platform tabs).
   *  Defaults to 'darwin' so pre-tabs callers keep the iOS-only shape. */
  platform?: NodeJS.Platform
  minWidth: number
  maxWidth: number
}

export function IosSimulatorPanel({
  simulatorOpen,
  simulatorWidth,
  onSetWidth,
  onClose,
  onAndroidOpenRequested,
  platformRequest,
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
  platform = 'darwin',
  minWidth,
  maxWidth,
}: IosSimulatorPanelProps) {
  const { t } = useI18n()
  const resizerRef = useRef<HTMLDivElement | null>(null)
  const [interactionMode, setInteractionMode] = useState<SimulatorInteractionMode>('interact')
  const [selectedUdid, setSelectedUdid] = useState<string | undefined>(attachedUdid)
  const [performanceOpen, setPerformanceOpen] = useState(false)
  const [refreshFeedback, setRefreshFeedback] = useState<string>()
  const android = useAndroidEmulatorPanel()
  const iosActions: Array<{
    action: IosSimulatorSystemAction
    label: string
    icon: typeof Home
  }> = [
    { action: 'home', label: t('simulator.control.home'), icon: Home },
    { action: 'appSwitcher', label: t('simulator.control.appSwitcher'), icon: GalleryHorizontal },
    { action: 'notifications', label: t('simulator.control.notifications'), icon: Bell },
    { action: 'controlCenter', label: t('simulator.control.controlCenter'), icon: SlidersHorizontal },
    { action: 'rotateClockwise', label: t('simulator.control.rotate'), icon: RotateCw },
  ]

  // ── Platform tabs (PA-25, contrato-android-simulator — frozen) ─────────
  // One panel, one tab per platform: iOS exists only on darwin; Android is
  // always offered (the SDK toolchain runs on macOS/Windows/Linux).
  const iosAvailable = platform === 'darwin'
  const [activeSimulatorPlatform, setActiveSimulatorPlatform] = useState<'ios' | 'android'>(
    iosAvailable ? 'ios' : 'android',
  )
  const androidActive = activeSimulatorPlatform === 'android'
  const androidVisibleRef = useRef(false)
  const consumedAndroidOpenRequestRef = useRef(0)

  useEffect(() => {
    if (!iosAvailable && activeSimulatorPlatform === 'ios') setActiveSimulatorPlatform('android')
  }, [iosAvailable, activeSimulatorPlatform])

  useEffect(() => {
    if (!platformRequest) return
    if (platformRequest.platform === 'ios' && !iosAvailable) return
    setActiveSimulatorPlatform(platformRequest.platform)
  }, [iosAvailable, platformRequest])

  useEffect(() => {
    const visible = simulatorOpen && androidActive
    if (visible && !androidVisibleRef.current) {
      androidVisibleRef.current = true
      void android.open()
    } else if (!visible && androidVisibleRef.current) {
      androidVisibleRef.current = false
      android.close()
    }
  }, [androidActive, android.close, android.open, simulatorOpen])

  useEffect(() => {
    const request = android.agentOpenRequest
    if (request <= consumedAndroidOpenRequestRef.current) return
    consumedAndroidOpenRequestRef.current = request
    setActiveSimulatorPlatform('android')
    onAndroidOpenRequested?.()
  }, [android.agentOpenRequest, onAndroidOpenRequested])

  useEffect(() => () => {
    if (androidVisibleRef.current) android.close()
  }, [android.close])

  const androidLoading = android.requirementsLoading || (androidActive && !android.requirements && !android.legacyBackend && !android.error)
  const activeLoading = androidActive ? androidLoading : requirementsLoading

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
  const handleRefresh = async () => {
    setRefreshFeedback(t('simulator.refreshing'))
    if (androidActive) {
      const androidCount = await android.refresh()
      if (androidCount === undefined) {
        setRefreshFeedback(undefined)
        return
      }
      setRefreshFeedback(t(
        androidCount === 1 ? 'androidEmulator.refreshed.one' : 'androidEmulator.refreshed.other',
        { count: androidCount },
      ))
      return
    }
    const deviceCount = await onRefresh()
    if (deviceCount === undefined) {
      setRefreshFeedback(undefined)
      return
    }
    setRefreshFeedback(t(
      deviceCount === 1 ? 'simulator.refreshed.one' : 'simulator.refreshed.other',
      { count: deviceCount },
    ))
  }
  const interactionFailure = lifecycle.stage === 'preparingInteraction'
    && !lifecycle.interactionReady
    && Boolean(frameDataUrl || streamUrl)
    && Boolean(lifecycle.recoverableError)
  const stageDeviceName = device?.name ?? ''

  const panelTitle = androidActive ? t('androidEmulator.title') : t('simulator.title')
  const panelSubtitle = androidActive ? t('androidEmulator.subtitle') : t('simulator.subtitle')

  return (
    <aside
      className={`ios-simulator-panel ${simulatorOpen ? '' : 'is-hidden'}`}
      style={{ width: simulatorOpen ? simulatorWidth : 0 }}
      aria-label={panelTitle}
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
            <strong>{panelTitle}</strong>
            <span role="status" aria-live="polite">
              {refreshFeedback ?? panelSubtitle}
            </span>
          </div>
        </div>
        <div className="ios-simulator-header-actions">
          <SimulatorTooltipButton
            label={t('simulator.refresh')}
            type="button"
            className="icon-button tiny"
            onClick={() => { void handleRefresh() }}
            disabled={activeLoading}
            aria-label={t('simulator.refresh')}
          >
            <RefreshCw size={14} className={activeLoading ? 'is-spinning' : ''} />
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

      {iosAvailable && (
        <div className="simulator-platform-tabs" role="tablist" aria-label={t('simulator.platformTabs')}>
          <button
            type="button"
            role="tab"
            aria-selected={!androidActive}
            className={`simulator-platform-tab ${androidActive ? '' : 'is-active'}`}
            onClick={() => setActiveSimulatorPlatform('ios')}
          >
            {t('simulator.platform.ios')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={androidActive}
            className={`simulator-platform-tab ${androidActive ? 'is-active' : ''}`}
            onClick={() => setActiveSimulatorPlatform('android')}
          >
            {t('simulator.platform.android')}
          </button>
        </div>
      )}

      {!androidActive && showDeviceList && (
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
        {!androidActive && (
        <>
        {requirementsLoading && !requirements && (
          <div className="ios-simulator-state" role="status">
            <LoaderCircle size={20} className="is-spinning" aria-hidden="true" />
            <span>{t('simulator.loading')}</span>
          </div>
        )}

        {unavailable && (
          <SimulatorOnboarding
            issue={unavailable}
            xcodeVersion={requirements?.xcodeVersion ?? undefined}
            requirementsLoading={requirementsLoading}
            onRefresh={onRefresh}
            onCheckAgain={() => { void handleRefresh() }}
          />
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
            <button
              type="button"
              className="ghost-button"
              onClick={() => { void handleRefresh() }}
              disabled={requirementsLoading}
            >
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
                        inspecting: t('simulator.annotation.inspecting'),
                        inspectionFailed: t('simulator.annotation.inspectionFailed'),
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
                    actions={iosActions}
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
        </>
        )}

        {androidActive && (
          <AndroidEmulatorTabContent
            android={android}
            platform={platform}
            loading={androidLoading}
            onCheckAgain={() => { void android.refresh() }}
            onAddAnnotation={onAddAnnotation}
          />
        )}
      </div>
    </aside>
  )
}


type AndroidPanelState = ReturnType<typeof useAndroidEmulatorPanel>

function AndroidEmulatorTabContent({
  android,
  platform,
  loading,
  onCheckAgain,
  onAddAnnotation,
}: {
  android: AndroidPanelState
  platform: NodeJS.Platform
  loading: boolean
  onCheckAgain: () => void
  onAddAnnotation: (attachment: AttachmentMeta) => void
}) {
  const { t } = useI18n()
  const [interactionMode, setInteractionMode] = useState<SimulatorInteractionMode>('interact')
  const [performanceOpen, setPerformanceOpen] = useState(false)
  const announceSource = android.previewState?.source ?? ''
  const announceDegraded = android.previewState?.degraded === true
  const [announcement, setAnnouncement] = useState('')
  const announceKeyRef = useRef('')
  const lastAnnouncedAtRef = useRef(0)
  useEffect(() => {
    android.setElementSelectionActive(interactionMode === 'select-element')
    return () => android.setElementSelectionActive(false)
  }, [android.setElementSelectionActive, interactionMode])
  useEffect(() => {
    if (!android.previewState) return
    const key = `${announceSource}:${announceDegraded ? 'd' : 'ok'}`
    if (announceKeyRef.current === key) return
    const now = Date.now()
    if (now - lastAnnouncedAtRef.current < 2000) return
    announceKeyRef.current = key
    lastAnnouncedAtRef.current = now
    setAnnouncement(
      announceDegraded
        ? t('androidEmulator.stream.degraded')
        : announceSource === 'grpc'
          ? t('androidEmulator.stream.grpc')
          : t('androidEmulator.stream.adb'),
    )
  }, [android.previewState, announceDegraded, announceSource, t])
  const { requirements } = android
  if (android.legacyBackend) {
    return (
      <AndroidEmulatorLegacyCard
        platform={platform}
        requirementsLoading={loading}
        onCheckAgain={onCheckAgain}
      />
    )
  }
  if (!requirements && android.error) {
    return (
      <div className="ios-simulator-error" role="alert">
        <span>{android.error}</span>
        <button
          type="button"
          className="ghost-button"
          onClick={onCheckAgain}
          disabled={loading}
        >
          {t('simulator.refresh')}
        </button>
      </div>
    )
  }
  if (!requirements) {
    return (
      <div className="ios-simulator-state" role="status">
        <LoaderCircle size={20} className="is-spinning" aria-hidden="true" />
        <span>{t('androidEmulator.loading')}</span>
      </div>
    )
  }
  if (requirements.issue) {
    return (
      <AndroidOnboarding
        issue={requirements.issue}
        platform={platform}
        requirementsLoading={loading}
        onRefresh={android.refresh}
        onCheckAgain={onCheckAgain}
      />
    )
  }
  if (!requirements.ready || requirements.devices.length === 0) {
    return (
      <div className="ios-simulator-state" role="status">
        <Smartphone size={22} aria-hidden="true" />
        <span>{t('androidEmulator.noDevices')}</span>
      </div>
    )
  }
  const presentationSession = android.session ?? android.exitingSession
  const presentationAvd = android.busyAvd ?? android.exitingAvd
  const bootDevice = presentationAvd
    ? requirements.devices.find(item => item.avdName === presentationAvd)
    : undefined
  const device = bootDevice ?? presentationSession?.device
  const deviceName = device ? androidDeviceDisplayLabel(device) : ''
  const ready = Boolean(android.session && android.lifecycle.stage === 'ready' && !android.shuttingDown)
  const stageCopy = android.shuttingDown
    ? t('androidEmulator.stage.shuttingDown', { name: deviceName })
    : t(simulatorStageMessageKey(android.lifecycle.stage), { name: deviceName })
  const actions: Array<{
    action: AndroidEmulatorSystemAction
    label: string
    icon: typeof Home
  }> = [
    { action: 'back', label: t('androidEmulator.control.back'), icon: ArrowLeft },
    { action: 'home', label: t('simulator.control.home'), icon: Home },
    { action: 'recents', label: t('androidEmulator.control.recents'), icon: GalleryHorizontal },
    { action: 'notifications', label: t('simulator.control.notifications'), icon: Bell },
    { action: 'rotate', label: t('simulator.control.rotate'), icon: RotateCw },
  ]
  const previewSourceLabel = android.previewState?.source === 'grpc'
    ? t('androidEmulator.stream.grpc')
    : t('androidEmulator.stream.adb')
  const showEffectiveStreamRate = android.previewState?.source === 'adbFallback'
  return (
    <>
      <div className="ios-simulator-device-bar">
        <AndroidDevicePicker
          devices={requirements.devices}
          selectedAvd={device?.avdName}
          busyAvd={android.busyAvd ?? (android.shuttingDown ? device?.avdName : undefined)}
          compact
          onSelect={avdName => { void android.attach(avdName) }}
        />
        <div className="ios-simulator-device-status">
          <span role="status" aria-live="polite">
            {device ? stageCopy : t('simulator.stage.idle')}
          </span>
          {presentationSession?.ownership && (
            <span className={`ios-simulator-origin is-${presentationSession.ownership}`}>
              {t(`simulator.origin.${presentationSession.ownership}`)}
            </span>
          )}
        </div>
      </div>

      {android.error && (
        <div className="ios-simulator-error" role="alert">
          <span>{android.error}</span>
        </div>
      )}

      {announcement !== '' && (<span role="status">{announcement}</span>)}

      {!device && (
        <div className="ios-simulator-empty">
          <Smartphone size={28} aria-hidden="true" />
          <strong>{t('androidEmulator.empty.title')}</strong>
          <p>{t('androidEmulator.empty.body')}</p>
        </div>
      )}

      {device && (
        <section
          className={`ios-simulator-view android-emulator-view ${android.shutdownPhase === 'leaving' ? 'is-leaving' : ''}`}
          aria-label={t('simulator.previewLabel', { name: deviceName })}
          aria-busy={!ready}
        >
          <div className="ios-simulator-frame">
            {android.shuttingDown ? (
              <div className="ios-simulator-frame-placeholder android-emulator-shutdown-state" role="status" aria-live="polite">
                <LoaderCircle size={20} className="is-spinning" aria-hidden="true" />
                <span>{stageCopy}</span>
              </div>
            ) : !ready ? (
              <div className="ios-simulator-frame-placeholder">
                <div className="android-emulator-boot-status" role="status" aria-live="polite">
                  <LoaderCircle size={20} className="is-spinning" aria-hidden="true" />
                  <span>{stageCopy}</span>
                </div>
                <button
                  type="button"
                  className="ghost-button android-emulator-boot-cancel"
                  onClick={() => { void android.detach() }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : android.previewMode === 'vaf1' ? (
              <SimulatorSurface
                canvasMedia={{
                  // O stream abre em 720x1600 (portrait); o primeiro receipt
                  // assume com as dims reais, inclusive 1600x720 landscape.
                  width: android.canvasSize?.width ?? 720,
                  height: android.canvasSize?.height ?? 1600,
                  onPushReady: android.bindPreviewCanvas,
                  onTerminalFailure: android.onWebglTerminalFailure,
                }}
                deviceName={deviceName}
                previewAlt={t('simulator.previewAlt', { name: deviceName })}
                mode={interactionMode}
                interactive={android.interactionReady}
                keyMapper={androidEmulatorKeyForKeyboardEvent}
                labels={{
                  interact: t('simulator.mode.interact'),
                  selectElement: t('simulator.mode.selectElement'),
                  selectArea: t('simulator.mode.selectArea'),
                  interaction: t('simulator.interactionLabel', { name: deviceName }),
                  keyboardHint: t('simulator.keyboardHint'),
                  unavailable: t('simulator.interactionUnavailable'),
                  note: t('simulator.annotation.note'),
                  notePlaceholder: t('simulator.annotation.notePlaceholder'),
                  addToChat: t('simulator.annotation.addToChat'),
                  cancel: t('common.cancel'),
                  capturing: t('simulator.annotation.capturing'),
                  inspecting: t('simulator.annotation.inspecting'),
                  inspectionFailed: t('simulator.annotation.inspectionFailed'),
                  selectionTooSmall: t('simulator.annotation.selectionTooSmall'),
                  elementUnavailable: t('simulator.annotation.elementUnavailable'),
                  agentActive: t('simulator.agentActive'),
                  agentBadge: t('simulator.agentBadge'),
                }}
                annotationContext={{
                  platform: 'Android',
                  version: `API ${device.apiLevel}`,
                  selectionImage: 'viewport',
                }}
                onModeChange={setInteractionMode}
                onTap={android.tap}
                onDrag={android.drag}
                onTypeText={android.typeText}
                onPressKey={android.pressKey}
                onInspectPoint={android.inspectPoint}
                onCaptureAnnotation={(_kind, rect, element) => android.captureAnnotation(rect, element)}
                onDeleteCapture={android.deleteCapture}
                onAddAnnotation={onAddAnnotation}
                agentPresence={android.agentPresence}
              />
            ) : android.frameDataUrl ? (
              <SimulatorSurface
                frameDataUrl={android.frameDataUrl}
                deviceName={deviceName}
                previewAlt={t('simulator.previewAlt', { name: deviceName })}
                mode={interactionMode}
                interactive={android.interactionReady}
                keyMapper={androidEmulatorKeyForKeyboardEvent}
                labels={{
                  interact: t('simulator.mode.interact'),
                  selectElement: t('simulator.mode.selectElement'),
                  selectArea: t('simulator.mode.selectArea'),
                  interaction: t('simulator.interactionLabel', { name: deviceName }),
                  keyboardHint: t('simulator.keyboardHint'),
                  unavailable: t('simulator.interactionUnavailable'),
                  note: t('simulator.annotation.note'),
                  notePlaceholder: t('simulator.annotation.notePlaceholder'),
                  addToChat: t('simulator.annotation.addToChat'),
                  cancel: t('common.cancel'),
                  capturing: t('simulator.annotation.capturing'),
                  inspecting: t('simulator.annotation.inspecting'),
                  inspectionFailed: t('simulator.annotation.inspectionFailed'),
                  selectionTooSmall: t('simulator.annotation.selectionTooSmall'),
                  elementUnavailable: t('simulator.annotation.elementUnavailable'),
                  agentActive: t('simulator.agentActive'),
                  agentBadge: t('simulator.agentBadge'),
                }}
                annotationContext={{
                  platform: 'Android',
                  version: `API ${device.apiLevel}`,
                  selectionImage: 'viewport',
                }}
                onModeChange={setInteractionMode}
                onTap={android.tap}
                onDrag={android.drag}
                onTypeText={android.typeText}
                onPressKey={android.pressKey}
                onInspectPoint={android.inspectPoint}
                onCaptureAnnotation={(_kind, rect, element) => android.captureAnnotation(rect, element)}
                onDeleteCapture={android.deleteCapture}
                onAddAnnotation={onAddAnnotation}
                agentPresence={android.agentPresence}
              />
            ) : (
              <div className="ios-simulator-frame-placeholder" role="status">
                <LoaderCircle size={20} className="is-spinning" aria-hidden="true" />
                <span>{t('simulator.waitingForFrame')}</span>
              </div>
            )}
          </div>
          {ready && (
            <>
              <SimulatorControlDock
                deviceName={deviceName}
                ownership={android.session!.ownership}
                interactionReady={android.interactionReady}
                busy={Boolean(android.busyAvd)}
                actions={actions}
                recording={android.recording}
                lastMediaFile={android.lastMediaFile}
                onSystemAction={android.runSystemAction}
                onCaptureScreen={android.captureScreen}
                onToggleRecording={android.toggleRecording}
                onDetach={android.detach}
                onEnd={android.endSimulation}
                onShutdownExternal={android.endSimulation}
              />
              <div className="ios-simulator-stream-bar">
                <div className="ios-simulator-stream-status">
                  <span className="ios-simulator-stream-source">
                    {showEffectiveStreamRate
                      ? t('androidEmulator.stream.effectiveRate', {
                        fps: android.fallbackFps,
                        source: previewSourceLabel,
                      })
                      : previewSourceLabel}
                  </span>
                  {!showEffectiveStreamRate && (
                    <span>{normalizeAndroidStreamFps(android.streamFps)} fps</span>
                  )}
                  {(() => {
                    const state = android.previewState
                    if (!state) return null
                    const showReason = state.degraded || state.source === 'adbFallback'
                    return showReason && state.reason ? (
                      <span className="ios-simulator-origin is-external">
                        {t(`androidEmulator.stream.fallbackReason.${state.reason}`)}
                      </span>
                    ) : null
                  })()}
                </div>
                <span
                  data-testid="actual-paint-fps"
                  aria-hidden="true"
                  hidden={showEffectiveStreamRate}
                  ref={android.bindActualFpsNode}
                />
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
              {android.captureFailure === 'pngMetaUnavailable' && (
                <div className="ios-simulator-error" role="alert">
                  <span>{t('androidEmulator.annotation.captureUnavailable')}</span>
                </div>
              )}
              {android.fpsSyncError !== undefined && (
                <div className="ios-simulator-error" role="alert">
                  <span>{t(`androidEmulator.stream.fpsSync.${android.fpsSyncError}`)}</span>
                </div>
              )}
              {performanceOpen && (
                <div className="ios-simulator-performance-settings">
                  <label className="ios-simulator-rate">
                    <span>{t('simulator.streamRate')}</span>
                    <select
                      value={normalizeAndroidStreamFps(android.streamFps)}
                      onChange={event => { void android.setStreamRate(Number(event.target.value)) }}
                      disabled={android.fpsSyncError === 'persistFailed'
                        || android.fpsSyncError === 'rollbackFailed'}
                    >
                      {ANDROID_EMULATOR_STREAM_RATES.map(rate => (
                        <option key={rate} value={rate}>{rate} fps</option>
                      ))}
                    </select>
                  </label>
                  <p className="ios-simulator-disclaimer">{t('androidEmulator.disclaimer')}</p>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </>
  )
}
