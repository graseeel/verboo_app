import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { SimulatorIssue } from './iosSimulatorModel'

const noopUnlisten: UnlistenFn = () => {}

function listenInTauri<T>(eventName: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return Promise.resolve(noopUnlisten)
  }
  return listen<T>(eventName, event => handler(event.payload))
}

export type IosSimulatorDevice = {
  name: string
  udid: string
  state: string
  iosVersion: string
  family: IosSimulatorDeviceFamily
  ownership?: IosSimulatorOwnership | null
}

export type IosSimulatorOwnership = 'external' | 'verboo'
export type IosSimulatorDeviceFamily = 'iphone' | 'ipad'
export type IosSimulatorStartupStage =
  | 'idle'
  | 'booting'
  | 'waitingForDisplay'
  | 'generatingFirstPreview'
  | 'preparingInteraction'
  | 'ready'
export type IosSimulatorRecordingState =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'recording'; startedAtMs: number }
  | { state: 'finalizing' }
export type IosSimulatorLifecycleSnapshot = {
  udid: string | null
  deviceGeneration: number | null
  stage: IosSimulatorStartupStage
  ownership: IosSimulatorOwnership | null
  previewSuspended: boolean
  interactionReady: boolean
  recording: IosSimulatorRecordingState
  recoverableError: string | null
}
export type IosSimulatorSystemAction =
  | 'home'
  | 'appSwitcher'
  | 'notifications'
  | 'controlCenter'
  | 'rotateClockwise'
export type IosSimulatorMediaFile = { path: string; fileName: string }

export type IosSimulatorRequirements = {
  ready: boolean
  issue: SimulatorIssue | null
  xcodeVersion: string | null
  devices: IosSimulatorDevice[]
  attachedUdid: string | null
  streamFps: IosSimulatorStreamFps | null
  fallbackFps: IosSimulatorFallbackFps | null
  source: IosSimulatorStreamSource | null
  effectiveFps: number | null
  lifecycle: IosSimulatorLifecycleSnapshot
}

export type IosSimulatorStreamSource = 'simctl' | 'mjpeg'
export type IosSimulatorStreamFps = 30 | 60
export type IosSimulatorFallbackFps = 0.5 | 1 | 2

export type IosSimulatorSession = {
  device: IosSimulatorDevice
  deviceGeneration: number
  ownership: IosSimulatorOwnership
  streamFps: IosSimulatorStreamFps
  fallbackFps: IosSimulatorFallbackFps
  source: IosSimulatorStreamSource
  effectiveFps: number | null
  lifecycle: IosSimulatorLifecycleSnapshot
}

export type IosSimulatorFrame = {
  udid: string
  dataUrl: string
  deviceGeneration: number
  frameGeneration: number
  capturedAtMs: number
  source: IosSimulatorStreamSource
  effectiveFps: number | null
  agentPresence?: IosSimulatorPresenceEvent | null
}

export type IosSimulatorError = {
  udid: string
  message: string
}

export type IosSimulatorPoint = { x: number; y: number }
export type IosSimulatorPresencePhase = 'start' | 'clear'
export type IosSimulatorPresenceAction =
  | 'tap'
  | 'drag'
  | 'typeText'
  | 'pressKey'
  | 'inspect'
  | 'screenshot'
  | 'attach'
  | 'detach'

export type IosSimulatorPresenceEvent = {
  generation: number
  phase: IosSimulatorPresencePhase
  action?: IosSimulatorPresenceAction | null
  target?: IosSimulatorPoint | null
  start?: IosSimulatorPoint | null
  end?: IosSimulatorPoint | null
}
export type IosSimulatorKey =
  | 'enter'
  | 'backspace'
  | 'tab'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight'

export type IosSimulatorAccessibilityNode = {
  id: string
  role: string
  label?: string | null
  value?: string | null
  frame: { x: number; y: number; width: number; height: number }
  enabled: boolean
  visible: boolean
  actionable: boolean
}

export type IosSimulatorRect = { x: number; y: number; width: number; height: number }

export type IosSimulatorElementHit = {
  element: IosSimulatorAccessibilityNode
  rect: IosSimulatorRect
}

export type IosSimulatorAnnotationCapture = {
  cropPath: string
  viewportPath: string
  cropWidth: number
  cropHeight: number
  viewportWidth: number
  viewportHeight: number
  cropBytes: number
  viewportBytes: number
  device: IosSimulatorDevice
  orientation: 'portrait' | 'landscape'
  deviceGeneration: number
  frameGeneration: number
  rect: IosSimulatorRect
  deviceRect: IosSimulatorRect
  element?: IosSimulatorAccessibilityNode | null
}

export type PromotedSimulatorFile = { from: string; to: string }

export const iosSimulatorApi = {
  requirements: () => invoke<IosSimulatorRequirements>('ios_simulator_requirements'),
  attach: (udid: string, streamFps: IosSimulatorStreamFps, fallbackFps: IosSimulatorFallbackFps) =>
    invoke<IosSimulatorSession>('ios_simulator_attach', { udid, streamFps, fallbackFps }),
  detach: () => invoke<void>('ios_simulator_detach'),
  setVisible: (visible: boolean) => invoke<void>('ios_simulator_set_visible', { visible }),
  end: () => invoke<void>('ios_simulator_end'),
  shutdownExternal: (udid: string) =>
    invoke<void>('ios_simulator_shutdown_external', { udid }),
  systemAction: (action: IosSimulatorSystemAction) =>
    invoke<void>('ios_simulator_system_action', { action }),
  retryInteraction: () => invoke<IosSimulatorLifecycleSnapshot>('ios_simulator_retry_interaction'),
  captureScreen: () => invoke<IosSimulatorMediaFile>('ios_simulator_capture_screen'),
  startRecording: () => invoke<IosSimulatorLifecycleSnapshot>('ios_simulator_recording_start'),
  stopRecording: () => invoke<IosSimulatorMediaFile>('ios_simulator_recording_stop'),
  revealOutput: (path: string) => invoke<void>('ios_simulator_reveal_output', { path }),
  setStreamRate: (streamFps: IosSimulatorStreamFps) =>
    invoke<IosSimulatorStreamFps>('ios_simulator_set_stream_rate', { streamFps }),
  setFallbackRate: (fallbackFps: IosSimulatorFallbackFps) =>
    invoke<IosSimulatorFallbackFps>('ios_simulator_set_fallback_rate', { fallbackFps }),
  tap: (point: IosSimulatorPoint) => invoke<void>('ios_simulator_tap', { point }),
  drag: (from: IosSimulatorPoint, to: IosSimulatorPoint, durationMs = 180) =>
    invoke<void>('ios_simulator_drag', { from, to, durationMs }),
  typeText: (text: string) => invoke<void>('ios_simulator_type_text', { text }),
  pressKey: (key: IosSimulatorKey) => invoke<void>('ios_simulator_press_key', { key }),
  inspectPoint: (deviceGeneration: number, point: IosSimulatorPoint) =>
    invoke<IosSimulatorElementHit | null>('ios_simulator_inspect_point', {
      deviceGeneration,
      point,
    }),
  captureAnnotation: (
    deviceGeneration: number,
    rect: IosSimulatorRect,
    element: IosSimulatorAccessibilityNode | null = null,
  ) => invoke<IosSimulatorAnnotationCapture>('ios_simulator_capture_annotation', {
    deviceGeneration,
    rect,
    element,
  }),
  deleteTempFiles: (paths: string[]) =>
    invoke<void>('ios_simulator_delete_temp_files', { paths }),
  promoteTempFiles: (ownerId: string, paths: string[]) =>
    invoke<PromotedSimulatorFile[]>('ios_simulator_promote_temp_files', { ownerId, paths }),
  deleteCaptureOwner: (ownerId: string) =>
    invoke<void>('ios_simulator_delete_capture_owner', { ownerId }),
  cleanupCaptureOwners: (activeOwnerIds: string[]) =>
    invoke<void>('ios_simulator_cleanup_capture_owners', { activeOwnerIds }),
  onFrame: (handler: (frame: IosSimulatorFrame) => void): Promise<UnlistenFn> =>
    listenInTauri<IosSimulatorFrame>('ios-simulator:frame', handler),
  onError: (handler: (error: IosSimulatorError) => void): Promise<UnlistenFn> =>
    listenInTauri<IosSimulatorError>('ios-simulator:error', handler),
  onPresence: (handler: (presence: IosSimulatorPresenceEvent) => void): Promise<UnlistenFn> =>
    listenInTauri<IosSimulatorPresenceEvent>('ios-simulator:presence', handler),
  onOpenRequested: (
    handler: (presence?: IosSimulatorPresenceEvent | null) => void,
  ): Promise<UnlistenFn> =>
    listenInTauri<IosSimulatorPresenceEvent | null>('ios-simulator:open-requested', handler),
  onLifecycle: (handler: (snapshot: IosSimulatorLifecycleSnapshot) => void): Promise<UnlistenFn> =>
    listenInTauri<IosSimulatorLifecycleSnapshot>('ios-simulator:lifecycle', handler),
}
