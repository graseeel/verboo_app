import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccessMode, AgentEvent, AgentTurnRequest, AppConfig, FeedbackRequest, GoalEvaluationInput, GoalEvaluationResult, MenuBarState, ResearchSubagentsRunRequest, UserSettings } from '../shared/types'
import { accessModeConfig } from './security/accessModes'
import { inspectAttachments } from './services/attachmentService'
import { CredentialsStore } from './services/credentialsStore'
import { FeedbackService } from './services/feedbackService'
import { ModelService } from './services/modelService'
import { ProfileService } from './services/profileService'
import { ResearchSubagentService } from './services/researchSubagentService'
import { defaultUserSettings, SettingsService } from './services/settingsService'
import { SkillsService } from './services/skillsService'
import { TrayStatusService } from './services/trayStatusService'
import { VerbooCliService } from './services/verbooCliService'
import { VisionFallbackService } from './services/visionFallbackService'
import { readWorkspaceChangeSummary } from './services/workspaceChangeService'
import { evaluateGoal } from './services/goalEvaluator'

const credentials = new CredentialsStore()
const models = new ModelService(credentials)
const profile = new ProfileService(credentials)
const feedback = new FeedbackService()
const userSettings = new SettingsService()
const skills = new SkillsService()
const cli = new VerbooCliService(credentials)
const researchSubagents = new ResearchSubagentService(credentials)
const visionFallback = new VisionFallbackService(models)
const trayStatus = new TrayStatusService({
  getWindow: () => mainWindow,
  interrupt: () => cli.interrupt(),
  refreshData: () => mainWindow?.webContents.send('app:refresh-data'),
})
const VERBOO_SIGNUP_URL = 'https://code.verboo.ai/pt?ref=32d0ad85-a132-47cd-ae6d-b1f9c5e92228&utm_source=referral&utm_medium=whatsapp&utm_campaign=referral_program&utm_content=32d0ad85-a132-47cd-ae6d-b1f9c5e92228'

let mainWindow: BrowserWindow | undefined
let isQuitting = false
let latestSettings: UserSettings = defaultUserSettings
const approvedAttachmentPaths = new Set<string>()

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

app.whenReady().then(async () => {
  registerIpc()
  latestSettings = await userSettings.getSettings()
  trayStatus.configure(latestSettings)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function registerIpc(): void {
  ipcMain.handle('config:get', async (): Promise<AppConfig> => ({
    workingDirectory: process.cwd() || app.getPath('home'),
    accessMode: (await userSettings.getSettings()).defaultAccessMode,
  }))

  ipcMain.handle('auth:start-cli-login', async () => cli.startCliLogin())
  ipcMain.handle('auth:cli-status', async () => cli.getAuthStatus())
  ipcMain.handle('auth:logout', async () => {
    const result = await cli.logout()
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

  ipcMain.handle('models:list', (_event, forceRefresh?: boolean) => models.listModels(Boolean(forceRefresh)))
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

  ipcMain.handle('goal:evaluate', async (_event, input: GoalEvaluationInput) => {
    return evaluateGoal({
      goal: input.goal,
      conversationItems: input.conversationItems,
      latestResult: input.latestResult,
      workingDirectory: input.goal.workingDirectory,
    })
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
    return cli.sendTurn(preparedRequest, event => handleAgentEvent(event, preparedRequest, settings), settings, resumeSessionId)
  })

  ipcMain.handle('research-subagents:run', async (_event, request: ResearchSubagentsRunRequest) => {
    const settings = await userSettings.getSettings()
    const safeRequest = await sanitizeResearchSubagentsRunRequest(request)
    return researchSubagents.runMany(safeRequest, settings)
  })

  ipcMain.handle('agent:interrupt', () => {
    cli.interrupt()
    return true
  })
}

async function sanitizeResearchSubagentsRunRequest(request: ResearchSubagentsRunRequest): Promise<ResearchSubagentsRunRequest> {
  const requestedAccessMode = request.baseRequest.accessMode === 'approval' ? 'approval' : 'auto'
  const safeBaseRequest = await sanitizeAgentTurnRequest({
    ...request.baseRequest,
    accessMode: requestedAccessMode,
    attachments: [],
  })
  return {
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
  mainWindow?.webContents.send('agent:event', event)
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
    const status = describeRuntimeStatus(event.payload)
    if (status?.kind === 'permission') {
      trayStatus.update({ ...baseState, execution: 'permission', label: status.label })
      if (settings.permissionNotifications) showNotification('Verboo precisa de permissao', 'Revise a solicitacao no app.')
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

function describeRuntimeStatus(payload: unknown): { kind: 'permission' | 'question' | 'tool'; label: string } | undefined {
  if (!isRecord(payload)) return undefined
  const type = textValue(payload.type)
  const event = isRecord(payload.event) ? payload.event : undefined
  const eventType = textValue(event?.type)
  const block = isRecord(event?.content_block) ? event.content_block : undefined
  const blockType = textValue(block?.type)
  const text = `${type} ${eventType} ${blockType}`.toLowerCase()
  if (text.includes('permission') || text.includes('action_required') || text.includes('tool_confirmation')) return { kind: 'permission', label: 'permission' }
  if (text.includes('askuserquestion') || text.includes('question')) return { kind: 'question', label: 'question' }
  if (text.includes('tool_use') || text.includes('tool_result') || text.includes('tool')) {
    return { kind: 'tool', label: labelForToolName(toolNameFromPayload(payload)) }
  }
  return undefined
}

function toolNameFromPayload(payload: Record<string, unknown>): string | undefined {
  const event = isRecord(payload.event) ? payload.event : undefined
  const block = isRecord(event?.content_block) ? event.content_block : undefined
  if (block) return textValue(block.name) || textValue(block.tool_name) || undefined

  const message = isRecord(payload.message) ? payload.message : undefined
  const content = Array.isArray(message?.content) ? message.content : undefined
  const toolBlock = content?.find((item): item is Record<string, unknown> => isRecord(item) && textValue(item.type).toLowerCase().includes('tool_use'))
  return toolBlock ? textValue(toolBlock.name) || textValue(toolBlock.tool_name) || undefined : undefined
}

function labelForToolName(toolName?: string): string {
  const normalized = toolName?.toLowerCase()
  if (normalized === 'read' || normalized === 'ls' || normalized === 'glob' || normalized === 'grep') return 'reading'
  if (normalized === 'edit' || normalized === 'multiedit' || normalized === 'write' || normalized === 'notebookedit') return 'editing'
  if (normalized === 'bash') return 'running'
  if (normalized === 'websearch' || normalized === 'webfetch') return 'searching'
  if (normalized === 'todowrite') return 'planning'
  return 'tool'
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

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
