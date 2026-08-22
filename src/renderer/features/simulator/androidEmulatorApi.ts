import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AndroidEmulatorIssue } from './androidEmulatorModel'
import type {
  SimulatorAccessibilityNode,
  SimulatorElementHit,
  SimulatorPoint,
  SimulatorRect,
} from './simulatorSelection'

/**
 * Android emulator bridge (PA-25, contract `contrato-android-simulator` —
 * frozen vocabulary 2026-08-19, refined with the `awaiting` resume protocol;
 * names verbatim, do not rename).
 *
 * Same shape as iosSimulatorApi (invoke/listen wrappers) so the F1 hooks
 * (PA-27) bind to a stable surface. F0 consumes only requirements +
 * setup_start/setup_cancel + the setup channels; the remaining commands are
 * declared now so the frozen vocabulary is load-bearing from F0.
 *
 * `awaiting` protocol (contract §Vocabulario congelado): the setup worker
 * PAUSES at acceptLicenses and before a large download, emitting
 * setup-progress with `awaiting: 'licenses' | 'download'`. The UI shows the
 * confirmation surface (the license text / download size arrives in
 * `message`, DISPLAY-ONLY — never anchor logic on it) and resumes the worker
 * by re-invoking setup_start with the SAME mode plus the matching flag=true.
 * mode 'toolchain' = downloadTools+acceptLicenses+installPackages (stops
 * before the system image/AVD); 'full' = every step. UI v1 always sends
 * 'full' — the backend derives the real step list from detect_requirements.
 */

const noopUnlisten: UnlistenFn = () => {}

function listenInTauri<T>(eventName: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return Promise.resolve(noopUnlisten)
  }
  return listen<T>(eventName, event => handler(event.payload))
}

export type AndroidDeviceFamily = 'phone' | 'tablet' | 'other'

export type AndroidDevice = {
  avdName: string
  displayName: string
  apiLevel: number
  family: AndroidDeviceFamily
  running: boolean
}

export type AndroidEmulatorRequirements = {
  ready: boolean
  /** Absent when every probe passes (Rust skips serializing None). */
  issue?: AndroidEmulatorIssue | null
  devices: AndroidDevice[]
}

export type AndroidEmulatorSetupMode = 'toolchain' | 'full'
export type AndroidEmulatorSetupStep =
  | 'downloadTools'
  | 'acceptLicenses'
  | 'installPackages'
  | 'downloadSystemImage'
  | 'createAvd'
  | 'enableAccel'
  | 'verify'
/** Present on setup-progress ONLY while the worker is paused waiting for an
 *  explicit user decision (frozen `awaiting` protocol). */
export type AndroidEmulatorSetupAwaiting = 'licenses' | 'download'
export type AndroidEmulatorSetupProgress = {
  step: AndroidEmulatorSetupStep
  /** Integer 0-100, present ONLY on downloadTools/installPackages/
   *  downloadSystemImage events (contract §Steps de setup). */
  percent?: number | null
  /** License text / download size for the awaiting card — DISPLAY-ONLY,
   *  never a logic input (contract §Eventos). */
  message?: string | null
  awaiting?: AndroidEmulatorSetupAwaiting | null
}
export type AndroidEmulatorSetupDone = {
  ready: boolean
  /** AndroidEmulatorIssue (same camelCase values) when ready=false. */
  issue?: string | null
  /** English failure detail outside the issue enum; the literal
   *  'cancelled' when the user cancelled (same pattern as iOS). */
  error?: string | null
}
/** Resume flags for a paused worker — exactly one matches the `awaiting`
 *  value the worker emitted (frozen protocol; PA-24 native side). */
export type AndroidEmulatorSetupResume = {
  acceptedLicenses?: boolean
  confirmDownload?: boolean
}

// lands in PA-26/PA-28) ───────────────────────────────────────────────────
export type AndroidEmulatorStartupStage =
  | 'booting'
  | 'waitingForDisplay'
  | 'generatingFirstPreview'
  | 'preparingInteraction'
  | 'ready'
/** Lifecycle stages REUSE the iOS startup stages (contract §Eventos). */
export type AndroidEmulatorLifecycleEvent = { stage: AndroidEmulatorStartupStage }

export type AndroidEmulatorSession = {
  device: AndroidDevice
  serial: string
  generation: number
  ownership: 'external' | 'verboo'
  streamFps: number
  fallbackFps: number
  lifecycle: AndroidEmulatorLifecycleEvent
}

export type AndroidEmulatorFrame = {
  pngBase64: string
  width: number
  height: number
  generation: number
}

export type AndroidEmulatorError = { message: string }

export type AndroidEmulatorPoint = SimulatorPoint
export type AndroidEmulatorRect = SimulatorRect

/** Shape identical to the iOS presence event (contract §Eventos) — declared
 *  independently so an iOS-side refactor cannot silently drift the Android
 *  contract. F3 owns the action set (MCP helper). */
export type AndroidEmulatorPresenceEvent = {
  generation: number
  phase: 'start' | 'clear'
  action?: string | null
  target?: AndroidEmulatorPoint | null
  start?: AndroidEmulatorPoint | null
  end?: AndroidEmulatorPoint | null
}

/** Frozen key names for android_emulator_press_key (contract §key map);
 *  the adb keycode mapping (66/67/61/111/19/20/21/22/62) is the backend's. */
export type AndroidEmulatorKey =
  | 'enter'
  | 'backspace'
  | 'tab'
  | 'escape'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight'
  | 'space'

export type AndroidEmulatorSystemAction = 'back' | 'home' | 'recents' | 'notifications' | 'rotate'

/** Mirrors the iOS accessibility node shape (parity goal); PA-28 owns the
 *  final field set when the uiautomator parser lands. */
export type AndroidAccessibilityNode = SimulatorAccessibilityNode
export type AndroidEmulatorElementHit = SimulatorElementHit

export type AndroidEmulatorMediaFile = { path: string }

export const androidEmulatorApi = {
  requirements: () => invoke<AndroidEmulatorRequirements>('android_emulator_requirements'),
  setupStart: (mode: AndroidEmulatorSetupMode, resume: AndroidEmulatorSetupResume = {}) =>
    invoke<void>('android_emulator_setup_start', { mode, ...resume }),
  setupCancel: () => invoke<void>('android_emulator_setup_cancel'),
  attach: (avdName: string, streamFps: number, fallbackFps: number) =>
    invoke<AndroidEmulatorSession>('android_emulator_attach', { avdName, streamFps, fallbackFps }),
  detach: () => invoke<void>('android_emulator_detach'),
  end: () => invoke<void>('android_emulator_end'),
  setVisible: (visible: boolean) => invoke<void>('android_emulator_set_visible', { visible }),
  setStreamRate: (fps: number) => invoke<number>('android_emulator_set_stream_rate', { fps }),
  setFallbackRate: (fps: number) => invoke<number>('android_emulator_set_fallback_rate', { fps }),
  tap: (x: number, y: number) => invoke<void>('android_emulator_tap', { x, y }),
  drag: (fromX: number, fromY: number, toX: number, toY: number, durationMs = 180) =>
    invoke<void>('android_emulator_drag', { fromX, fromY, toX, toY, durationMs }),
  typeText: (text: string) => invoke<void>('android_emulator_type_text', { text }),
  pressKey: (key: AndroidEmulatorKey) => invoke<void>('android_emulator_press_key', { key }),
  systemAction: (action: AndroidEmulatorSystemAction) =>
    invoke<void>('android_emulator_system_action', { action }),
  accessibilitySnapshot: () =>
    invoke<{ nodes: AndroidAccessibilityNode[] }>('android_emulator_accessibility_snapshot'),
  inspectPoint: (x: number, y: number) =>
    invoke<AndroidEmulatorElementHit | null>('android_emulator_inspect_point', { x, y }),
  captureScreen: () => invoke<AndroidEmulatorMediaFile>('android_emulator_capture_screen'),
  recordingStart: () => invoke<void>('android_emulator_recording_start'),
  recordingStop: () => invoke<AndroidEmulatorMediaFile>('android_emulator_recording_stop'),
  onFrame: (handler: (frame: AndroidEmulatorFrame) => void): Promise<UnlistenFn> =>
    listenInTauri<AndroidEmulatorFrame>('android-emulator:frame', handler),
  onLifecycle: (handler: (event: AndroidEmulatorLifecycleEvent) => void): Promise<UnlistenFn> =>
    listenInTauri<AndroidEmulatorLifecycleEvent>('android-emulator:lifecycle', handler),
  onError: (handler: (error: AndroidEmulatorError) => void): Promise<UnlistenFn> =>
    listenInTauri<AndroidEmulatorError>('android-emulator:error', handler),
  onPresence: (handler: (presence: AndroidEmulatorPresenceEvent) => void): Promise<UnlistenFn> =>
    listenInTauri<AndroidEmulatorPresenceEvent>('android-emulator:presence', handler),
  onOpenRequested: (
    handler: (presence?: AndroidEmulatorPresenceEvent | null) => void,
  ): Promise<UnlistenFn> =>
    listenInTauri<AndroidEmulatorPresenceEvent | null>('android-emulator:open-requested', handler),
  onSetupProgress: (handler: (progress: AndroidEmulatorSetupProgress) => void): Promise<UnlistenFn> =>
    listenInTauri<AndroidEmulatorSetupProgress>('android-emulator:setup-progress', handler),
  onSetupDone: (handler: (done: AndroidEmulatorSetupDone) => void): Promise<UnlistenFn> =>
    listenInTauri<AndroidEmulatorSetupDone>('android-emulator:setup-done', handler),
}
