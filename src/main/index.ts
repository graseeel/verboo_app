import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccessMode, AgentEvent, AgentTurnRequest, AppConfig, FeedbackRequest, MenuBarState, UserSettings } from '../shared/types'
import { accessModeConfig } from './security/accessModes'
import { inspectAttachments } from './services/attachmentService'
import { CredentialsStore } from './services/credentialsStore'
import { FeedbackService } from './services/feedbackService'
import { ModelService } from './services/modelService'
import { ProfileService } from './services/profileService'
import { defaultUserSettings, SettingsService } from './services/settingsService'
import { SkillsService } from './services/skillsService'
import { TrayStatusService } from './services/trayStatusService'
import { VerbooCliService } from './services/verbooCliService'
import { VisionFallbackService } from './services/visionFallbackService'

const credentials = new CredentialsStore()
const models = new ModelService(credentials)
const profile = new ProfileService(credentials)
const feedback = new FeedbackService()
const userSettings = new SettingsService()
const skills = new SkillsService()
const cli = new VerbooCliService()
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

  ipcMain.handle('agent:send', async (_event, request: AgentTurnRequest) => {
    const settings = await userSettings.getSettings()
    const safeRequest = await sanitizeAgentTurnRequest(request)
    const preparedRequest = await visionFallback.prepareRequest(safeRequest)
    return cli.sendTurn(preparedRequest, event => handleAgentEvent(event, preparedRequest, settings), settings)
  })

  ipcMain.handle('agent:interrupt', () => {
    cli.interrupt()
    return true
  })
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
    trayStatus.update({ ...baseState, execution: 'thinking', label: 'pensando', startedAt: Date.now() })
    return
  }

  if (event.type === 'stdout') {
    trayStatus.update({ ...baseState, execution: 'tool', label: 'respondendo' })
    return
  }

  if (event.type === 'stderr') {
    trayStatus.update({ ...baseState, execution: 'tool', label: 'terminal' })
    return
  }

  if (event.type === 'json') {
    const kind = classifyRuntimePayload(event.payload)
    if (kind === 'permission') {
      trayStatus.update({ ...baseState, execution: 'permission', label: 'permissao' })
      if (settings.permissionNotifications) showNotification('Verboo precisa de permissao', 'Revise a solicitacao no app.')
    }
    if (kind === 'question') {
      trayStatus.update({ ...baseState, execution: 'permission', label: 'pergunta' })
      if (settings.questionNotifications) showNotification('Verboo precisa de uma resposta', 'Volte ao app para continuar.')
    }
    if (kind === 'tool') {
      trayStatus.update({ ...baseState, execution: 'tool', label: 'ferramenta' })
    }
    return
  }

  if (event.type === 'error') {
    trayStatus.update({ ...baseState, execution: 'error', label: 'erro' })
    showCompletionNotification(settings, 'Verboo encontrou um erro', event.message)
    return
  }

  if (event.type === 'done') {
    trayStatus.update({ ...baseState, execution: event.exitCode === 0 ? 'done' : 'error', label: event.exitCode === 0 ? 'concluido' : 'erro' })
    showCompletionNotification(
      settings,
      event.exitCode === 0 ? 'Verboo concluiu' : 'Verboo terminou com erro',
      basename(request.workingDirectory || app.getPath('home')),
    )
    setTimeout(() => trayStatus.update({ ...baseState, execution: 'idle', label: 'pronto', startedAt: undefined }), 3500)
  }
}

function classifyRuntimePayload(payload: unknown): 'permission' | 'question' | 'tool' | undefined {
  if (!isRecord(payload)) return undefined
  const type = textValue(payload.type)
  const event = isRecord(payload.event) ? payload.event : undefined
  const eventType = textValue(event?.type)
  const block = isRecord(event?.content_block) ? event.content_block : undefined
  const blockType = textValue(block?.type)
  const text = `${type} ${eventType} ${blockType}`.toLowerCase()
  if (text.includes('permission') || text.includes('action_required') || text.includes('tool_confirmation')) return 'permission'
  if (text.includes('askuserquestion') || text.includes('question')) return 'question'
  if (text.includes('tool_use') || text.includes('tool_result') || text.includes('tool')) return 'tool'
  return undefined
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
