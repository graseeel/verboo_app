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

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import type {
  AgentEvent,
  AgentTurnRequest,
  AppConfig,
  AttachmentMeta,
  CliAuthStatus,
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
  ResearchSubagentResult,
  ResearchSubagentsRunRequest,
  SkillSummary,
  TerminalDataEvent,
  UpdateSnapshot,
  UserSettings,
  WorkspaceBranchInfo,
  WorkspaceBranchSwitchResult,
  WorkspaceChangeSummary,
  WorkspaceReviewMetadata,
} from '../shared/types'

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
let _droppedPaths: string[] = []

void getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type === 'drop' || event.payload.type === 'over') {
    _droppedPaths = event.payload.paths ?? []
  } else if (event.payload.type === 'leave') {
    _droppedPaths = []
  }
})

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

  // ── Menu bar ────────────────────────────────────────────────
  updateMenuBar: (state: Partial<MenuBarState>) =>
    invoke<boolean>('update_menu_bar', { state }),

  // ── Window ──────────────────────────────────────────────────
  toggleWindowZoom: () => invoke<boolean>('toggle_window_zoom'),

  // ── Skills ──────────────────────────────────────────────────
  listSkills: (workingDirectory: string) =>
    invoke<SkillSummary[]>('list_skills', { workingDirectory }),
  openUserSkillsFolder: () => invoke<string>('open_user_skills_folder'),

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
  evaluateGoal: (input: GoalEvaluationInput) =>
    invoke<{ evaluation: GoalEvaluationResult; userMessage?: string }>('evaluate_goal', { input }),

  // ── Files ───────────────────────────────────────────────────
  pickFiles: () => invoke<AttachmentMeta[]>('pick_files'),
  inspectFiles: (paths: string[]) => invoke<AttachmentMeta[]>('inspect_files', { paths }),
  inspectDroppedFiles: (_files: File[]) => {
    // Tauri has no webUtils.getPathForFile; consume cached drop paths instead
    const paths = _droppedPaths
    _droppedPaths = []
    return invoke<AttachmentMeta[]>('inspect_files', { paths })
  },
  pickFolder: () => invoke<string | undefined>('pick_folder'),
  createProjectFolder: () => invoke<string | undefined>('create_project_folder'),

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
}

// ── Expose on window ───────────────────────────────────────────
;(window as unknown as Record<string, unknown>).verboo = api

export type VerbooDesktopApi = typeof api
