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
  ChromeIntegrationRequest,
  ChromeIntegrationStatus,
  ChromeConnectionTestResult,
  CredentialStatus,
  FeedbackRequest,
  FeedbackResult,
  FileDiff,
  FileDiffStatus,
  GoalEvaluationInput,
  GoalEvaluationResult,
  GoalEvaluationEnvelope,
  InstallUpdateResult,
  LocalTerminalSession,
  LocalTerminalStartRequest,
  LoginResult,
  MenuBarState,
  ModelDiscoveryResult,
  ProfileResult,
  ProjectInstructionFile,
  ProjectInstructionReadResult,
  ProviderAuthStatus,
  ProviderAccountSummary,
  ProviderCapabilities,
  ProviderUsageResult,
  ExternalProviderId,
  ProviderLoginEvent,
  ResearchSubagentResult,
  ResearchSubagentsRunRequest,
  SkillSummary,
  TerminalDataEvent,
  UpdateSnapshot,
  UserSettings,
  VerbooModel,
  VideoComponentState,
  VideoOcrRequest,
  VideoOcrText,
  VideoTranscriberProgress,
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

import type {
  Marketplace,
  MarketplaceManifestMap,
  MutationResult,
  Plugin,
  PluginAvailablePayload,
  PluginDetail,
  PluginIconResult,
  PluginScope,
  PluginSkill,
  PluginValidateResult,
} from '../shared/plugins'

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

  // ── Providers (F4; comandos registrados em lib.rs:2382-2385) ──
  providerAuthStatus: () => invoke<ProviderAuthStatus[]>('provider_auth_status'),
  providerLoginStart: (provider: string, reconnectAccountId?: string) =>
    invoke<string>('provider_login_start', { provider, reconnectAccountId }),
  providerLoginConfirmRisk: (provider: string) => invoke<void>('provider_login_confirm_risk', { provider }),
  providerLoginCancel: () => invoke<void>('provider_login_cancel'),
  providerCapabilities: () => invoke<ProviderCapabilities>('provider_capabilities'),
  providerAccountsList: () => invoke<ProviderAccountSummary[]>('provider_accounts_list'),
  providerAccountsUsage: (provider: ExternalProviderId, accountId: string) =>
    invoke<ProviderUsageResult[]>('provider_accounts_usage', { provider, accountId }),
  providerAccountModels: (provider: ExternalProviderId, accountId: string) =>
    invoke<VerbooModel[]>('provider_account_models', { provider, accountId }),
  providerAccountSetDefault: (provider: ExternalProviderId, accountId: string) =>
    invoke<void>('provider_account_set_default', { provider, accountId }),
  providerAccountRemove: (provider: ExternalProviderId, accountId: string) =>
    invoke<void>('provider_account_remove', { provider, accountId }),
  onProviderLoginEvent: (handler: (event: ProviderLoginEvent) => void) =>
    onEvent<ProviderLoginEvent>('provider-login:event', handler),

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

  // ── Verboo in Chrome ────────────────────────────────────────
  chromeIntegrationStatus: () =>
    invoke<ChromeIntegrationStatus>('chrome_integration_status'),
  chromeIntegrationConfigure: (request: ChromeIntegrationRequest) =>
    invoke<ChromeIntegrationStatus>('chrome_integration_configure', { request }),
  chromeIntegrationRepair: (request: ChromeIntegrationRequest) =>
    invoke<ChromeIntegrationStatus>('chrome_integration_repair', { request }),
  chromeIntegrationTest: () => invoke<ChromeConnectionTestResult>('chrome_integration_test'),
  chromeIntegrationRemove: () =>
    invoke<ChromeIntegrationStatus>('chrome_integration_remove'),
  openChromeExtensionStore: () => invoke<boolean>('open_chrome_extension_store'),

  // ── Vision fallback (FASE 1) ───────────────────────────────────
  // Returns current consent + preview of which model would be picked.
  getVisionFallbackState: () =>
    invoke<VisionFallbackState>('get_vision_fallback_state'),
  // Sets consent (always/ask/never). Zelda's UI calls this on toggle.
  setVisionFallbackConsent: (consent: VisionFallbackConsent) =>
    invoke<UserSettings>('set_vision_fallback_consent', { consent }),

  // ── Video understanding ─────────────────────────────────────
  getVideoComponentState: () =>
    invoke<VideoComponentState>('get_video_component_state'),
  downloadVideoTranscriber: () =>
    invoke<void>('download_video_transcriber'),
  removeVideoTranscriber: () =>
    invoke<void>('remove_video_transcriber'),
  onVideoTranscriberProgress: (handler: (progress: VideoTranscriberProgress) => void) =>
    onEvent<VideoTranscriberProgress>('video-transcriber-progress', handler),
  onVideoOcrRequest: (handler: (request: VideoOcrRequest) => void) =>
    onEvent<VideoOcrRequest>('video:ocr-request', handler),
  // Frame bytes travel over IPC because neither Web Workers nor main-thread
  // fetch reliably reach the asset protocol for app-data files.
  readVideoFrame: (path: string) =>
    invoke<ArrayBuffer>('read_video_frame', { path }),
  completeVideoOcrBatch: (jobId: string, results: VideoOcrText[]) =>
    invoke<void>('complete_video_ocr_batch', { jobId, results }),

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
    invoke<GoalEvaluationEnvelope>('evaluate_goal', { input }),

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
  beginPastedFileUpload: (input: { name: string; size: number; mediaType: string }) =>
    invoke<{ uploadId: string }>('begin_pasted_file_upload', input),
  appendPastedFileChunk: (input: { uploadId: string; offset: number; bytes: number[] }) =>
    invoke<void>('append_pasted_file_chunk', input),
  finishPastedFileUpload: (input: { uploadId: string }) =>
    invoke<AttachmentMeta>('finish_pasted_file_upload', input),
  abortPastedFileUpload: (input: { uploadId: string }) =>
    invoke<void>('abort_pasted_file_upload', input),
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
  bootstrapCli: () => invoke<UpdateSnapshot>('bootstrap_cli'),
  checkForUpdates: (userInitiated = false) =>
    invoke<UpdateSnapshot>('check_for_updates', { userInitiated }),
  downloadUpdate: (userInitiated = true) =>
    invoke<UpdateSnapshot>('download_update', { userInitiated }),
  installUpdate: () => invoke<InstallUpdateResult>('install_update'),
  onUpdateStatus: (callback: (snapshot: UpdateSnapshot) => void) =>
    onEvent<UpdateSnapshot>('update:snapshot', callback),

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

  // ── Plugins (P5 / Wave 2 — spec docs/plugins-marketplace.md) ──
  // 11 wrappers. Reads (`pluginList`, `pluginAvailable`, `marketplaceList`,
  // `pluginValidate`) bypass the Rust auth gate; mutations are gated both
  // FE-side (via cliAuth) and Rust-side.
  pluginList: () => invoke<Plugin[]>('plugin_list'),
  pluginAvailable: () => invoke<PluginAvailablePayload>('plugin_available'),
  pluginInstall: (id: string, scope: PluginScope) =>
    invoke<MutationResult>('plugin_install', { id, scope }),
  pluginEnable: (id: string, scope?: PluginScope) =>
    invoke<MutationResult>('plugin_enable', { id, scope }),
  pluginDisable: (id: string, scope?: PluginScope) =>
    invoke<MutationResult>('plugin_disable', { id, scope }),
  pluginUninstall: (id: string, scope: PluginScope, keepData = false) =>
    invoke<MutationResult>('plugin_uninstall', { id, scope, keepData }),
  pluginUpdate: (id: string, scope: PluginScope) =>
    invoke<Plugin>('plugin_update', { id, scope }),
  pluginValidate: (path: string) =>
    invoke<PluginValidateResult>('plugin_validate', { path }),
  marketplaceList: () => invoke<Marketplace[]>('marketplace_list'),
  marketplaceAdd: (source: string, scope?: string) =>
    invoke<Marketplace>('marketplace_add', { source, scope }),
  marketplaceRemove: (name: string) =>
    invoke<void>('marketplace_remove', { name }),

  // ── Plugins — rich detail (Wave 2 P5+ — Codex parity) ──────────
  // These read on-disk manifests the CLI's `--available` JSON discards:
  // category, author, homepage, skills list, license, keywords.
  pluginDetail: (id: string) =>
    invoke<PluginDetail>('plugin_detail', { id }),
  pluginSkills: (id: string) =>
    invoke<PluginSkill[]>('plugin_skills', { id }),
  marketplaceManifests: () =>
    invoke<MarketplaceManifestMap>('marketplace_manifests'),

  // ── Plugins — icon fetch (P5.1 — on-demand, cached, privacy-gated) ──
  // Fetches the plugin's icon from its homepage domain (apple-touch-icon.png
  // → favicon.ico). HTTPS only, on-demand only. Returns a local file path
  // (use `convertFileSrc`) or null (FE renders monogram). Respects the
  // `loadWebIcons` user setting — if false, returns null without network.
  pluginIcon: (pluginId: string) =>
    invoke<PluginIconResult>('plugin_icon', { pluginId }),
}

// ── Expose on window (Tauri only) ──────────────────────────────
// In Electron, the preload script owns `window.verboo` — don't overwrite it.
if (IS_TAURI) {
  ;(window as unknown as Record<string, unknown>).verboo = api
}

export type VerbooDesktopApi = typeof api
