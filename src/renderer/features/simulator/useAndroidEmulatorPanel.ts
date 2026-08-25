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
import {
  parseFrameError,
  parsePreviewState,
  type AndroidFrameError,
  type AndroidPreviewStateEvent,
} from './androidEmulatorApi'
import { parseVaf1 } from './vaf1'
import type { PaintReceipt, RgbPaintPush } from './androidWebglPreview'
import { FrameStats } from './frameStats'
import { loadPersistedStreamFps, persistStreamFps } from './androidStreamSettings'
import type { IosSimulatorAnnotationCapture, IosSimulatorRect } from './iosSimulatorApi'
import {
  DEFAULT_ANDROID_EMULATOR_FALLBACK_FPS,
  DEFAULT_ANDROID_EMULATOR_STREAM_FPS,
  errorText,
  isUnknownCommandError,
  normalizeAndroidStreamFps,
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
  const streamTouchedRef = useRef(false)
  const streamFpsRef = useRef(DEFAULT_ANDROID_EMULATOR_STREAM_FPS)
  const persistedLoadedRef = useRef(false)
  const [fpsSyncError, setFpsSyncError] = useState<'persistFailed' | 'rollbackFailed' | 'applyFailed'>()
  const applyStreamFps = useCallback((value: number) => {
    streamFpsRef.current = normalizeAndroidStreamFps(value)
    setStreamFps(streamFpsRef.current)
  }, [])
  const ensurePersistedFps = useCallback(async (): Promise<number> => {
    if (persistedLoadedRef.current) return streamFpsRef.current
    persistedLoadedRef.current = true
    const fps = await loadPersistedStreamFps(window.verboo)
    if (!streamTouchedRef.current) applyStreamFps(fps)
    return streamFpsRef.current
  }, [applyStreamFps])
  const recordingRef = useRef<AndroidRecordingState>({ state: 'idle' })
  const latestFrameRef = useRef<AndroidEmulatorFrame | undefined>(undefined)
  const attachingRef = useRef(false)
  const pendingFrameRef = useRef<AndroidEmulatorFrame | undefined>(undefined)
  const readPendingFrame = useCallback(() => pendingFrameRef.current, [])

  // ── Pipeline VAF1 (fence RENDERER) — estado em refs; zero state por frame ──
  const frameStatsRef = useRef(new FrameStats())
  const pushFrameRef = useRef<RgbPaintPush | null>(null)
  const readInFlightRef = useRef(false)
  const readDirtyRef = useRef(false)
  const readRafRef = useRef<number | undefined>(undefined)
  const presentedRafRef = useRef<number | undefined>(undefined)
  const pendingReadyRef = useRef<{ generation: number; seq: number } | undefined>(undefined)
  const lastPaintedRef = useRef<PaintReceipt | undefined>(undefined)
  const canvasSizeRef = useRef<{ width: number; height: number } | undefined>(undefined)
  const haltedRef = useRef(false)
  const webglFallbackRef = useRef(false)
  const pendingPreviewStateRef = useRef<AndroidPreviewStateEvent | undefined>(undefined)
  const visibleRef = useRef(true)
  const [previewState, setPreviewState] = useState<AndroidPreviewStateEvent>()
  const [captureFailure, setCaptureFailure] = useState<'pngMetaUnavailable'>()
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | undefined>()
  const operationEpochRef = useRef(0)
  const previewSourceRef = useRef<'grpc' | 'adbFallback' | 'legacy'>('legacy')
  const staleResyncUsedRef = useRef(false)
  const actualFpsNodeRef = useRef<HTMLSpanElement | null>(null)
  const lastFpsUiFlushRef = useRef(0)
  const stopPreviewLoop = useCallback(() => {
    // Oculto/close/reattach: incrementa a ÉPOCA, cancela agendamentos e limpa
    // sinalização — mas NUNCA baixa readInFlightRef: o invoke em voo resolve
    // e o próprio finally o libera (resultado descartado pela época).
    operationEpochRef.current += 1
    if (readRafRef.current !== undefined) {
      window.cancelAnimationFrame(readRafRef.current)
      readRafRef.current = undefined
    }
    if (presentedRafRef.current !== undefined) {
      window.cancelAnimationFrame(presentedRafRef.current)
      presentedRafRef.current = undefined
    }
    readDirtyRef.current = false
    pendingReadyRef.current = undefined
    staleResyncUsedRef.current = false
  }, [])
  function handleReadError(
    error: AndroidFrameError,
    staleReady: { generation: number; seq: number },
  ): void {
    if (error.code === 'stale_generation') {
      if (error.currentGeneration !== sessionRef.current?.generation) {
        haltedRef.current = true       // DIVERGENTE: aguarda native/preview-state
        pendingReadyRef.current = undefined
        return
      }
      if (!staleResyncUsedRef.current) {
        // PRIMEIRA matching: auto-retry ÚNICO por época — restaura o ciclo e
        // marca dirty; o finally reinvoca.
        staleResyncUsedRef.current = true
        pendingReadyRef.current = staleReady
        readDirtyRef.current = true
        return
      }
      // SEGUNDA matching: limpa pending/dirty e AGUARDA wakeup — SEM halted.
      pendingReadyRef.current = undefined
      return
    }
    if (error.code === 'no_frame') return   // benigno: próximo wakeup dirige
    // unavailable|unauthenticated|unsupported: DONO NATIVO coordena o fallback
    // e emitirá preview-state; renderer apenas para de agendar.
    haltedRef.current = true
    pendingReadyRef.current = undefined
  }
  function drainAfterSettle(): void {
    // Época CORRENTE por definição: chamado só do finally. Close->open com
    // wakeup novo durante o voo velho NÃO congela — o dreno agenda aqui.
    if (!visibleRef.current || haltedRef.current) {
      readDirtyRef.current = false
      return
    }
    if (!pushFrameRef.current || !pendingReadyRef.current) {
      readDirtyRef.current = false
      return
    }
    if (readDirtyRef.current) {
      readDirtyRef.current = false
      scheduleVaf1Read()
    }
  }
  const performReadCycle = useCallback(async () => {
    const ready = pendingReadyRef.current
    const push = pushFrameRef.current
    if (!ready || !push || readInFlightRef.current || attachingRef.current) return
    const epoch = operationEpochRef.current
    const generation = ready.generation             // latch ÚNICO por ciclo
    pendingReadyRef.current = undefined
    readInFlightRef.current = true
    try {
      const buffer = await androidEmulatorApi.readFrame(generation)
      const parsed = parseVaf1(buffer)
      if (
        parsed.ok
        && parsed.frame.generation !== generation
        && epoch === operationEpochRef.current
        && !attachingRef.current
        && visibleRef.current
        && !haltedRef.current
        && sessionRef.current?.generation === generation
        && previewSourceRef.current === 'grpc'
        && pushFrameRef.current === push
      ) {
        // Envelope VAF1 íntegro mas de OUTRA geração que a sessão: o stream
        // grpc deixou de ser a fonte verdadeira — retrai o modo de forma
        // honesta (estado desconhecido ⇒ legacy) em vez de pintar ou afirmar
        // grpc. Sem isto 'previewMode' ficaria vaf1 para sempre após o attach.
        previewSourceRef.current = 'legacy'
        setPreviewState(undefined)
        return
      }
      if (
        epoch !== operationEpochRef.current
        || attachingRef.current
        || !visibleRef.current
        || haltedRef.current
        || sessionRef.current?.generation !== generation
        || previewSourceRef.current !== 'grpc'
        || !parsed.ok
        || parsed.frame.generation !== generation
        || pushFrameRef.current !== push
      ) {
        return                                       // resultado obsoleto: ignorado
      }
      const frame = parsed.frame
      const last = lastPaintedRef.current
      if (!last || frame.generation !== last.generation || frame.seq > last.seq) {
        const receipt = push(frame)
        if (receipt && epoch === operationEpochRef.current) {
          // push pode disparar downgrade SINCRONAMENTE (epoch++) — nesse caso
          // o bookkeeping deste frame é obsoleto e é descartado aqui.
          staleResyncUsedRef.current = false         // pintou: ressync disponível de novo
          lastPaintedRef.current = receipt
          frameStatsRef.current.recordPaint({
            seq: frame.seq,
            timestampUs: receipt.timestampUs,
            paintedAtMs: receipt.paintedAtMs,
          })
          presentedRafRef.current = window.requestAnimationFrame(presentedAt => {
            presentedRafRef.current = undefined
            frameStatsRef.current.recordPresented(presentedAt)
            // Sink do actual-fps DENTRO do rAF ACK (inclui o paint que o
            // disparou), throttled ≥1 s — sem timer, sem state.
            const node = actualFpsNodeRef.current
            if (node && presentedAt - lastFpsUiFlushRef.current >= 1000) {
              lastFpsUiFlushRef.current = presentedAt
              const snapshotNow = frameStatsRef.current.snapshot(presentedAt)
              const shownFps = snapshotNow.presentedFps
              node.textContent = shownFps === undefined ? '—' : shownFps.toFixed(1)
            }
          })
          if (
            !canvasSizeRef.current
            || canvasSizeRef.current.width !== receipt.width
            || canvasSizeRef.current.height !== receipt.height
          ) {
            canvasSizeRef.current = { width: receipt.width, height: receipt.height }
            setCanvasSize(canvasSizeRef.current)     // transição rara (rotação)
          }
        }
      }
    } catch (reason) {
      // Guarda COMPLETA antes de classificar: resultado/erro OBSOLETO jamais
      // toca halted/pending da era corrente (epoch/visible/session/source).
      if (
        epoch !== operationEpochRef.current
        || attachingRef.current
        || !visibleRef.current
        || sessionRef.current?.generation !== generation
        || previewSourceRef.current !== 'grpc'
      ) {
        return
      }
      handleReadError(parseFrameError(reason), ready)
    } finally {
      readInFlightRef.current = false                // ÚNICO ponto de liberação
      drainAfterSettle()                             // drena o ESTADO corrente
    }
  }, [])
  const scheduleVaf1Read = useCallback(() => {
    if (readRafRef.current !== undefined || haltedRef.current || !visibleRef.current) return
    if (attachingRef.current) return                     // attach em voo: só dreno pós-resposta
    if (!pushFrameRef.current || readInFlightRef.current) return
    readRafRef.current = window.requestAnimationFrame(() => {
      readRafRef.current = undefined
      void performReadCycle()
    })
  }, [performReadCycle])
  const applyPreviewState = useCallback((event: AndroidPreviewStateEvent) => {
    previewSourceRef.current = event.source           // espelho síncrono p/ guards
    staleResyncUsedRef.current = false                // nova era de fonte: ressync limpo
    setPreviewState(event)                            // transição rara; throttle natural
    if (event.source === 'adbFallback') {
      haltedRef.current = true
      stopPreviewLoop()
    } else {
      haltedRef.current = false
    }
  }, [stopPreviewLoop])
  const bindPreviewCanvas = useCallback((push: RgbPaintPush | null) => {
    pushFrameRef.current = push
    if (!push) {
      stopPreviewLoop()
      return
    }
    if (
      pendingReadyRef.current && !readInFlightRef.current && !attachingRef.current
    ) {
      scheduleVaf1Read()
    }
  }, [scheduleVaf1Read, stopPreviewLoop])
  const requestLegacyPngAttach = useCallback(() => {
    // MESMA disciplina do reattach: guard attachingRef + epoch + pending.
    // readInFlightRef NÃO bloqueia: falha terminal disparada por push durante
    // um read em voo é perdida para sempre se esperarmos. A época descarta o
    // resultado antigo; o finally dele libera inFlight sem efeito colateral.
    if (webglFallbackRef.current || attachingRef.current) return
    const current = sessionRef.current
    if (!current) return
    webglFallbackRef.current = true
    attachingRef.current = true
    stopPreviewLoop()                       // época++ e limpeza pending/dirty/rAFs
    const epoch = operationEpochRef.current // capturada APÓS o próprio bump
    setError(undefined)
    void androidEmulatorApi.attach(
      current.device.avdName,
      streamFpsRef.current,
      DEFAULT_ANDROID_EMULATOR_FALLBACK_FPS,
      'legacyPng',
    ).then(next => {
      if (epoch !== operationEpochRef.current) return   // ÓRFÃO: não escreve NADA
      attachingRef.current = false
      sessionRef.current = next
      setSession(next)
      applyStreamFps(next.streamFps)
      setFallbackFps(next.fallbackFps)
      setLifecycle(next.lifecycle)
      lastPaintedRef.current = undefined
      canvasSizeRef.current = undefined
      setCanvasSize(undefined)
      // O preview-state BUFFERIZADO é AUTORITATIVO — drena byte a byte
      // quando casa com a nova sessão; JAMAIS apagar para sintetizar estado.
      const pendingState = pendingPreviewStateRef.current
      pendingPreviewStateRef.current = undefined
      if (pendingState && pendingState.generation === next.generation) {
        applyPreviewState(pendingState)
      } else {
        // Interim HONESTO (sem estado native ainda): NUNCA afirma ready/
        // non-degraded, NUNCA inventa reason.
        applyPreviewState({
          generation: next.generation,
          source: 'adbFallback',
          requestedFps: normalizeAndroidStreamFps(next.streamFps),
          degraded: true,
        })
      }
    }).catch(reason => {
      if (epoch !== operationEpochRef.current) return   // órfão: error intacto
      setError(errorText(reason))
    }).finally(() => {
      // Só a ÉPOCA CORRENTE finaliza attaching; um resolve/reject velho jamais
      // destrava o guard de uma nova era.
      if (epoch === operationEpochRef.current) attachingRef.current = false
    })
  }, [applyPreviewState, applyStreamFps, stopPreviewLoop])
  const bindActualFpsNode = useCallback((node: HTMLSpanElement | null) => {
    actualFpsNodeRef.current = node
    if (!node) return
    const presentedFps = frameStatsRef.current.snapshot(performance.now()).presentedFps
    node.textContent = presentedFps === undefined ? '—' : presentedFps.toFixed(1)
  }, [])
  const previewSnapshot = useCallback(
    (nowMs?: number) => frameStatsRef.current.snapshot(nowMs ?? performance.now()),
    [],
  )

  const clearSession = useCallback(() => {
    sessionRef.current = undefined
    pendingFrameRef.current = undefined
    latestFrameRef.current = undefined
    recordingRef.current = { state: 'idle' }
    attachingRef.current = false
    stopPreviewLoop()
    haltedRef.current = false
    webglFallbackRef.current = false
    pendingPreviewStateRef.current = undefined
    setPreviewState(undefined)
    lastPaintedRef.current = undefined
    canvasSizeRef.current = undefined
    setCanvasSize(undefined)
    setCaptureFailure(undefined)
    setSession(undefined)
    setFrameDataUrl(undefined)
    setAgentPresence(undefined)
    setLifecycle(INITIAL_LIFECYCLE)
    setRecording({ state: 'idle' })
  }, [stopPreviewLoop])

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
    visibleRef.current = true
    haltedRef.current = false
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
    visibleRef.current = false
    stopPreviewLoop()
    void androidEmulatorApi.setVisible(false).catch(reason => setError(errorText(reason)))
  }, [stopPreviewLoop])

  const attach = useCallback(async (avdName: string) => {
    setBusyAvd(avdName)
    setError(undefined)
    setFrameDataUrl(undefined)
    setLifecycle(INITIAL_LIFECYCLE)
    pendingPreviewStateRef.current = undefined
    setPreviewState(undefined)
    lastPaintedRef.current = undefined
    canvasSizeRef.current = undefined
    setCanvasSize(undefined)
    haltedRef.current = false
    webglFallbackRef.current = false
    staleResyncUsedRef.current = false
    stopPreviewLoop()
    attachingRef.current = true
    pendingFrameRef.current = undefined
    const requestedFps = await ensurePersistedFps()
    try {
      const next = await androidEmulatorApi.attach(
        avdName,
        requestedFps,
        DEFAULT_ANDROID_EMULATOR_FALLBACK_FPS,
        'vaf1',
      )
      sessionRef.current = next
      setSession(next)
      applyStreamFps(next.streamFps)
      setFallbackFps(next.fallbackFps)
      setLifecycle(next.lifecycle)
      attachingRef.current = false   // resposta RECEBIDA: o attach não está
      // mais em voo — o dreno pós-resposta abaixo PRECISA poder agendar (o
      // downgrade legacyPng faz o mesmo no .then). O finally rebaixa de novo
      // (idempotente).
      const pendingState = pendingPreviewStateRef.current as AndroidPreviewStateEvent | undefined
      pendingPreviewStateRef.current = undefined
      haltedRef.current = false
      // Attach VAF1 aceito: a fonte otimista É grpc SEMPRE (o native emite o
      // preview-state autoritativo em seguida e sobrescreve). Sem o espelho
      // síncrono o guard previewSourceRef !== 'grpc' do performReadCycle
      // jamais pintaria.
      applyPreviewState({
        generation: next.generation,
        source: 'grpc',
        requestedFps: normalizeAndroidStreamFps(next.streamFps),
        degraded: false,
      })
      if (pendingState && pendingState.generation === next.generation) {
        // C3: preview-state BUFFERED durante o attach é AUTORITATIVO para a UI
        // (byte-a-byte: degraded/reason preservados) MAS não rebaixa a fonte
        // nem halted — o wakeup drenado em seguida é monotonicamente mais novo
        // (mesma generation, seq maior: ack POSTERIOR do backend, prova de
        // frescor). Um estado LIVE posterior rebaixa normalmente pelo listener.
        setPreviewState(pendingState)
      }
      const drainedReady = pendingReadyRef.current
      if (drainedReady && drainedReady.generation !== next.generation) {
        pendingReadyRef.current = undefined           // wakeup da sessão velha
      } else if (
        drainedReady && pushFrameRef.current && !haltedRef.current && visibleRef.current
      ) {
        frameStatsRef.current.recordWakeup()          // dreno do buffer pós-resposta
        scheduleVaf1Read()
      }
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
  }, [applyPreviewState, applyStreamFps, clearSession, ensurePersistedFps, publishFrame, readPendingFrame, scheduleVaf1Read, stopPreviewLoop])

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
    run(() => androidEmulatorApi.tap(point.x, point.y, 'manual')), [run])
  const drag = useCallback((from: AndroidEmulatorPoint, to: AndroidEmulatorPoint, durationMs: number) =>
    run(() => androidEmulatorApi.drag(from.x, from.y, to.x, to.y, durationMs, 'manual')), [run])
  const typeText = useCallback((text: string) =>
    run(() => androidEmulatorApi.typeText(text, 'manual')), [run])
  const pressKey = useCallback((key: AndroidEmulatorKey) =>
    run(() => androidEmulatorApi.pressKey(key, 'manual')), [run])
  const runSystemAction = useCallback((action: AndroidEmulatorSystemAction) =>
    run(() => androidEmulatorApi.systemAction(action, 'manual')), [run])

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
    // Gate usa SOMENTE a generation do último paint — nunca dims/bytes dele.
    const paintedGeneration = lastPaintedRef.current?.generation
      ?? latestFrameRef.current?.generation
    if (!current || paintedGeneration !== current.generation) return undefined
    setError(undefined)
    setCaptureFailure(undefined)
    try {
      const file = await androidEmulatorApi.captureScreen()
      // PNG físico: bytes/dims REAIS via inspectFiles — nunca 720p/RGB assumido.
      const inspected = await window.verboo.inspectFiles([file.path])
      const png = inspected.find(item => item.path === file.path)
      if (
        !png
        || typeof png.size !== 'number' || png.size <= 0
        || typeof png.width !== 'number' || png.width <= 0
        || typeof png.height !== 'number' || png.height <= 0
      ) {
        setCaptureFailure('pngMetaUnavailable')     // tipado; UI localiza (Task 11)
        return undefined
      }
      const deviceRect = {
        x: rect.x * png.width,
        y: rect.y * png.height,
        width: rect.width * png.width,
        height: rect.height * png.height,
      }
      return {
        cropPath: file.path,
        viewportPath: file.path,
        cropWidth: png.width,
        cropHeight: png.height,
        viewportWidth: png.width,
        viewportHeight: png.height,
        cropBytes: png.size,
        viewportBytes: png.size,
        device: {
          name: current.device.displayName,
          udid: current.device.avdName,
          state: 'Booted',
          iosVersion: `API ${current.device.apiLevel}`,
          family: current.device.family === 'tablet' ? 'ipad' : 'iphone',
        },
        orientation: png.width > png.height ? 'landscape' : 'portrait',
        deviceGeneration: current.generation,
        frameGeneration: paintedGeneration,
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

  const setStreamRate = useCallback(async (nextRaw: number) => {
    setError(undefined)
    setFpsSyncError(undefined)
    const next = normalizeAndroidStreamFps(nextRaw)
    const previous = streamFpsRef.current
    streamTouchedRef.current = true
    if (previous !== next) applyStreamFps(next)
    if (!(await persistStreamFps(window.verboo, next))) {
      applyStreamFps(await loadPersistedStreamFps(window.verboo))
      setFpsSyncError('persistFailed')
      return
    }
    try {
      const applied = await androidEmulatorApi.setStreamRate(next)
      applyStreamFps(applied ?? next)
      if (sessionRef.current) {
        sessionRef.current = {
          ...sessionRef.current,
          streamFps: normalizeAndroidStreamFps(applied ?? next),
        }
      }
    } catch {
      if (!(await persistStreamFps(window.verboo, previous))) {
        applyStreamFps(await loadPersistedStreamFps(window.verboo))
        setFpsSyncError('rollbackFailed')
        return
      }
      applyStreamFps(previous)
      setFpsSyncError('applyFailed')
    }
  }, [applyStreamFps])

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
      androidEmulatorApi.onFrameReady(ready => {
        if (disposed) return
        const { generation, seq } = ready ?? {}
        if (
          !Number.isSafeInteger(generation) || generation <= 0
          || !Number.isSafeInteger(seq) || seq <= 0
        ) return
        if (attachingRef.current) {
          // Attach em progresso (primeiro OU same-AVD): buffer MONOTÔNICO
          // latest-by-(generation, seq); drenagem decide pós-resposta.
          const previous = pendingReadyRef.current
          if (
            !previous
            || generation > previous.generation
            || (generation === previous.generation && seq > previous.seq)
          ) {
            pendingReadyRef.current = { generation, seq }
          }
          return
        }
        if (generation !== sessionRef.current?.generation) return   // sinal tardio
        frameStatsRef.current.recordWakeup()
        pendingReadyRef.current = { generation, seq }              // latest vence
        if (!pushFrameRef.current) return       // INVARIANTE: sem paintTarget NÃO toma slot
        if (haltedRef.current || !visibleRef.current) return
        if (readInFlightRef.current) { readDirtyRef.current = true; return }
        scheduleVaf1Read()
      }),
      androidEmulatorApi.onPreviewState(event => {
        if (disposed) return
        const parsed = parsePreviewState(event)
        if (!parsed) return
        const current = sessionRef.current
        if (attachingRef.current || !current) {
          // Primeira corrida OU same-AVD com sessão antiga: buffer MONOTÔNICO —
          // rejeita generation MENOR; mesma generation é LAST-ARRIVAL-WINS
          // (permite grpc→adbFallback). Dreno pós-resposta contra a NOVA sessão.
          const previous = pendingPreviewStateRef.current
          if (previous && parsed.generation < previous.generation) return
          pendingPreviewStateRef.current = parsed
          return
        }
        if (parsed.generation !== current.generation) return
        applyPreviewState(parsed)
      }),
    ]).then(next => {
      if (disposed) next.forEach(unlisten => unlisten())
      else unlisteners.push(...next)
    })
    return () => {
      disposed = true
      stopPreviewLoop()
      unlisteners.forEach(unlisten => unlisten())
    }
  }, [applyPreviewState, publishFrame, scheduleVaf1Read, stopPreviewLoop])

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
    previewMode: previewState?.source === 'grpc' ? 'vaf1' : 'legacy',
    previewState,
    canvasSize,
    captureFailure,
    fpsSyncError,
    bindPreviewCanvas,
    onWebglTerminalFailure: requestLegacyPngAttach,
    previewSnapshot,
    bindActualFpsNode,
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
  }
}
