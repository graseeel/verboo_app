import { contextBridge, ipcRenderer } from 'electron'
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
  UserSettings,
  WorkspaceBranchInfo,
  WorkspaceBranchSwitchResult,
  WorkspaceChangeSummary,
  WorkspaceReviewMetadata,
} from '../shared/types'

const api = {
  getConfig: () => ipcRenderer.invoke('config:get') as Promise<AppConfig>,
  startCliLogin: () => ipcRenderer.invoke('auth:start-cli-login') as Promise<LoginResult>,
  getCliAuthStatus: () => ipcRenderer.invoke('auth:cli-status') as Promise<CliAuthStatus>,
  logout: () => ipcRenderer.invoke('auth:logout') as Promise<LoginResult>,
  openDashboard: () => ipcRenderer.invoke('auth:open-dashboard') as Promise<boolean>,
  openSubscriptions: () => ipcRenderer.invoke('auth:open-subscriptions') as Promise<boolean>,
  openSignup: () => ipcRenderer.invoke('auth:open-signup') as Promise<boolean>,
  getCredentialStatus: () => ipcRenderer.invoke('credentials:status') as Promise<CredentialStatus>,
  setApiKey: (apiKey: string) => ipcRenderer.invoke('credentials:set-api-key', apiKey) as Promise<CredentialStatus>,
  clearApiKey: () => ipcRenderer.invoke('credentials:clear-api-key') as Promise<CredentialStatus>,
  listModels: (forceRefresh = false) => ipcRenderer.invoke('models:list', forceRefresh) as Promise<ModelDiscoveryResult>,
  getProfile: () => ipcRenderer.invoke('profile:get') as Promise<ProfileResult>,
  sendFeedback: (request: FeedbackRequest) => ipcRenderer.invoke('feedback:send', request) as Promise<FeedbackResult>,
  getUserSettings: () => ipcRenderer.invoke('settings:get') as Promise<UserSettings>,
  updateUserSettings: (patch: Partial<UserSettings>) => ipcRenderer.invoke('settings:update', patch) as Promise<UserSettings>,
  resetUserSettings: () => ipcRenderer.invoke('settings:reset') as Promise<UserSettings>,
  updateMenuBar: (state: Partial<MenuBarState>) => ipcRenderer.invoke('menu-bar:update', state) as Promise<boolean>,
  toggleWindowZoom: () => ipcRenderer.invoke('window:toggle-zoom') as Promise<boolean>,
  listSkills: (workingDirectory: string) => ipcRenderer.invoke('skills:list', workingDirectory) as Promise<SkillSummary[]>,
  openUserSkillsFolder: () => ipcRenderer.invoke('skills:open-user-folder') as Promise<string>,
  getWorkspaceChanges: (workingDirectory: string) => ipcRenderer.invoke('workspace:changes', workingDirectory) as Promise<WorkspaceChangeSummary>,
  getWorkspaceBranches: (workingDirectory: string) =>
    ipcRenderer.invoke('workspace:branches', workingDirectory) as Promise<WorkspaceBranchInfo>,
  switchWorkspaceBranch: (workingDirectory: string, branchName: string) =>
    ipcRenderer.invoke('workspace:switch-branch', workingDirectory, branchName) as Promise<WorkspaceBranchSwitchResult>,
  evaluateGoal: (input: GoalEvaluationInput) => ipcRenderer.invoke('goal:evaluate', input) as Promise<{ evaluation: GoalEvaluationResult; userMessage?: string }>,
  pickFiles: () => ipcRenderer.invoke('files:pick') as Promise<AttachmentMeta[]>,
  pickFolder: () => ipcRenderer.invoke('files:pick-folder') as Promise<string | undefined>,
  createProjectFolder: () => ipcRenderer.invoke('files:create-project-folder') as Promise<string | undefined>,
  sendTurn: (request: AgentTurnRequest, resumeSessionId?: string) => ipcRenderer.invoke('agent:send', request, resumeSessionId) as Promise<string>,
  runResearchSubagents: (request: ResearchSubagentsRunRequest) => ipcRenderer.invoke('research-subagents:run', request) as Promise<ResearchSubagentResult[]>,
  cancelResearchSubagents: (runId: string) => ipcRenderer.invoke('research-subagents:cancel', runId) as Promise<boolean>,
  interrupt: () => ipcRenderer.invoke('agent:interrupt') as Promise<boolean>,
  onAgentEvent: (callback: (event: AgentEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => callback(payload)
    ipcRenderer.on('agent:event', listener)
    return () => {
      ipcRenderer.removeListener('agent:event', listener)
    }
  },
  onRefreshDataRequest: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('app:refresh-data', listener)
    return () => {
      ipcRenderer.removeListener('app:refresh-data', listener)
    }
  },

  // ── Terminal API ──────────────────────────────────────────────

  terminalStart: (request: LocalTerminalStartRequest) => ipcRenderer.invoke('terminal:start', request) as Promise<LocalTerminalSession>,
  terminalWrite: (sessionId: string, data: string) => ipcRenderer.invoke('terminal:write', sessionId, data) as Promise<boolean>,
  terminalResize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', sessionId, cols, rows) as Promise<boolean>,
  terminalStop: (sessionId: string) => ipcRenderer.invoke('terminal:stop', sessionId) as Promise<boolean>,
  terminalGetState: () => ipcRenderer.invoke('terminal:get-state') as Promise<LocalTerminalSession | undefined>,
  clipboardReadText: () => ipcRenderer.invoke('clipboard:read-text') as Promise<string>,
  clipboardWriteText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text) as Promise<boolean>,

  getWorkspaceReviewMetadata: (workingDirectory: string) =>
    ipcRenderer.invoke('workspace:review-metadata', workingDirectory) as Promise<WorkspaceReviewMetadata>,
  getFileDiff: (workingDirectory: string, filePath: string, status: FileDiffStatus) =>
    ipcRenderer.invoke('workspace:file-diff', workingDirectory, filePath, status) as Promise<FileDiff>,
  revertFile: (workingDirectory: string, filePath: string) =>
    ipcRenderer.invoke('workspace:revert-file', workingDirectory, filePath) as Promise<{ ok: boolean; message?: string }>,
  openExternalFile: (workingDirectory: string, filePath: string) =>
    ipcRenderer.invoke('workspace:open-external', workingDirectory, filePath) as Promise<{ ok: boolean; message?: string }>,

  onTerminalData: (callback: (event: TerminalDataEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) => callback(payload)
    ipcRenderer.on('terminal:data', listener)
    return () => {
      ipcRenderer.removeListener('terminal:data', listener)
    }
  },

  onTerminalExit: (callback: (event: { sessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string }) => callback(payload)
    ipcRenderer.on('terminal:exit', listener)
    return () => {
      ipcRenderer.removeListener('terminal:exit', listener)
    }
  },

  onTerminalError: (callback: (event: { sessionId: string; error: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; error: string }) => callback(payload)
    ipcRenderer.on('terminal:error', listener)
    return () => {
      ipcRenderer.removeListener('terminal:error', listener)
    }
  },
}

contextBridge.exposeInMainWorld('verboo', api)

export type VerbooDesktopApi = typeof api
