import { useCallback, useEffect, useRef, useState } from 'react'
import { androidEmulatorApi } from './androidEmulatorApi'
import type {
  AndroidEmulatorFrame,
  AndroidAccessibilityNode,
  AndroidEmulatorElementHit,
  AndroidEmulatorKey,
  AndroidEmulatorLifecycleEvent,
  AndroidEmulatorPoint,
  AndroidEmulatorPresenceEvent,
  AndroidEmulatorRequirements,
  AndroidEmulatorSession,
  AndroidEmulatorSystemAction,
} from './androidEmulatorApi'
import type { IosSimulatorAnnotationCapture, IosSimulatorRect } from './iosSimulatorApi'
import {
  DEFAULT_ANDROID_EMULATOR_FALLBACK_FPS,
  DEFAULT_ANDROID_EMULATOR_STREAM_FPS,
  errorText,
  isUnknownCommandError,
} from './androidEmulatorModel'

const INITIAL_LIFECYCLE: AndroidEmulatorLifecycleEvent = { stage: 'booting' }
type AndroidRecordingState =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'recording'; startedAtMs: number }
  | { state: 'finalizing' }
type AndroidMediaFile = { path: string; fileName: string }

function mediaFile(path: string): AndroidMediaFile {
  return { path, fileName: path.replaceAll('\\', '/').split('/').pop() || path }
}

/** Renderer owner for the Android session. Backend events author preview
 * progress and frames; the attach response supplies the session identity used
 * to reject stale frame generations. F2 adds a11y inspection and media state. */
export function useAndroidEmulatorPanel() {
  const [requirements, setRequirements] = useState<AndroidEmulatorRequirements>()
  const [requirementsLoading, setRequirementsLoading] = useState(false)
  const [legacyBackend, setLegacyBackend] = useState(false)
  const [session, setSession] = useState<AndroidEmulatorSession>()
  const [streamFps, setStreamFps] = useState(DEFAULT_ANDROID_EMULATOR_STREAM_FPS)
  const [fallbackFps, setFallbackFps] = useState(DEFAULT_ANDROID_EMULATOR_FALLBACK_FPS)
  const [lifecycle, setLifecycle] = useState<AndroidEmulatorLifecycleEvent>(INITIAL_LIFECYCLE)
  const [frameDataUrl, setFrameDataUrl] = useState<string>()
  const [busyAvd, setBusyAvd] = useState<string>()
  const [error, setError] = useState<string>()
  const [agentPresence, setAgentPresence] = useState<AndroidEmulatorPresenceEvent>()
  const [agentOpenRequest, setAgentOpenRequest] = useState(0)
  const [recording, setRecording] = useState<AndroidRecordingState>({ state: 'idle' })
  const [lastMediaFile, setLastMediaFile] = useState<AndroidMediaFile>()
  const sessionRef = useRef<AndroidEmulatorSession | undefined>(undefined)
  const recordingRef = useRef<AndroidRecordingState>({ state: 'idle' })
  const latestFrameRef = useRef<AndroidEmulatorFrame | undefined>(undefined)
  const attachingRef = useRef(false)
  const pendingFrameRef = useRef<AndroidEmulatorFrame | undefined>(undefined)
  const readPendingFrame = useCallback(() => pendingFrameRef.current, [])

  const clearSession = useCallback(() => {
    sessionRef.current = undefined
    pendingFrameRef.current = undefined
    latestFrameRef.current = undefined
    recordingRef.current = { state: 'idle' }
    setSession(undefined)
    setFrameDataUrl(undefined)
    setAgentPresence(undefined)
    setLifecycle(INITIAL_LIFECYCLE)
    setRecording({ state: 'idle' })
  }, [])

  const publishFrame = useCallback((frame: AndroidEmulatorFrame) => {
    latestFrameRef.current = frame
    setFrameDataUrl(`data:image/png;base64,${frame.pngBase64}`)
  }, [])

  const refresh = useCallback(async () => {
    setRequirementsLoading(true)
    setError(undefined)
    try {
      const next = await androidEmulatorApi.requirements()
      setLegacyBackend(false)
      setRequirements(next)
      return next.devices.length
    } catch (reason) {
      if (isUnknownCommandError(reason)) {
        setLegacyBackend(true)
        setRequirements(undefined)
      } else {
        setLegacyBackend(false)
        setError(errorText(reason))
      }
      return undefined
    } finally {
      setRequirementsLoading(false)
    }
  }, [])

  const open = useCallback(async () => {
    setError(undefined)
    try {
      await androidEmulatorApi.setVisible(true)
    } catch (reason) {
      // F0 backends do not have the F1 visibility command yet. Requirements
      // must still run so onboarding and the explicit legacy guide keep
      // working while the native boundary rolls forward.
      if (!isUnknownCommandError(reason)) setError(errorText(reason))
    }
    return await refresh()
  }, [refresh])

  const close = useCallback(() => {
    setAgentPresence(undefined)
    void androidEmulatorApi.setVisible(false).catch(reason => setError(errorText(reason)))
  }, [])

  const attach = useCallback(async (avdName: string) => {
    setBusyAvd(avdName)
    setError(undefined)
    setFrameDataUrl(undefined)
    setLifecycle(INITIAL_LIFECYCLE)
    attachingRef.current = true
    pendingFrameRef.current = undefined
    try {
      const next = await androidEmulatorApi.attach(
        avdName,
        streamFps,
        fallbackFps,
      )
      sessionRef.current = next
      setSession(next)
      setStreamFps(next.streamFps)
      setFallbackFps(next.fallbackFps)
      setLifecycle(next.lifecycle)
      setRequirements(current => current ? {
        ...current,
        devices: current.devices.map(device => device.avdName === next.device.avdName
          ? next.device
          : device),
      } : current)
      const pending = readPendingFrame()
      if (pending?.generation === next.generation) publishFrame(pending)
    } catch (reason) {
      clearSession()
      setError(errorText(reason))
    } finally {
      attachingRef.current = false
      pendingFrameRef.current = undefined
      setBusyAvd(undefined)
    }
  }, [clearSession, fallbackFps, publishFrame, readPendingFrame, streamFps])

  const detach = useCallback(async () => {
    setError(undefined)
    try {
      await androidEmulatorApi.detach()
      clearSession()
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [clearSession, refresh])

  const endSimulation = useCallback(async () => {
    setError(undefined)
    try {
      await androidEmulatorApi.end()
      clearSession()
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [clearSession, refresh])

  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await operation()
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [])

  const tap = useCallback((point: AndroidEmulatorPoint) =>
    run(() => androidEmulatorApi.tap(point.x, point.y)), [run])
  const drag = useCallback((from: AndroidEmulatorPoint, to: AndroidEmulatorPoint, durationMs: number) =>
    run(() => androidEmulatorApi.drag(from.x, from.y, to.x, to.y, durationMs)), [run])
  const typeText = useCallback((text: string) => run(() => androidEmulatorApi.typeText(text)), [run])
  const pressKey = useCallback((key: AndroidEmulatorKey) => run(() => androidEmulatorApi.pressKey(key)), [run])
  const runSystemAction = useCallback((action: AndroidEmulatorSystemAction) =>
    run(() => androidEmulatorApi.systemAction(action)), [run])

  const inspectPoint = useCallback(async (
    point: AndroidEmulatorPoint,
    _exact = false,
  ): Promise<AndroidEmulatorElementHit | undefined> => {
    const generation = sessionRef.current?.generation
    if (generation == null) return undefined
    try {
      const hit = await androidEmulatorApi.inspectPoint(point.x, point.y)
      if (sessionRef.current?.generation !== generation) return undefined
      return hit ?? undefined
    } catch {
      return undefined
    }
  }, [])

  const captureAnnotation = useCallback(async (
    rect: IosSimulatorRect,
    element: AndroidAccessibilityNode | null = null,
  ): Promise<IosSimulatorAnnotationCapture | undefined> => {
    const current = sessionRef.current
    const frame = latestFrameRef.current
    if (!current || !frame || frame.generation !== current.generation) return undefined
    setError(undefined)
    try {
      const file = await androidEmulatorApi.captureScreen()
      const deviceRect = {
        x: rect.x * frame.width,
        y: rect.y * frame.height,
        width: rect.width * frame.width,
        height: rect.height * frame.height,
      }
      const bytes = Math.floor(frame.pngBase64.length * 0.75)
      // The frozen Android F2 boundary exposes a full screenshot, not a
      // server-side crop command. Keep the normalized selection in metadata
      // and reference the same honest viewport file for both image slots.
      return {
        cropPath: file.path,
        viewportPath: file.path,
        cropWidth: frame.width,
        cropHeight: frame.height,
        viewportWidth: frame.width,
        viewportHeight: frame.height,
        cropBytes: bytes,
        viewportBytes: bytes,
        device: {
          name: current.device.displayName,
          udid: current.device.avdName,
          state: 'Booted',
          iosVersion: `API ${current.device.apiLevel}`,
          family: current.device.family === 'tablet' ? 'ipad' : 'iphone',
        },
        orientation: frame.width > frame.height ? 'landscape' : 'portrait',
        deviceGeneration: current.generation,
        frameGeneration: frame.generation,
        rect,
        deviceRect,
        element,
      }
    } catch (reason) {
      setError(errorText(reason))
      return undefined
    }
  }, [])

  const captureScreen = useCallback(async () => {
    setError(undefined)
    try {
      const file = await androidEmulatorApi.captureScreen()
      setLastMediaFile(mediaFile(file.path))
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [])

  const toggleRecording = useCallback(async () => {
    const current = recordingRef.current
    if (current.state === 'starting' || current.state === 'finalizing') return
    setError(undefined)
    if (current.state === 'recording') {
      recordingRef.current = { state: 'finalizing' }
      setRecording(recordingRef.current)
      try {
        const file = await androidEmulatorApi.recordingStop()
        setLastMediaFile(mediaFile(file.path))
        recordingRef.current = { state: 'idle' }
        setRecording(recordingRef.current)
      } catch (reason) {
        recordingRef.current = current
        setRecording(current)
        setError(errorText(reason))
      }
      return
    }
    recordingRef.current = { state: 'starting' }
    setRecording(recordingRef.current)
    try {
      await androidEmulatorApi.recordingStart()
      recordingRef.current = { state: 'recording', startedAtMs: Date.now() }
      setRecording(recordingRef.current)
    } catch (reason) {
      recordingRef.current = { state: 'idle' }
      setRecording(recordingRef.current)
      setError(errorText(reason))
    }
  }, [])

  const setStreamRate = useCallback(async (nextFps: number) => {
    setError(undefined)
    if (!sessionRef.current) {
      setStreamFps(nextFps)
      return
    }
    try {
      const applied = await androidEmulatorApi.setStreamRate(nextFps)
      const value = applied ?? nextFps
      setStreamFps(value)
      setSession(current => current ? { ...current, streamFps: value } : current)
      if (sessionRef.current) sessionRef.current = { ...sessionRef.current, streamFps: value }
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [])

  const setFallbackRate = useCallback(async (nextFps: number) => {
    setError(undefined)
    if (!sessionRef.current) {
      setFallbackFps(nextFps)
      return
    }
    try {
      const applied = await androidEmulatorApi.setFallbackRate(nextFps)
      const value = applied ?? nextFps
      setFallbackFps(value)
      setSession(current => current ? { ...current, fallbackFps: value } : current)
      if (sessionRef.current) sessionRef.current = { ...sessionRef.current, fallbackFps: value }
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const unlisteners: Array<() => void> = []
    void Promise.all([
      androidEmulatorApi.onFrame(frame => {
        if (disposed) return
        const current = sessionRef.current
        if (current?.generation === frame.generation) {
          publishFrame(frame)
        } else if (attachingRef.current) {
          pendingFrameRef.current = frame
        }
      }),
      androidEmulatorApi.onLifecycle(event => {
        if (!disposed) setLifecycle(event)
      }),
      androidEmulatorApi.onError(event => {
        if (!disposed) setError(event.message)
      }),
      androidEmulatorApi.onPresence(event => {
        if (disposed || event.generation !== sessionRef.current?.generation) return
        setAgentPresence(event.phase === 'start' ? event : undefined)
      }),
      androidEmulatorApi.onOpenRequested(presence => {
        if (disposed) return
        if (presence?.phase === 'start') setAgentPresence(presence)
        setAgentOpenRequest(current => current + 1)
      }),
    ]).then(next => {
      if (disposed) next.forEach(unlisten => unlisten())
      else unlisteners.push(...next)
    })
    return () => {
      disposed = true
      unlisteners.forEach(unlisten => unlisten())
    }
  }, [publishFrame])

  return {
    requirements,
    requirementsLoading,
    legacyBackend,
    session,
    streamFps,
    fallbackFps,
    lifecycle,
    interactionReady: Boolean(session && lifecycle.stage === 'ready'),
    frameDataUrl,
    busyAvd,
    error,
    agentPresence,
    agentOpenRequest,
    recording,
    recordingActive: recording.state === 'recording',
    lastMediaFile,
    refresh,
    open,
    close,
    attach,
    detach,
    endSimulation,
    tap,
    drag,
    typeText,
    pressKey,
    runSystemAction,
    inspectPoint,
    captureAnnotation,
    captureScreen,
    toggleRecording,
    setStreamRate,
    setFallbackRate,
  }
}
