import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccessMode, AgentEvent, AgentTurnRequest, AppConfig, FeedbackRequest, GoalEvaluationInput, GoalEvaluationResult, MenuBarState, ResearchSubagentsRunRequest, UserSettings } from '../shared/types'
import { LocalTerminalService } from './services/localTerminalService'
import type { LocalTerminalStartRequest } from '../shared/types'
import { accessModeConfig } from './security/accessModes'
import { inspectAttachments } from './services/attachmentService'
import { CredentialsStore } from './services/credentialsStore'
import { FeedbackService } from './services/feedbackService'
import { ModelService } from './services/modelService'
import { ProfileService } from './services/profileService'
import { ResearchSubagentService } from './services/researchSubagentService'
import { createAgentRuntime } from './runtime/runtimeFactory'
import { VerbooApiClient } from './services/verbooApiClient'
import { defaultUserSettings, SettingsService } from './services/settingsService'
import { SkillsService } from './services/skillsService'
import { TrayStatusService } from './services/trayStatusService'
import { VisionFallbackService } from './services/visionFallbackService'
import { readWorkspaceChangeSummary, readWorkspaceReviewMetadata } from './services/workspaceChangeService'
import { readFileDiff, resolveRepoRoot, resolveSafePath, revertFile } from './services/fileReviewService'
import type { FileDiffStatus } from '../shared/types'

const credentials = new CredentialsStore()
const apiClient = new VerbooApiClient(credentials)
const models = new ModelService(apiClient)
const profile = new ProfileService(apiClient)
const feedback = new FeedbackService()
const userSettings = new SettingsService()
const skills = new SkillsService()
const agentRuntime = createAgentRuntime({ credentials, modelService: models })
const researchSubagents = new ResearchSubagentService(() => agentRuntime.createTurnExecutor())
const visionFallback = new VisionFallbackService(models)
const terminalService = new LocalTerminalService()
terminalService.setHandlers({
  onData: (sessionId, data) => {
    sendToRenderer('terminal:data', { sessionId, data })
  },
  onExit: (sessionId) => {
    sendToRenderer('terminal:exit', { sessionId })
  },
  onError: (sessionId, error) => {
    sendToRenderer('terminal:error', { sessionId, error })
  },
})

const trayStatus = new TrayStatusService({
  getWindow: () => mainWindow,
  interrupt: () => agentRuntime.interrupt(),
  refreshData: () => sendToRenderer('app:refresh-data'),
})
const VERBOO_SIGNUP_URL = 'https://code.verboo.ai/pt?ref=32d0ad85-a132-47cd-ae6d-b1f9c5e92228&utm_source=referral&utm_medium=whatsapp&utm_campaign=referral_program&utm_content=32d0ad85-a132-47cd-ae6d-b1f9c5e92228'

let mainWindow: BrowserWindow | undefined
let isQuitting = false
let latestSettings: UserSettings = defaultUserSettings
const approvedAttachmentPaths = new Set<string>()

function sendToRenderer(channel: string, payload?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { webContents } = mainWindow
  if (webContents.isDestroyed()) return
  webContents.send(channel, payload)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'Verboo Code',
    backgroundColor: '#050508',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  })

  mainWindow.on('close', event => {
    if (isQuitting || process.platform !== 'darwin') return
    if (!latestSettings.showInMenuBar) return
    event.preventDefault()
    mainWindow?.hide()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Enforce a single running instance. Because closing the window only hides it
// to the tray, launching the app again (dock, Spotlight) would otherwise spin up
// a whole new ~300MB Electron process on top of the hidden one — they stack up
// over a session. Instead, a second launch just reveals the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    registerIpc()
    latestSettings = await userSettings.getSettings()
    trayStatus.configure(latestSettings)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('before-quit', () => {
  isQuitting = true
  terminalService.cleanupAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function registerIpc(): void {
  ipcMain.handle('config:get', async (): Promise<AppConfig> => ({
    workingDirectory: process.cwd() || app.getPath('home'),
    accessMode: (await userSettings.getSettings()).defaultAccessMode,
  }))
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.handle('clipboard:write-text', (_event, text: string) => {
    clipboard.writeText(text)
    return true
  })

  ipcMain.handle('auth:start-cli-login', async () => agentRuntime.startLogin())
  ipcMain.handle('auth:cli-status', async () => agentRuntime.getAuthStatus())
  ipcMain.handle('auth:logout', async () => {
    const result = await agentRuntime.logout()
    await credentials.clearApiKey()
    return result
  })

  ipcMain.handle('auth:open-dashboard', async () => {
    await shell.openExternal('https://code.verboo.ai/pt/dashboard')
    return true
  })

  ipcMain.handle('auth:open-subscriptions', async () => {
    await shell.openExternal('https://code.verboo.ai/pt/subscriptions')
    return true
  })

  ipcMain.handle('auth:open-signup', async () => {
    await shell.openExternal(VERBOO_SIGNUP_URL)
    return true
  })

  ipcMain.handle('credentials:status', () => credentials.getStatus())
  ipcMain.handle('credentials:set-api-key', (_event, apiKey: string) => credentials.setApiKey(apiKey))
  ipcMain.handle('credentials:clear-api-key', () => credentials.clearApiKey())

  ipcMain.handle('models:list', (_event, forceRefresh?: boolean) => agentRuntime.listModels(Boolean(forceRefresh)))
  ipcMain.handle('profile:get', () => profile.getProfile())
  ipcMain.handle('feedback:send', (_event, request: FeedbackRequest) => feedback.sendFeedback(request))
  ipcMain.handle('settings:get', () => userSettings.getSettings())
  ipcMain.handle('settings:update', async (_event, patch: Partial<UserSettings>) => {
    const settings = await userSettings.updateSettings(patch)
    latestSettings = settings
    trayStatus.configure(settings)
    return settings
  })
  ipcMain.handle('settings:reset', async () => {
    const settings = await userSettings.resetSettings()
    latestSettings = settings
    trayStatus.configure(settings)
    return settings
  })
  ipcMain.handle('window:toggle-zoom', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
    return true
  })
  ipcMain.handle('menu-bar:update', (_event, state: Partial<MenuBarState>) => {
    trayStatus.update(state)
    return true
  })
  ipcMain.handle('skills:list', (_event, workingDirectory: string) => skills.listSkills(workingDirectory))
  ipcMain.handle('skills:open-user-folder', async () => {
    const folder = await skills.openUserSkillsFolder()
    await shell.openPath(folder)
    return folder
  })
  ipcMain.handle('workspace:changes', (_event, workingDirectory: string) => readWorkspaceChangeSummary(workingDirectory))

  ipcMain.handle('workspace:review-metadata', (_event, workingDirectory: string) =>
    readWorkspaceReviewMetadata(workingDirectory),
  )

  ipcMain.handle('workspace:file-diff', (_event, workingDirectory: string, filePath: string, status: FileDiffStatus) =>
    readFileDiff(workingDirectory, filePath, status),
  )

  ipcMain.handle('workspace:revert-file', (_event, workingDirectory: string, filePath: string) =>
    revertFile(workingDirectory, filePath),
  )

  ipcMain.handle('workspace:open-external', async (_event, workingDirectory: string, filePath: string) => {
    const root = await resolveRepoRoot(workingDirectory)
    if (!root) return { ok: false, message: 'Abrir arquivo exige um caminho seguro.' }
    const target = resolveSafePath(root, filePath)
    if (!target) return { ok: false, message: 'Caminho fora do repositório.' }
    const error = await shell.openPath(target)
    return { ok: error === '', message: error || undefined }
  })

  ipcMain.handle('goal:evaluate', async (_event, input: GoalEvaluationInput) => {
    return agentRuntime.evaluateGoal(input)
  })

  ipcMain.handle('files:pick', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return []
    const attachments = await inspectAttachments(result.filePaths)
    attachments.forEach(attachment => approvedAttachmentPaths.add(attachment.path))
    return attachments
  })

  ipcMain.handle('files:pick-folder', async () => {
    if (!mainWindow) return undefined
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    })
    return result.canceled ? undefined : result.filePaths[0]
  })

  ipcMain.handle('files:create-project-folder', async () => {
    if (!mainWindow) return undefined
    const result = await dialog.showOpenDialog(mainWindow, {
      buttonLabel: 'Usar pasta',
      message: 'Escolha ou crie uma pasta para o projeto',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    })
    return result.canceled ? undefined : result.filePaths[0]
  })

  ipcMain.handle('agent:send', async (_event, request: AgentTurnRequest, resumeSessionId?: string) => {
    const settings = await userSettings.getSettings()
    const safeRequest = await sanitizeAgentTurnRequest(request)
    const preparedRequest = await visionFallback.prepareRequest(safeRequest)
    return agentRuntime.sendTurn(preparedRequest, event => handleAgentEvent(event, preparedRequest, settings), settings, resumeSessionId)
  })

  ipcMain.handle('research-subagents:run', async (_event, request: ResearchSubagentsRunRequest) => {
    const settings = await userSettings.getSettings()
    const safeRequest = await sanitizeResearchSubagentsRunRequest(request)
    return researchSubagents.runMany(safeRequest, settings)
  })

  ipcMain.handle('research-subagents:cancel', (_event, runId: string) => {
    return researchSubagents.cancel(String(runId || ''))
  })

  ipcMain.handle('agent:interrupt', () => {
    agentRuntime.interrupt()
    return true
  })

  // ── Terminal IPC ──────────────────────────────────────────────

  ipcMain.handle('terminal:start', async (_event, request: LocalTerminalStartRequest) => {
    return terminalService.start(request)
  })

  ipcMain.handle('terminal:write', async (_event, sessionId: string, data: string) => {
    return terminalService.write(sessionId, data)
  })

  ipcMain.handle('terminal:resize', async (_event, sessionId: string, cols: number, rows: number) => {
    return terminalService.resize(sessionId, cols, rows)
  })

  ipcMain.handle('terminal:stop', async (_event, sessionId: string) => {
    return terminalService.stop(sessionId)
  })

  ipcMain.handle('terminal:get-state', async () => {
    return terminalService.getState()
  })
}

async function sanitizeResearchSubagentsRunRequest(request: ResearchSubagentsRunRequest): Promise<ResearchSubagentsRunRequest> {
  const requestedAccessMode: AccessMode = 'approval'
  const safeBaseRequest = await sanitizeAgentTurnRequest({
    ...request.baseRequest,
    accessMode: requestedAccessMode,
    attachments: [],
  })
  return {
    runId: typeof request.runId === 'string' ? request.runId.slice(0, 120) : undefined,
    count: clamp(Math.round(Number(request.count) || 1), 1, 2),
    requestedCount: Number.isFinite(Number(request.requestedCount)) ? Math.round(Number(request.requestedCount)) : undefined,
    baseRequest: {
      ...safeBaseRequest,
      accessMode: requestedAccessMode,
      attachments: [],
    },
  }
}

const VALID_ACCESS_MODES = new Set(Object.keys(accessModeConfig) as AccessMode[])

async function sanitizeAgentTurnRequest(request: AgentTurnRequest): Promise<AgentTurnRequest> {
  const accessMode = VALID_ACCESS_MODES.has(request.accessMode) ? request.accessMode : 'approval'
  const model = request.model && request.model.startsWith('-') ? undefined : request.model

  let workingDirectory = request.workingDirectory
  try {
    const stats = await stat(workingDirectory)
    if (!stats.isDirectory()) workingDirectory = app.getPath('home')
  } catch {
    workingDirectory = app.getPath('home')
  }

  const attachments = request.attachments?.filter(attachment => approvedAttachmentPaths.has(attachment.path))

  return { ...request, accessMode, model, workingDirectory, attachments }
}

function handleAgentEvent(event: AgentEvent, request: AgentTurnRequest, settings: UserSettings): void {
  sendToRenderer('agent:event', event)
  const modelDisplayName = request.model
  const baseState: Partial<MenuBarState> = {
    modelId: request.model,
    modelDisplayName,
    contextWindow: request.contextWindow,
    workingDirectory: request.workingDirectory,
  }

  if (event.type === 'started') {
    trayStatus.update({ ...baseState, execution: 'thinking', label: 'thinking', startedAt: Date.now() })
    return
  }

  if (event.type === 'stdout') {
    trayStatus.update({ ...baseState, execution: 'tool', label: 'responding' })
    return
  }

  if (event.type === 'stderr') {
    trayStatus.update({ ...baseState, execution: 'tool', label: 'terminal' })
    return
  }

  if (event.type === 'json') {
    const status = event.runtimeStatus
    if (status?.kind === 'permission') {
      trayStatus.update({ ...baseState, execution: 'permission', label: status.label })
      if (settings.permissionNotifications) showNotification('Verboo precisa de permissão', 'Revise a solicitação no app.')
    }
    if (status?.kind === 'question') {
      trayStatus.update({ ...baseState, execution: 'permission', label: status.label })
      if (settings.questionNotifications) showNotification('Verboo precisa de uma resposta', 'Volte ao app para continuar.')
    }
    if (status?.kind === 'tool') {
      trayStatus.update({ ...baseState, execution: 'tool', label: status.label })
    }
    return
  }

  if (event.type === 'error') {
    trayStatus.update({ ...baseState, execution: 'error', label: 'error' })
    showCompletionNotification(settings, 'Verboo encontrou um erro', event.message)
    return
  }

  if (event.type === 'done') {
    trayStatus.update({ ...baseState, execution: event.exitCode === 0 ? 'done' : 'error', label: event.exitCode === 0 ? 'done' : 'error' })
    showCompletionNotification(
      settings,
      event.exitCode === 0 ? 'Verboo concluiu' : 'Verboo terminou com erro',
      basename(request.workingDirectory || app.getPath('home')),
    )
    setTimeout(() => trayStatus.update({ ...baseState, execution: 'idle', label: 'ready', startedAt: undefined }), 3500)
  }
}

function showCompletionNotification(settings: UserSettings, title: string, body: string): void {
  if (settings.completionNotifications === 'never') return
  if (settings.completionNotifications === 'background' && mainWindow?.isFocused()) return
  showNotification(title, body)
}

function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body }).show()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
