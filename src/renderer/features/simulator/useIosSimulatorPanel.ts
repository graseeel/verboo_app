import { useCallback, useEffect, useRef, useState } from 'react'
import { iosSimulatorApi } from './iosSimulatorApi'
import type {
  IosSimulatorAnnotationCapture,
  IosSimulatorAccessibilityNode,
  IosSimulatorElementHit,
  IosSimulatorFallbackFps,
  IosSimulatorFrame,
  IosSimulatorKey,
  IosSimulatorLifecycleSnapshot,
  IosSimulatorMediaFile,
  IosSimulatorPoint,
  IosSimulatorPresenceEvent,
  IosSimulatorRect,
  IosSimulatorRequirements,
  IosSimulatorStreamFps,
  IosSimulatorStreamSource,
} from './iosSimulatorApi'
import {
  DEFAULT_SIMULATOR_FALLBACK_FPS,
  DEFAULT_SIMULATOR_STREAM_FPS,
  IOS_SIMULATOR_FALLBACK_RATES,
  IOS_SIMULATOR_STREAM_RATES,
} from './iosSimulatorModel'
import { LatestFrameCoalescer } from './frameCoalescer'

const TELEMETRY_INTERVAL_MS = 500
const AGENT_PRESENCE_CLEAR_GRACE_MS = 900
const FRAME_COMMIT_FALLBACK_MS = 16

const IDLE_LIFECYCLE: IosSimulatorLifecycleSnapshot = {
  udid: null,
  deviceGeneration: null,
  stage: 'idle',
  ownership: null,
  previewSuspended: false,
  interactionReady: false,
  recording: { state: 'idle' },
  recoverableError: null,
}

export function useIosSimulatorPanel() {
  const [simulatorOpen, setSimulatorOpen] = useState(false)
  const [requirements, setRequirements] = useState<IosSimulatorRequirements | undefined>()
  const [requirementsLoading, setRequirementsLoading] = useState(false)
  const [lifecycle, setLifecycle] = useState<IosSimulatorLifecycleSnapshot>(IDLE_LIFECYCLE)
  const [frameDataUrl, setFrameDataUrl] = useState<string | undefined>()
  const [frameGeneration, setFrameGeneration] = useState<number | undefined>()
  const [streamSource, setStreamSource] = useState<IosSimulatorStreamSource | undefined>()
  const [effectiveFps, setEffectiveFps] = useState<number | undefined>()
  const [streamFps, setStreamFps] = useState<IosSimulatorStreamFps>(DEFAULT_SIMULATOR_STREAM_FPS)
  const [fallbackFps, setFallbackFps] = useState<IosSimulatorFallbackFps>(DEFAULT_SIMULATOR_FALLBACK_FPS)
  const [busyUdid, setBusyUdid] = useState<string | undefined>()
  // Errors from user-triggered actions must stay on screen until the next
  // action attempt; only stream errors pushed by the backend may auto-clear
  // when MJPEG frames resume. A single wiped channel hid dock failures behind
  // the 29 fps stream (field defect D1).
  const [actionError, setActionError] = useState<string | undefined>()
  const [streamError, setStreamError] = useState<string | undefined>()
  const [agentPresence, setAgentPresence] = useState<IosSimulatorPresenceEvent | undefined>()
  const [agentOpenRequest, setAgentOpenRequest] = useState(0)
  const [lastMediaFile, setLastMediaFile] = useState<IosSimulatorMediaFile | undefined>()
  const lifecycleRef = useRef<IosSimulatorLifecycleSnapshot>(IDLE_LIFECYCLE)
  const frameCoalescerRef = useRef<LatestFrameCoalescer<IosSimulatorFrame> | undefined>(undefined)
  const hasPublishedFrameRef = useRef(false)
  const telemetryRef = useRef<{ at: number; source?: IosSimulatorStreamSource }>({ at: 0 })
  const latestPresenceGenerationRef = useRef(0)
  const activePresenceGenerationRef = useRef<number | undefined>(undefined)
  const presenceClearTimerRef = useRef<number | undefined>(undefined)

  const clearLocalPresence = useCallback(() => {
    if (presenceClearTimerRef.current !== undefined) {
      window.clearTimeout(presenceClearTimerRef.current)
      presenceClearTimerRef.current = undefined
    }
    activePresenceGenerationRef.current = undefined
    setAgentPresence(undefined)
  }, [])

  const showAgentPresence = useCallback((presence: IosSimulatorPresenceEvent) => {
    if (activePresenceGenerationRef.current === presence.generation) return
    if (presence.generation <= latestPresenceGenerationRef.current) return
    if (presenceClearTimerRef.current !== undefined) {
      window.clearTimeout(presenceClearTimerRef.current)
      presenceClearTimerRef.current = undefined
    }
    latestPresenceGenerationRef.current = presence.generation
    activePresenceGenerationRef.current = presence.generation
    setAgentPresence(presence)
  }, [])

  const scheduleAgentPresenceClear = useCallback((generation?: number) => {
    const owner = generation ?? activePresenceGenerationRef.current
    if (owner === undefined || activePresenceGenerationRef.current !== owner) return
    if (presenceClearTimerRef.current !== undefined) return
    presenceClearTimerRef.current = window.setTimeout(() => {
      if (activePresenceGenerationRef.current !== owner) return
      activePresenceGenerationRef.current = undefined
      presenceClearTimerRef.current = undefined
      setAgentPresence(undefined)
    }, AGENT_PRESENCE_CLEAR_GRACE_MS)
  }, [])

  const handleAgentPresence = useCallback((presence: IosSimulatorPresenceEvent | null) => {
    if (presence?.phase === 'start') {
      showAgentPresence(presence)
      return
    }
    scheduleAgentPresenceClear(presence?.generation)
  }, [scheduleAgentPresenceClear, showAgentPresence])

  const disposeFrameCoalescer = useCallback(() => {
    frameCoalescerRef.current?.dispose()
    frameCoalescerRef.current = undefined
  }, [])

  const applyLifecycle = useCallback((snapshot: IosSimulatorLifecycleSnapshot) => {
    const previous = lifecycleRef.current
    const generationChanged = previous.udid !== snapshot.udid
      || previous.deviceGeneration !== snapshot.deviceGeneration
    lifecycleRef.current = snapshot
    setLifecycle(snapshot)
    if (generationChanged && (previous.deviceGeneration !== null || snapshot.deviceGeneration !== null)) {
      disposeFrameCoalescer()
      hasPublishedFrameRef.current = false
      setFrameDataUrl(undefined)
      setFrameGeneration(undefined)
      telemetryRef.current = { at: 0 }
    }
    if (!snapshot.udid) {
      // End-of-session event (backend R1-B1: stop_session clears the
      // authority and emits the idle snapshot). This event path is the single
      // source for tearing down session-scoped state: presence, stream
      // identity, stream errors, output feedback, and the requirements
      // attachment.
      clearLocalPresence()
      setStreamSource(undefined)
      setEffectiveFps(undefined)
      setStreamError(undefined)
      setLastMediaFile(undefined)
      setRequirements(current => current ? {
        ...current,
        attachedUdid: null,
        streamFps: null,
        fallbackFps: null,
        source: null,
        effectiveFps: null,
      } : current)
    }
  }, [clearLocalPresence, disposeFrameCoalescer])

  const refresh = useCallback(async () => {
    setRequirementsLoading(true)
    setActionError(undefined)
    setStreamError(undefined)
    try {
      const next = await iosSimulatorApi.requirements()
      setRequirements(next)
      setStreamFps(next.streamFps ?? DEFAULT_SIMULATOR_STREAM_FPS)
      setFallbackFps(next.fallbackFps ?? DEFAULT_SIMULATOR_FALLBACK_FPS)
      if (next.attachedUdid) {
        setStreamSource(next.source ?? 'simctl')
        setEffectiveFps(next.effectiveFps ?? undefined)
      } else {
        setStreamSource(undefined)
        setEffectiveFps(undefined)
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRequirementsLoading(false)
    }
  }, [])

  const open = useCallback(async () => {
    setSimulatorOpen(true)
    try {
      await iosSimulatorApi.setVisible(true)
      await refresh()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [refresh])

  const detach = useCallback(async () => {
    setActionError(undefined)
    try {
      await iosSimulatorApi.detach()
      // Session teardown arrives as the end-of-session lifecycle event
      // (backend R1-B1); applyLifecycle is the single source for it.
    } catch (reason) {
      // Detach failed: no end-of-session event will arrive and the session
      // is likely still alive. Keep the panel state and surface the failure.
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const close = useCallback(() => {
    setSimulatorOpen(false)
    clearLocalPresence()
    disposeFrameCoalescer()
    void iosSimulatorApi.setVisible(false).catch(reason => {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [clearLocalPresence, disposeFrameCoalescer])

  const attach = useCallback(async (udid: string) => {
    setBusyUdid(udid)
    setActionError(undefined)
    try {
      const session = await iosSimulatorApi.attach(udid, streamFps, fallbackFps)
      const sameDevice = lifecycleRef.current.udid === session.device.udid
      if (!sameDevice) {
        disposeFrameCoalescer()
        hasPublishedFrameRef.current = false
        telemetryRef.current = { at: 0 }
      }
      if (!sameDevice) setFrameDataUrl(undefined)
      setStreamFps(session.streamFps)
      setFallbackFps(session.fallbackFps)
      setStreamSource(session.source)
      setEffectiveFps(session.effectiveFps ?? undefined)
      setRequirements(current => current ? {
        ...current,
        streamFps: session.streamFps,
        fallbackFps: session.fallbackFps,
        source: session.source,
        effectiveFps: session.effectiveFps,
        devices: current.devices.map(device => device.udid === session.device.udid ? session.device : device),
      } : current)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyUdid(undefined)
    }
  }, [disposeFrameCoalescer, fallbackFps, streamFps])

  const setStreamRate = useCallback(async (nextFps: IosSimulatorStreamFps) => {
    setActionError(undefined)
    if (!lifecycleRef.current.udid) {
      setStreamFps(nextFps)
      return
    }
    try {
      const applied = await iosSimulatorApi.setStreamRate(nextFps)
      setStreamFps(applied)
      setRequirements(current => current ? { ...current, streamFps: applied } : current)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const setFallbackRate = useCallback(async (nextFps: IosSimulatorFallbackFps) => {
    setActionError(undefined)
    if (!lifecycleRef.current.udid) {
      setFallbackFps(nextFps)
      return
    }
    try {
      const applied = await iosSimulatorApi.setFallbackRate(nextFps)
      setFallbackFps(applied)
      setRequirements(current => current ? { ...current, fallbackFps: applied } : current)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const tap = useCallback(async (point: IosSimulatorPoint) => {
    setActionError(undefined)
    try {
      await iosSimulatorApi.tap(point)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const drag = useCallback(async (
    from: IosSimulatorPoint,
    to: IosSimulatorPoint,
    durationMs = 180,
  ) => {
    setActionError(undefined)
    try {
      await iosSimulatorApi.drag(from, to, durationMs)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const typeText = useCallback(async (text: string) => {
    setActionError(undefined)
    try {
      await iosSimulatorApi.typeText(text)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const pressKey = useCallback(async (key: IosSimulatorKey) => {
    setActionError(undefined)
    try {
      await iosSimulatorApi.pressKey(key)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const endSimulation = useCallback(async () => {
    setActionError(undefined)
    try {
      await iosSimulatorApi.end()
      // Session teardown arrives as the end-of-session lifecycle event
      // (backend R1-B1); applyLifecycle is the single source for it.
      await refresh()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [refresh])

  const shutdownExternalSimulation = useCallback(async () => {
    setActionError(undefined)
    const snapshot = lifecycleRef.current
    if (snapshot.ownership !== 'external' || !snapshot.udid) {
      setActionError('Nenhum simulador externo está anexado.')
      return
    }
    try {
      await iosSimulatorApi.shutdownExternal(snapshot.udid)
      // The backend emits the idle lifecycle snapshot after stopping the
      // workers and before the exact external UDID is shut down.
      await refresh()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [refresh])

  const runSystemAction = useCallback(async (action: Parameters<typeof iosSimulatorApi.systemAction>[0]) => {
    setActionError(undefined)
    try {
      await iosSimulatorApi.systemAction(action)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const retryInteraction = useCallback(async () => {
    setActionError(undefined)
    try {
      await iosSimulatorApi.retryInteraction()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const captureScreen = useCallback(async () => {
    setActionError(undefined)
    try {
      const file = await iosSimulatorApi.captureScreen()
      setLastMediaFile(file)
      return file
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
      return undefined
    }
  }, [])

  const toggleRecording = useCallback(async () => {
    setActionError(undefined)
    try {
      if (lifecycleRef.current.recording.state === 'recording') {
        const file = await iosSimulatorApi.stopRecording()
        setLastMediaFile(file)
      } else if (lifecycleRef.current.recording.state === 'idle') {
        await iosSimulatorApi.startRecording()
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const revealOutput = useCallback(async (path: string) => {
    setActionError(undefined)
    try {
      await iosSimulatorApi.revealOutput(path)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const retryAttach = useCallback(async () => {
    const udid = lifecycleRef.current.udid
    if (udid) await attach(udid)
  }, [attach])

  useEffect(() => {
    let disposed = false
    const listener = iosSimulatorApi.onLifecycle(snapshot => {
      if (!disposed) applyLifecycle(snapshot)
    })
    return () => {
      disposed = true
      void listener.then(unlisten => unlisten())
    }
  }, [applyLifecycle])

  useEffect(() => {
    let disposed = false
    const presenceListener = iosSimulatorApi.onPresence(presence => {
      if (!disposed) handleAgentPresence(presence)
    })
    const openRequestedListener = iosSimulatorApi.onOpenRequested(presence => {
      if (disposed) return
      if (presence?.phase === 'start') handleAgentPresence(presence)
      setAgentOpenRequest(current => current + 1)
    })
    return () => {
      disposed = true
      if (presenceClearTimerRef.current !== undefined) {
        window.clearTimeout(presenceClearTimerRef.current)
        presenceClearTimerRef.current = undefined
      }
      void presenceListener.then(unlisten => unlisten())
      void openRequestedListener.then(unlisten => unlisten())
    }
  }, [handleAgentPresence])

  useEffect(() => {
    if (!simulatorOpen) return
    let disposed = false
    const frameListener = iosSimulatorApi.onFrame(frame => {
      const currentLifecycle = lifecycleRef.current
      if (!disposed
        && frame.udid === currentLifecycle.udid
        && frame.deviceGeneration === currentLifecycle.deviceGeneration) {
        if ('agentPresence' in frame) handleAgentPresence(frame.agentPresence ?? null)
        if (frame.dataUrl) {
          if (!hasPublishedFrameRef.current) {
            hasPublishedFrameRef.current = true
            setFrameDataUrl(frame.dataUrl)
            setFrameGeneration(frame.frameGeneration)
          } else {
            if (!frameCoalescerRef.current) {
              frameCoalescerRef.current = new LatestFrameCoalescer<IosSimulatorFrame>(
                callback => requestAnimationFrame(callback),
                requestId => cancelAnimationFrame(requestId),
                newest => {
                  setFrameDataUrl(newest.dataUrl)
                  setFrameGeneration(newest.frameGeneration)
                },
                callback => window.setTimeout(
                  () => callback(performance.now()),
                  FRAME_COMMIT_FALLBACK_MS,
                ),
                requestId => window.clearTimeout(requestId),
              )
            }
            frameCoalescerRef.current.push(frame)
          }
        }
        const now = Date.now()
        const telemetry = telemetryRef.current
        if (telemetry.source !== frame.source || now - telemetry.at >= TELEMETRY_INTERVAL_MS) {
          telemetryRef.current = { at: now, source: frame.source }
          setStreamSource(frame.source)
          setEffectiveFps(frame.effectiveFps ?? undefined)
        }
        if (frame.source === 'mjpeg') setStreamError(undefined)
      }
    })
    const errorListener = iosSimulatorApi.onError(payload => {
      if (!disposed && payload.udid === lifecycleRef.current.udid) setStreamError(payload.message)
    })
    return () => {
      disposed = true
      disposeFrameCoalescer()
      void frameListener.then(unlisten => unlisten())
      void errorListener.then(unlisten => unlisten())
    }
  }, [disposeFrameCoalescer, handleAgentPresence, simulatorOpen])

  const captureAnnotation = useCallback(async (
    rect: IosSimulatorRect,
    element: IosSimulatorAccessibilityNode | null = null,
  ): Promise<IosSimulatorAnnotationCapture | undefined> => {
    const deviceGeneration = lifecycleRef.current.deviceGeneration
    if (deviceGeneration == null) {
      setActionError('Aguardando um quadro estável do simulador.')
      return undefined
    }
    setActionError(undefined)
    try {
      return await iosSimulatorApi.captureAnnotation(
        deviceGeneration,
        rect,
        element,
      )
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
      return undefined
    }
  }, [])

  const inspectPoint = useCallback(async (
    point: IosSimulatorPoint,
  ): Promise<IosSimulatorElementHit | undefined> => {
    const deviceGeneration = lifecycleRef.current.deviceGeneration
    if (deviceGeneration == null) return undefined
    try {
      const hit = await iosSimulatorApi.inspectPoint(deviceGeneration, point)
      if (lifecycleRef.current.deviceGeneration !== deviceGeneration) return undefined
      return hit ?? undefined
    } catch {
      return undefined
    }
  }, [])

  const deleteCapture = useCallback(async (paths: string[]) => {
    try {
      await iosSimulatorApi.deleteTempFiles(paths)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const attachedUdid = lifecycle.udid ?? undefined
  const attachedDevice = attachedUdid
    ? requirements?.devices.find(device => device.udid === attachedUdid)
    : undefined
  const deviceGeneration = lifecycle.deviceGeneration ?? undefined
  const recordingActive = lifecycle.recording.state === 'recording'

  return {
    simulatorOpen,
    requirements,
    requirementsLoading,
    attachedUdid,
    attachedDevice,
    frameDataUrl,
    deviceGeneration,
    frameGeneration,
    streamSource,
    effectiveFps,
    streamFps,
    fallbackFps,
    lifecycle,
    recording: lifecycle.recording,
    recordingActive,
    lastMediaFile,
    busyUdid,
    error: actionError ?? streamError,
    agentPresence,
    agentOpenRequest,
    streamRates: IOS_SIMULATOR_STREAM_RATES,
    fallbackRates: IOS_SIMULATOR_FALLBACK_RATES,
    open,
    close,
    refresh,
    attach,
    detach,
    setStreamRate,
    setFallbackRate,
    tap,
    drag,
    typeText,
    pressKey,
    endSimulation,
    shutdownExternalSimulation,
    runSystemAction,
    retryInteraction,
    captureScreen,
    toggleRecording,
    revealOutput,
    retryAttach,
    inspectPoint,
    captureAnnotation,
    deleteCapture,
  }
}
