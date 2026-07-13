/**
 * verboo-bridge.ts — Tauri shim for window.verboo
 *
 * Replaces Electron's contextBridge preload by implementing the exact same
 * VerbooDesktopApi over Tauri invoke()/listen(). Imported as first line of
 * main.tsx so window.verboo exists before React mounts.
 *
 * The renderer (React + CSS + i18n) stays byte-identical to the Electron build.
 * All Electron↔Tauri differences are confined to this single file.
 *
 * @see plans/03-contrato-ipc.md — the exact 47+6 contract
 */

import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import type {
  AgentEvent,
  AgentTurnRequest,
  AppConfig,
  AttachmentMeta,
  CliAuthStatus,
  ComputerUseAllowlistEntry,
  ComputerUseScope,
  CredentialStatus,
  FeedbackRequest,
  FeedbackResult,
  FileDiff,
  FileDiffStatus,
  GoalEvaluationInput,
  GoalEvaluationResult,
  LocalTerminalSession,
  LocalTerminalStartRequest,
  LoginResult,
  MenuBarState,
  ModelDiscoveryResult,
  ProfileResult,
  ProjectInstructionFile,
  ProjectInstructionReadResult,
  ResearchSubagentResult,
  ResearchSubagentsRunRequest,
  SkillSummary,
  TerminalDataEvent,
  UpdateSnapshot,
  UserSettings,
  VisionFallbackConsent,
  VisionFallbackState,
  WorkspaceBranchInfo,
  WorkspaceBranchSwitchResult,
  WorkspaceChangeSummary,
  WorkspaceCommitResult,
  WorkspacePullRequestResult,
  WorkspacePushResult,
  WorkspaceReviewMetadata,
} from '../shared/types'

// ── Computer Use wire types (mirror Rust src/models/computer_use.rs) ──
// Rust Session/ConsentRequest have different field names than the renderer's
// convenience shape (e.g. `state` not `status`, `started_at_wall` not
// `startedAt`, no `appName`/`isSelfTest`/`lastAction`/`actionCount`).
// The store translates these to the renderer shape after invoke.

export type RustSessionState = 'idle' | 'consent' | 'active' | 'paused' | 'stopped'

export type RustConsentRequest = {
  id: string
  goal: string
  app: string | null
  scope: ComputerUseScope
  created_at_mono: number
  created_at_wall: number
}

export type RustSession = {
  id: string
  state: RustSessionState
  goal: string
  target_app: string | null
  scope: ComputerUseScope
  allowlist_version: number
  self_test_enabled: boolean
  screenshot_attach_to_llm: boolean
  pid_lock: number
  started_at_mono: number
  started_at_wall: number
  last_activity_mono: number
  idle_timeout_secs: number
}

export type RustStopReason = 'user_cancelled' | 'emergency'

export type ComputerUseApp = {
  bundleId: string
  name: string
  pid: number
  isFrontmost: boolean
}

export type ComputerUsePermissions = {
  accessibility: 'granted' | 'missing'
  screenRecording: 'granted' | 'missing'
}

// ── Helper: subscribe to Tauri event, returns cleanup fn ────────
function onEvent<T>(channel: string, cb: (payload: T) => void): () => void {
  let unlisten: (() => void) | undefined
  let alive = true
  listen<T>(channel, (e) => cb(e.payload)).then((f) => {
    if (alive) unlisten = f
    else f()
  })
  return () => {
    alive = false
    unlisten?.()
  }
}

// ── Drag-drop cache ─────────────────────────────────────────────
// Tauri's WebView has onDragDropEvent; we cache the last dropped paths
// so inspectDroppedFiles() can consume them (matching Electron webUtils).
// NOTE: the 'over' variant has no `paths` — only 'drop' and 'enter' do.
let _droppedPaths: string[] = []

// ── Tauri-only guard (P1) ───────────────────────────────────────
// In Electron, `__TAURI_INTERNALS__` is absent — the shim must be a no-op
// so it doesn't overwrite the preload's `window.verboo` or call missing APIs.
const IS_TAURI =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

if (IS_TAURI) {
  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'drop' || event.payload.type === 'enter') {
      _droppedPaths = event.payload.paths ?? []
    } else if (event.payload.type === 'leave') {
      _droppedPaths = []
    }
    // Dispatch DOM events so React (Composer) can control the drop overlay
    // and handle the drop without importing @tauri-apps/webview directly.
    window.dispatchEvent(new CustomEvent('verboo:drag-event', {
      detail: {
        type: event.payload.type,
        paths: event.payload.type === 'drop' || event.payload.type === 'enter'
          ? (event.payload.paths ?? [])
          : [],
      },
    }))
  })
}


// ── The API object (matches preload/index.ts VerbooDesktopApi) ──
const api = {
  // ── Config ──────────────────────────────────────────────────
  getConfig: () => invoke<AppConfig>('get_config'),

  // ── Auth ────────────────────────────────────────────────────
  startCliLogin: () => invoke<LoginResult>('start_cli_login'),
  getCliAuthStatus: () => invoke<CliAuthStatus>('get_cli_auth_status'),
  logout: () => invoke<LoginResult>('logout'),
  openDashboard: () => invoke<boolean>('open_dashboard'),
  openSubscriptions: () => invoke<boolean>('open_subscriptions'),
  openSignup: () => invoke<boolean>('open_signup'),

  // ── Credentials ─────────────────────────────────────────────
  getCredentialStatus: () => invoke<CredentialStatus>('get_credential_status'),
  setApiKey: (apiKey: string) => invoke<CredentialStatus>('set_api_key', { apiKey }),
  clearApiKey: () => invoke<CredentialStatus>('clear_api_key'),

  // ── Models ──────────────────────────────────────────────────
  listModels: (forceRefresh = false) =>
    invoke<ModelDiscoveryResult>('list_models', { forceRefresh }),

  // ── Profile ─────────────────────────────────────────────────
  getProfile: () => invoke<ProfileResult>('get_profile'),

  // ── Feedback ────────────────────────────────────────────────
  sendFeedback: (request: FeedbackRequest) =>
    invoke<FeedbackResult>('send_feedback', { request }),

  // ── Settings ────────────────────────────────────────────────
  getUserSettings: () => invoke<UserSettings>('get_user_settings'),
  updateUserSettings: (patch: Partial<UserSettings>) =>
    invoke<UserSettings>('update_user_settings', { patch }),
  resetUserSettings: () => invoke<UserSettings>('reset_user_settings'),

  // ── Vision fallback (FASE 1) ───────────────────────────────────
  // Returns current consent + preview of which model would be picked.
  getVisionFallbackState: () =>
    invoke<VisionFallbackState>('get_vision_fallback_state'),
  // Sets consent (always/ask/never). Zelda's UI calls this on toggle.
  setVisionFallbackConsent: (consent: VisionFallbackConsent) =>
    invoke<UserSettings>('set_vision_fallback_consent', { consent }),

  // ── Menu bar ────────────────────────────────────────────────
  updateMenuBar: (state: Partial<MenuBarState>) =>
    invoke<boolean>('update_menu_bar', { state }),
  // Force the tray to idle — called on turn done/error/abort so a lagging
  // 'thinking' event (or the heartbeat re-pushing a stale ref) can never
  // resurrect a completed turn's timer.
  forceIdleMenuBar: () => invoke<boolean>('force_idle_menu_bar'),
  // Heartbeat query — returns the current execution state so the renderer
  // can stop re-pushing a stale menuBarStateRef every 2.5s. If the state has
  // been active for >5min without a renderer push, Rust auto-resets to idle.
  heartbeatMenuBar: () => invoke<string>('heartbeat_menu_bar'),

  // ── Window ──────────────────────────────────────────────────
  // Tauri's bundled drag.js (auto-injected when data-tauri-drag-region is
  // present) already toggles maximize on titlebar double-click via the
  // native `plugin:window|internal_toggle_maximize`. Invoking our own
  // `toggle_window_zoom` command on top of it would fire two handlers for
  // the same gesture and corrupt the window frame. Intentional no-op on
  // the Tauri path; the Electron preload still owns its own handler.
  toggleWindowZoom: () => Promise.resolve(true),

  // ── Skills ──────────────────────────────────────────────────
  listSkills: (workingDirectory: string) =>
    invoke<SkillSummary[]>('list_skills', { workingDirectory }),
  openUserSkillsFolder: () => invoke<string>('open_user_skills_folder'),
  // Skill approval gating (item 1.8): returns untrusted skills that need
  // approval before injection. If non-empty, renderer shows the permission
  // panel for each. Reuses the existing PermissionApprovalPanel.
  checkSkillApproval: (skills: SkillSummary[]) =>
    invoke<SkillSummary[]>('check_skill_approval', { skills }),
  // Persists "Always Allow" for an untrusted skill path.
  approveSkill: (path: string) =>
    invoke<UserSettings>('approve_skill', { path }),
  // Fires an OS notification when a background turn completes. Called in
  // the `done`/`error` handler when the conversation is not active or the
  // window is not focused. Returns true if a notification was shown.
  fireCompletionNotification: (
    exitCode: number,
    conversationId: string,
    isActiveConversation: boolean,
  ) =>
    invoke<boolean>('fire_completion_notification', {
      exitCode,
      conversationId,
      isActiveConversation,
    }),

  // ── Notification actions ────────────────────────────────────
  // Geralt: in fire_completion_notification, use `app_handle.emit("notification-clicked", conversationId)`
  // on click. The renderer listens via `listenForNotificationClick` and focuses the conversation.
  listenForNotificationClick: (handler: (conversationId: string) => void) =>
    listen<string>('notification-clicked', event => handler(event.payload)),
  getDefaultWorkingDirectory: () => invoke<string>('get_default_working_directory'),
  getBundledCliVersion: () => invoke<string>('get_bundled_cli_version'),

  // ── Workspace ───────────────────────────────────────────────
  getWorkspaceChanges: (workingDirectory: string) =>
    invoke<WorkspaceChangeSummary>('get_workspace_changes', { workingDirectory }),
  getWorkspaceBranches: (workingDirectory: string) =>
    invoke<WorkspaceBranchInfo>('get_workspace_branches', { workingDirectory }),
  switchWorkspaceBranch: (workingDirectory: string, branchName: string) =>
    invoke<WorkspaceBranchSwitchResult>('switch_workspace_branch', {
      workingDirectory,
      branchName,
    }),
  commitWorkspaceChanges: (workingDirectory: string, message: string) =>
    invoke<WorkspaceCommitResult>('commit_workspace_changes', { workingDirectory, message }),
  createWorkspacePullRequest: (workingDirectory: string, title: string, body?: string) =>
    invoke<WorkspacePullRequestResult>('create_workspace_pull_request', {
      workingDirectory,
      title,
      body,
    }),
  pushWorkspaceChanges: (workingDirectory: string) =>
    invoke<WorkspacePushResult>('push_workspace_changes', { workingDirectory }),

  // ── Stale file detector (Multichat Fase A) ──────────────────
  recordFileRead: (conversationId: string, filePath: string) =>
    invoke<void>('record_file_read', { conversationId, filePath }),
  recordFileWrite: (conversationId: string, filePath: string) =>
    invoke<void>('record_file_write', { conversationId, filePath }),
  listStaleFiles: (conversationId: string) =>
    invoke<string[]>('list_stale_files', { conversationId }),
  clearStaleFiles: (conversationId: string) =>
    invoke<void>('clear_stale_files', { conversationId }),

  evaluateGoal: (input: GoalEvaluationInput) =>
    invoke<{ evaluation: GoalEvaluationResult; userMessage?: string }>('evaluate_goal', { input }),

  // ── @-mention file listing (quick-win #1) ──────────────────
  // Returns RELATIVE paths (POSIX, sorted, cap 5000) for the given
  // working_directory. Uses `git ls-files` when the workspace is a git
  // repo (respects .gitignore); bounded walk otherwise.
  listWorkspaceFiles: (workingDirectory: string) =>
    invoke<string[]>('list_workspace_files', { workingDirectory }),

  // ── Project instructions (QW2) ──────────────────────────────
  listProjectInstructionFiles: (workingDirectory: string) =>
    invoke<ProjectInstructionFile[]>('list_project_instruction_files', { workingDirectory }),
  readProjectInstructionFile: (workingDirectory: string, name: ProjectInstructionFile['name']) =>
    invoke<ProjectInstructionReadResult>('read_project_instruction_file', {
      workingDirectory,
      name,
    }),
  writeProjectInstructionFile: (
    workingDirectory: string,
    name: ProjectInstructionFile['name'],
    content: string,
  ) => invoke<void>('write_project_instruction_file', { workingDirectory, name, content }),

  // ── Files ───────────────────────────────────────────────────
  pickFiles: () => invoke<AttachmentMeta[]>('pick_files'),
  inspectFiles: (paths: string[]) => invoke<AttachmentMeta[]>('inspect_files', { paths }),
  inspectDroppedFiles: (_files: File[]) => {
    // Tauri has no webUtils.getPathForFile; consume cached drop paths instead
    const paths = _droppedPaths
    _droppedPaths = []
    return invoke<AttachmentMeta[]>('inspect_files', { paths })
  },
  // Paste a raw image blob (screenshot) from clipboard. Reads base64 data,
  // writes it to a temp file via the backend, returns an AttachmentMeta.
  // Backend command may not be available yet — returns empty gracefully.
  pasteImageBlob: async (base64: string, filename: string): Promise<AttachmentMeta[]> => {
    try {
      return await invoke<AttachmentMeta[]>('inspect_pasted_image', { base64, filename })
    } catch {
      console.warn('paste blob not yet supported — backend command inspect_pasted_image not registered')
      return []
    }
  },
  pickFolder: () => invoke<string | undefined>('pick_folder'),
  // Convert a local file path to a webview-accessible URL for <img> src.
  fileUrl: (path: string) => convertFileSrc(path),
  createProjectFolder: () => invoke<string | undefined>('create_project_folder'),
  // Save an avatar image (base64) to the app data dir. Returns the absolute
  // path of the saved file. Accepted MIME: image/png, image/jpeg, image/webp.
  // Max 10MB. Old avatars with different extensions are removed.
  saveAvatarBlob: (base64: string, mime: string) =>
    invoke<string>('save_avatar_blob', { base64, mime }),

  // ── Agent ───────────────────────────────────────────────────
  sendTurn: (request: AgentTurnRequest, resumeSessionId?: string) =>
    invoke<string>('send_turn', { request, resumeSessionId }),
  runResearchSubagents: (request: ResearchSubagentsRunRequest) =>
    invoke<ResearchSubagentResult[]>('run_research_subagents', { request }),
  cancelResearchSubagents: (runId: string) =>
    invoke<boolean>('cancel_research_subagents', { runId }),
  interrupt: (conversationId?: string) =>
    invoke<boolean>('interrupt', { conversationId }),

  // ── Agent events ────────────────────────────────────────────
  onAgentEvent: (callback: (event: AgentEvent) => void) =>
    onEvent<AgentEvent>('agent:event', callback),
  onRefreshDataRequest: (callback: () => void) =>
    onEvent<void>('app:refresh-data', callback),

  // ── Updates ─────────────────────────────────────────────────
  getUpdateStatus: () => invoke<UpdateSnapshot>('get_update_status'),
  checkForUpdates: (userInitiated = false) =>
    invoke<UpdateSnapshot>('check_for_updates', { userInitiated }),
  downloadUpdate: () => invoke<UpdateSnapshot>('download_update'),
  installUpdate: () => invoke<boolean>('install_update'),
  onUpdateStatus: (callback: (snapshot: UpdateSnapshot) => void) =>
    onEvent<UpdateSnapshot>('updates:status', callback),

  // ── Terminal ────────────────────────────────────────────────
  terminalStart: (request: LocalTerminalStartRequest) =>
    invoke<LocalTerminalSession>('terminal_start', { request }),
  terminalWrite: (sessionId: string, data: string) =>
    invoke<boolean>('terminal_write', { sessionId, data }),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    invoke<boolean>('terminal_resize', { sessionId, cols, rows }),
  terminalStop: (sessionId: string) =>
    invoke<boolean>('terminal_stop', { sessionId }),
  terminalGetState: () =>
    invoke<LocalTerminalSession | undefined>('terminal_get_state'),

  // ── Clipboard ───────────────────────────────────────────────
  clipboardReadText: () => invoke<string>('clipboard_read_text'),
  clipboardWriteText: (text: string) =>
    invoke<boolean>('clipboard_write_text', { text }),

  // ── Workspace review ────────────────────────────────────────
  getWorkspaceReviewMetadata: (workingDirectory: string) =>
    invoke<WorkspaceReviewMetadata>('get_workspace_review_metadata', { workingDirectory }),
  getFileDiff: (workingDirectory: string, filePath: string, status: FileDiffStatus) =>
    invoke<FileDiff>('get_file_diff', { workingDirectory, filePath, status }),
  revertFile: (workingDirectory: string, filePath: string) =>
    invoke<{ ok: boolean; message?: string }>('revert_file', { workingDirectory, filePath }),
  openExternalFile: (workingDirectory: string, filePath: string) =>
    invoke<{ ok: boolean; message?: string }>('open_external_file', { workingDirectory, filePath }),

  // ── Terminal events ─────────────────────────────────────────
  onTerminalData: (callback: (event: TerminalDataEvent) => void) =>
    onEvent<TerminalDataEvent>('terminal:data', callback),
  onTerminalExit: (callback: (event: { sessionId: string }) => void) =>
    onEvent<{ sessionId: string }>('terminal:exit', callback),
  onTerminalError: (callback: (event: { sessionId: string; error: string }) => void) =>
    onEvent<{ sessionId: string; error: string }>('terminal:error', callback),

  // ── Computer Use allowlist (Kratos P0.4) ────────────────────
  // Returns the persisted allowlist. Renderer calls on Settings mount and
  // after every mutation. Entries are keyed by bundleId.
  getComputerUseAllowlist: () =>
    invoke<ComputerUseAllowlistEntry[]>('get_computer_use_allowlist'),
  // Upserts an entry. If bundleId already exists, scope is updated.
  // Returns the full updated UserSettings (Rust shape).
  updateComputerUseAllowlist: (entry: ComputerUseAllowlistEntry) =>
    invoke<UserSettings>('update_computer_use_allowlist', { entry }),
  // Removes an entry by bundleId. Returns full updated UserSettings.
  removeComputerUseAllowlist: (bundleId: string) =>
    invoke<UserSettings>('remove_computer_use_allowlist', { bundleId }),

  // ── Computer Use session IPC (Geralt P0.2/P0.3) ────────────
  // Step 1: create a pending consent request. Returns the request (with ID).
  // Session is NOT active yet — user must call grantComputerUseSession.
  requestComputerUseSession: (goal: string, app: string | null, scope: ComputerUseScope) =>
    invoke<RustConsentRequest>('request_computer_use_session', { goal, app, scope }),
  // Step 2: user grants consent. Returns the active session.
  // screenshotAttachToLlm controls whether screenshots are sent to the model.
  grantComputerUseSession: (requestId: string, screenshotAttachToLlm: boolean) =>
    invoke<RustSession>('grant_computer_use_session', {
      requestId,
      screenshotAttachToLlm,
    }),
  // Bind a concrete app onto a goal-directed (unbound) active session.
  bindComputerUseTarget: (sessionId: string, bundleId: string) =>
    invoke<RustSession>('bind_computer_use_target', { sessionId, bundleId }),
  // Deny a pending consent request. Always UserDenied reason on Rust side.
  denyComputerUseSession: (requestId: string) =>
    invoke<void>('deny_computer_use_session', { requestId }),
  // Stop an active session. reason: 'user_cancelled' | 'emergency' | other.
  stopComputerUseSession: (sessionId: string, reason: RustStopReason) =>
    invoke<void>('stop_computer_use_session', { sessionId, reason }),
  pauseComputerUseSession: (sessionId: string) =>
    invoke<RustSession>('pause_computer_use_session', { sessionId }),
  resumeComputerUseSession: (sessionId: string) =>
    invoke<RustSession>('resume_computer_use_session', { sessionId }),
  // List running apps (requires active session). Returns null if no session.
  listApps: () =>
    invoke<unknown>('list_apps'),
  listComputerUseApps: () =>
    invoke<ComputerUseApp[]>('list_computer_use_apps'),
  resolveComputerUseApp: (selector: string) =>
    invoke<{ bundleId: string; name: string; running: boolean }>('resolve_computer_use_app', { selector }),
  getComputerUsePermissions: () =>
    invoke<ComputerUsePermissions>('get_computer_use_permissions'),
  requestComputerUsePermissions: () =>
    invoke<ComputerUsePermissions>('request_computer_use_permissions'),
  openComputerUsePermissionSettings: (kind: 'accessibility' | 'screenRecording') =>
    invoke<void>('open_computer_use_permission_settings', { kind }),

  // ── Computer Use events (Geralt — not yet wired on Rust side) ──
  // When Geralt adds emit() calls, these listeners will fire. Until then,
  // the store drives state via invoke responses. Hooks attach unconditionally;
  // no-op if Rust doesn't emit.
  onComputerUseStateChange: (callback: (session: RustSession) => void) =>
    onEvent<RustSession>('computer-use:state-change', callback),
  onComputerUseAction: (callback: (action: unknown) => void) =>
    onEvent<unknown>('computer-use:action', callback),
  onComputerUseEmergencyStop: (callback: () => void) =>
    onEvent<void>('computer-use:emergency-stop', callback),
  onComputerUseTurnComplete: (callback: () => void) =>
    onEvent<void>('computer-use:turn-complete', callback),
  onComputerUseCleanupFailed: (callback: (message: string) => void) =>
    onEvent<string>('computer-use:cleanup-failed', callback),
}

// ── Expose on window (Tauri only) ──────────────────────────────
// In Electron, the preload script owns `window.verboo` — don't overwrite it.
if (IS_TAURI) {
  ;(window as unknown as Record<string, unknown>).verboo = api
}

export type VerbooDesktopApi = typeof api
