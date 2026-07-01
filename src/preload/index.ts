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
  GoalEvaluationInput,
  GoalEvaluationResult,
  LoginResult,
  MenuBarState,
  ModelDiscoveryResult,
  ProfileResult,
  SkillSummary,
  UserSettings,
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
  evaluateGoal: (input: GoalEvaluationInput) => ipcRenderer.invoke('goal:evaluate', input) as Promise<{ evaluation: GoalEvaluationResult; userMessage?: string }>,
  pickFiles: () => ipcRenderer.invoke('files:pick') as Promise<AttachmentMeta[]>,
  pickFolder: () => ipcRenderer.invoke('files:pick-folder') as Promise<string | undefined>,
  createProjectFolder: () => ipcRenderer.invoke('files:create-project-folder') as Promise<string | undefined>,
  sendTurn: (request: AgentTurnRequest, resumeSessionId?: string) => ipcRenderer.invoke('agent:send', request, resumeSessionId) as Promise<string>,
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
}

contextBridge.exposeInMainWorld('verboo', api)

export type VerbooDesktopApi = typeof api
