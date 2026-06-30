import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderClosed } from 'lucide-react'
import type {
  AccessMode,
  AgentEvent,
  AppConfig,
  AttachmentMeta,
  ChatStore,
  CliAuthStatus,
  ContextUsageSnapshot,
  CredentialStatus,
  FeedbackDiagnostics,
  FeedbackRequest,
  FeedbackResult,
  MenuBarState,
  ModelDiscoveryResult,
  ProfileResult,
  SettingsTab,
  SkillSummary,
  StoredConversation,
  ThemeMode,
  TranscriptItem,
  UserSettings,
  VerbooModel,
} from '../shared/types'
import { AppSidebar, type AppView } from './components/AppSidebar'
import { EmptyChat } from './components/EmptyChat'
import { LoginScreen } from './components/LoginScreen'
import { TopBar } from './components/TopBar'
import { Transcript } from './components/Transcript'
import { AccessSelector } from './features/access/AccessSelector'
import { Composer } from './features/composer/Composer'
import { ContextMeter } from './features/context/ContextMeter'
import { FeedbackDialog } from './features/feedback/FeedbackDialog'
import { ModelSelector } from './features/models/ModelSelector'
import { PetSprite, type PetReaction } from './features/pet/PetSprite'
import { ProfileView } from './features/profile/ProfileView'
import { ProjectPicker } from './features/projects/ProjectPicker'
import { SettingsView } from './features/settings/SettingsView'
import {
  activeProjects,
  archivedConversations,
  createConversation,
  createProject,
  initialSystemMessage,
  persistChatStore,
  readChatStore,
  titleFromMessage,
  visibleConversations,
} from './state/chatStore'
import packageJson from '../../package.json'

const defaultModels: VerbooModel[] = []
const DEVELOPMENT_NOTICE_KEY = 'verboo:development-notice-accepted'
const CONTEXT_WINDOWS_KEY = 'verboo:context-windows-by-model'
const THEME_KEY = 'verboo:theme'
const DEFAULT_USER_SETTINGS: UserSettings = {
  defaultAccessMode: 'approval',
  showInMenuBar: true,
  showMenuBarText: true,
  preventSleepWhileRunning: true,
  completionNotifications: 'background',
  permissionNotifications: true,
  questionNotifications: true,
  personality: 'pragmatic',
  customInstructions: '',
  memoriesEnabled: false,
  chroniclePreview: false,
  ignoreToolChatsForMemory: true,
}
const EMPTY_LINES = [
  'Bom te ver por aqui.',
  'Vamos deixar esse projeto mais claro.',
  'Qual parte merece atencao agora?',
  'Pronto para trabalhar com contexto de verdade.',
]

export function App() {
  const [config, setConfig] = useState<AppConfig>({
    workingDirectory: '',
    accessMode: 'approval',
  })
  const [credentials, setCredentials] = useState<CredentialStatus>({ hasApiKey: false })
  const [cliAuth, setCliAuth] = useState<CliAuthStatus>({ loggedIn: false })
  const [profile, setProfile] = useState<ProfileResult>({ status: 'unauthenticated' })
  const [profileLoading, setProfileLoading] = useState(false)
  const [activeView, setActiveView] = useState<AppView>('chat')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('permissions')
  const [userSettings, setUserSettings] = useState<UserSettings>(DEFAULT_USER_SETTINGS)
  const [noticeAccepted, setNoticeAccepted] = useState(
    () => window.localStorage.getItem(DEVELOPMENT_NOTICE_KEY) === 'true',
  )
  const [entryUnlocked, setEntryUnlocked] = useState(false)
  const [authChecking, setAuthChecking] = useState(true)
  const [authError, setAuthError] = useState<string | undefined>()
  const [theme, setTheme] = useState<ThemeMode>(readTheme)
  const [modelResult, setModelResult] = useState<ModelDiscoveryResult>({
    models: defaultModels,
    source: 'none',
    stale: false,
  })
  const [selectedModel, setSelectedModel] = useState<string | undefined>()
  const [contextWindowsByModel, setContextWindowsByModel] = useState<Record<string, number>>(
    readContextWindows,
  )
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [selectedSkills, setSelectedSkills] = useState<SkillSummary[]>([])
  const [attachedFiles, setAttachedFiles] = useState<AttachmentMeta[]>([])
  const [accessMode, setAccessMode] = useState<AccessMode>('approval')
  const [chatStore, setChatStore] = useState<ChatStore>(readChatStore)
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(() => {
    return visibleConversations(readChatStore())[0]?.id
  })
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>()
  const [runningTurnId, setRunningTurnId] = useState<string | undefined>()
  const [petVisible, setPetVisible] = useState(false)
  const [petReaction, setPetReaction] = useState<PetReaction>('idle')
  const [petSpeech, setPetSpeech] = useState('pronto')
  const [petPrompt, setPetPrompt] = useState('')
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | undefined>()
  const [emptyLine] = useState(() => EMPTY_LINES[Math.floor(Math.random() * EMPTY_LINES.length)])
  const turnConversationIds = useRef<Record<string, string>>({})
  const turnModels = useRef<Record<string, { modelId?: string; modelDisplayName?: string }>>({})
  const pendingConversationId = useRef<string | undefined>(undefined)
  const petTimer = useRef<number | undefined>(undefined)
  const selectedContextWindowRef = useRef<number | undefined>(undefined)

  const activeConversation = useMemo(
    () => chatStore.conversations.find(conversation => conversation.id === activeConversationId),
    [chatStore.conversations, activeConversationId],
  )
  const activeProject = activeConversation?.projectId
    ? chatStore.projects.find(project => project.id === activeConversation.projectId)
    : selectedProjectId
      ? chatStore.projects.find(project => project.id === selectedProjectId)
      : undefined
  const items = activeConversation?.items ?? [initialSystemMessage()]
  const hasConversation = items.some(item => item.role === 'user' || item.role === 'assistant')

  useEffect(() => {
    window.verboo.getUserSettings().then(settings => {
      setUserSettings(settings)
      setAccessMode(settings.defaultAccessMode)
    })
    window.verboo.getConfig().then(next => {
      setConfig(next)
      setAccessMode(next.accessMode)
    })
    void validateAccess(true)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    const workingDirectory = activeProject?.path ?? config.workingDirectory
    if (!workingDirectory) return
    window.verboo.listSkills(workingDirectory).then(setSkills)
  }, [config.workingDirectory, activeProject?.path])

  useEffect(() => {
    return window.verboo.onAgentEvent(handleAgentEvent)
  }, [])

  useEffect(() => {
    return window.verboo.onRefreshDataRequest(() => {
      void refreshModels(true)
      void refreshProfile()
      void validateAccess(true)
    })
  }, [])

  useEffect(() => {
    return () => {
      if (petTimer.current) window.clearTimeout(petTimer.current)
    }
  }, [])

  useEffect(() => {
    if (activeView !== 'settings') return undefined

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setActiveView('chat')
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [activeView])

  const selectedModelInfo = useMemo(
    () => modelResult.models.find(model => model.id === selectedModel),
    [modelResult.models, selectedModel],
  )
  const maxContextWindow = selectedModelInfo?.contextWindow
  const selectedContextWindow = selectedModel && maxContextWindow
    ? clampContextWindow(contextWindowsByModel[selectedModel] ?? maxContextWindow, maxContextWindow)
    : undefined

  useEffect(() => {
    selectedContextWindowRef.current = selectedContextWindow
  }, [selectedContextWindow])

  useEffect(() => {
    setContextUsage(undefined)
  }, [activeConversationId, selectedContextWindow, selectedModel])

  async function refreshModels(forceRefresh: boolean): Promise<ModelDiscoveryResult> {
    const result = await window.verboo.listModels(forceRefresh)
    setModelResult(result)
    setSelectedModel(current => {
      if (current && result.models.some(model => model.id === current)) return current
      return result.models[0]?.id
    })
    return result
  }

  async function saveApiKey(apiKey: string): Promise<boolean> {
    const status = await window.verboo.setApiKey(apiKey)
    setCredentials(status)
    return validateAccess(true)
  }

  async function refreshProfile() {
    setProfileLoading(true)
    try {
      setProfile(await window.verboo.getProfile())
    } finally {
      setProfileLoading(false)
    }
  }

  async function startCliLogin() {
    const result = await window.verboo.startCliLogin()
    if (result.status) setCliAuth(result.status)
    if (result.ok) {
      await validateAccess(true)
    }
    return result
  }

  async function logout() {
    setAuthChecking(true)
    try {
      const result = await window.verboo.logout()
      if (result.status) setCliAuth(result.status)
      setCredentials({ hasApiKey: false })
      setProfile({ status: 'unauthenticated' })
      setModelResult({ models: [], source: 'none', stale: false })
      setSelectedModel(undefined)
      setContextUsage(undefined)
      setEntryUnlocked(false)
      setActiveView('chat')
      setAuthError(result.ok ? undefined : result.message)
    } finally {
      setAuthChecking(false)
    }
  }

  async function validateAccess(forceRefresh: boolean): Promise<boolean> {
    setAuthChecking(true)
    setAuthError(undefined)

    try {
      const [credentialStatus, cliStatus, modelDiscovery] = await Promise.all([
        window.verboo.getCredentialStatus(),
        window.verboo.getCliAuthStatus(),
        window.verboo.listModels(forceRefresh),
      ])
      setCredentials(credentialStatus)
      setCliAuth(cliStatus)
      setModelResult(modelDiscovery)
      setSelectedModel(current => {
        if (current && modelDiscovery.models.some(model => model.id === current)) return current
        return modelDiscovery.models[0]?.id
      })

      const unlocked = isVerifiedModelDiscovery(modelDiscovery)
      setEntryUnlocked(unlocked)
      if (!unlocked) {
        setAuthError(modelDiscovery.error ?? cliStatus.error ?? 'Entre com Verboo pelo CLI ou salve uma chave API valida.')
        return false
      }

      await refreshProfile()
      return true
    } finally {
      setAuthChecking(false)
    }
  }

  function acceptDevelopmentNotice() {
    window.localStorage.setItem(DEVELOPMENT_NOTICE_KEY, 'true')
    setNoticeAccepted(true)
  }

  function changeContextWindow(value: number) {
    if (!selectedModel || !maxContextWindow) return
    const nextValue = clampContextWindow(value, maxContextWindow)
    setContextWindowsByModel(current => {
      const next = { ...current, [selectedModel]: nextValue }
      window.localStorage.setItem(CONTEXT_WINDOWS_KEY, JSON.stringify(next))
      return next
    })
  }

  async function updateUserSettings(patch: Partial<UserSettings>) {
    const next = await window.verboo.updateUserSettings(patch)
    setUserSettings(next)
    if (patch.defaultAccessMode) setAccessMode(next.defaultAccessMode)
  }

  async function resetUserSettings() {
    const next = await window.verboo.resetUserSettings()
    setUserSettings(next)
    setAccessMode(next.defaultAccessMode)
  }

  function handleAgentEvent(event: AgentEvent) {
    if (event.type === 'started') {
      const conversationId = turnConversationIds.current[event.turnId] ?? pendingConversationId.current
      if (conversationId) turnConversationIds.current[event.turnId] = conversationId
      setRunningTurnId(event.turnId)
      showPetReaction('thinking', 'pensando', undefined)
      if (conversationId) {
        appendAssistantPlaceholder(conversationId, event.turnId)
      }
      return
    }

    if (event.type === 'stdout') {
      const conversationId = turnConversationIds.current[event.turnId]
      showPetReaction('coding', 'codando', undefined)
      if (conversationId) appendAssistantText(conversationId, event.turnId, event.text)
      return
    }

    if (event.type === 'stderr') {
      const conversationId = turnConversationIds.current[event.turnId]
      if (conversationId) {
        appendConversationItem(conversationId, {
          id: `${event.turnId}:stderr:${Date.now()}`,
          role: 'tool',
          text: event.text,
          timestamp: Date.now(),
        })
      }
      return
    }

    if (event.type === 'json') {
      const usage = extractContextUsage(event.payload, selectedContextWindowRef.current)
      if (usage) setContextUsage(usage)
      return
    }

    if (event.type === 'error') {
      const conversationId = turnConversationIds.current[event.turnId]
      showPetReaction('error', 'ops', 2200)
      setRunningTurnId(undefined)
      if (conversationId) {
        appendConversationItem(conversationId, {
          id: `${event.turnId}:error`,
          role: 'system',
          text: event.message,
          timestamp: Date.now(),
        })
      }
      return
    }

    if (event.type === 'done') {
      const conversationId = turnConversationIds.current[event.turnId]
      setRunningTurnId(undefined)
      showPetReaction(event.exitCode === 0 ? 'success' : 'error', event.exitCode === 0 ? 'feito' : 'ops', 2400)
      if (conversationId) finishAssistantMessage(conversationId, event.turnId)
      delete turnConversationIds.current[event.turnId]
    }
  }

  async function sendMessage(message: string) {
    const trimmed = message.trim()
    if (!trimmed || runningTurnId) return
    const conversationId = ensureActiveConversation()
    const turnModel = {
      modelId: selectedModel,
      modelDisplayName: selectedModelInfo?.displayName ?? selectedModel,
    }
    setActiveView('chat')

    appendConversationItem(conversationId, {
      id: `user:${Date.now()}`,
      role: 'user',
      text: trimmed,
      timestamp: Date.now(),
      skills: selectedSkills,
    }, titleFromMessage(trimmed))

    pendingConversationId.current = conversationId
    showPetReaction('inspect', 'lendo pedido', 1200, 'thinking')
    setPetPrompt(trimmed)
    setContextUsage(undefined)

    const turnId = await window.verboo.sendTurn({
      message: trimmed,
      model: selectedModel,
      modelSupportsVision: Boolean(selectedModelInfo?.supportsVision),
      contextWindow: selectedContextWindow,
      accessMode,
      workingDirectory: workingDirectoryForConversation(conversationId),
      skills: selectedSkills,
      attachments: attachedFiles,
      personality: userSettings.personality,
      customInstructions: userSettings.customInstructions,
      memoryContext: buildMemoryContext(chatStore, conversationId, userSettings),
    })
    turnConversationIds.current[turnId] = conversationId
    turnModels.current[turnId] = turnModel
    tagAssistantMessage(conversationId, turnId, turnModel)
    if (pendingConversationId.current === conversationId) pendingConversationId.current = undefined
    setAttachedFiles([])
  }

  async function sendFeedback(request: FeedbackRequest): Promise<FeedbackResult> {
    return window.verboo.sendFeedback(request)
  }

  async function attachFiles() {
    const attachments = await window.verboo.pickFiles()
    if (!attachments.length) return
    setAttachedFiles(current => {
      const byPath = new Map(current.map(attachment => [attachment.path, attachment]))
      for (const attachment of attachments) byPath.set(attachment.path, attachment)
      return Array.from(byPath.values())
    })
  }

  async function openProjectFolder() {
    const path = await window.verboo.pickFolder()
    if (!path) return
    selectProjectPath(path)
  }

  async function createProjectFolder() {
    const path = await window.verboo.createProjectFolder()
    if (!path) return
    selectProjectPath(path)
  }

  function selectProjectPath(path: string) {
    const existing = chatStore.projects.find(project => project.path === path && !project.archivedAt)
    const project = existing ?? createProject(path)
    if (!existing) {
      updateChatStore(store => ({ ...store, projects: [project, ...store.projects] }))
    }
    setConfig(current => ({ ...current, workingDirectory: path }))
    setSelectedProjectId(project.id)
    setActiveConversationId(undefined)
    setActiveView('chat')
  }

  function newChat(projectId = selectedProjectId) {
    const project = projectId ? chatStore.projects.find(item => item.id === projectId && !item.archivedAt) : undefined
    if (project) {
      updateChatStore(store => ({
        ...store,
        projects: store.projects.map(item =>
          item.id === project.id ? { ...item, collapsed: false, updatedAt: Date.now() } : item,
        ),
      }))
      if (project.path) setConfig(current => ({ ...current, workingDirectory: project.path ?? current.workingDirectory }))
    }
    setActiveConversationId(undefined)
    setSelectedProjectId(project?.id)
    setSelectedSkills([])
    setAttachedFiles([])
    setActiveView('chat')
  }

  function selectProject(projectId: string) {
    const project = chatStore.projects.find(item => item.id === projectId && !item.archivedAt)
    if (!project) return
    setSelectedProjectId(project.id)
    setActiveConversationId(undefined)
    if (project.path) setConfig(current => ({ ...current, workingDirectory: project.path ?? current.workingDirectory }))
    setActiveView('chat')
  }

  function clearProjectSelection() {
    setSelectedProjectId(undefined)
    setActiveConversationId(undefined)
    setActiveView('chat')
  }

  function selectConversation(conversationId: string) {
    const conversation = chatStore.conversations.find(item => item.id === conversationId)
    if (!conversation || conversation.archivedAt) return
    const project = conversation.projectId
      ? chatStore.projects.find(item => item.id === conversation.projectId)
      : undefined
    setActiveConversationId(conversation.id)
    setSelectedProjectId(project?.id)
    if (project?.path) setConfig(current => ({ ...current, workingDirectory: project.path ?? current.workingDirectory }))
    setActiveView('chat')
  }

  function toggleProject(projectId: string) {
    updateChatStore(store => ({
      ...store,
      projects: store.projects.map(project =>
        project.id === projectId
          ? { ...project, collapsed: !project.collapsed, updatedAt: Date.now() }
          : project,
      ),
    }))
    setSelectedProjectId(projectId)
    setActiveView('chat')
  }

  function renameProject(projectId: string, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    updateChatStore(store => ({
      ...store,
      projects: store.projects.map(project =>
        project.id === projectId ? { ...project, name: trimmed, updatedAt: Date.now() } : project,
      ),
    }))
  }

  function archiveConversation(conversationId: string) {
    if (isConversationRunning(conversationId)) return
    updateChatStore(store => ({
      ...store,
      conversations: store.conversations.map(conversation =>
        conversation.id === conversationId
          ? { ...conversation, archivedAt: Date.now(), updatedAt: Date.now() }
          : conversation,
      ),
    }))
    if (activeConversationId === conversationId) setActiveConversationId(undefined)
  }

  function restoreConversation(conversationId: string) {
    updateChatStore(store => ({
      ...store,
      conversations: store.conversations.map(conversation =>
        conversation.id === conversationId
          ? { ...conversation, archivedAt: undefined, updatedAt: Date.now() }
          : conversation,
      ),
    }))
  }

  function deleteConversation(conversationId: string) {
    if (isConversationRunning(conversationId)) return
    if (!window.confirm('Apagar este chat permanentemente?')) return
    updateChatStore(store => ({
      ...store,
      conversations: store.conversations.filter(conversation => conversation.id !== conversationId),
    }))
    if (activeConversationId === conversationId) setActiveConversationId(undefined)
  }

  function archiveProject(projectId: string) {
    if (!window.confirm('Arquivar este projeto e seus chats?')) return
    const now = Date.now()
    updateChatStore(store => ({
      ...store,
      projects: store.projects.map(project =>
        project.id === projectId ? { ...project, archivedAt: now, updatedAt: now } : project,
      ),
      conversations: store.conversations.map(conversation =>
        conversation.projectId === projectId ? { ...conversation, archivedAt: now, updatedAt: now } : conversation,
      ),
    }))
    if (activeProject?.id === projectId) {
      setActiveConversationId(undefined)
      setSelectedProjectId(undefined)
    }
  }

  function deleteProject(projectId: string) {
    if (!window.confirm('Apagar este projeto e todos os chats dele permanentemente?')) return
    updateChatStore(store => ({
      ...store,
      projects: store.projects.filter(project => project.id !== projectId),
      conversations: store.conversations.filter(conversation => conversation.projectId !== projectId),
    }))
    if (activeProject?.id === projectId) {
      setActiveConversationId(undefined)
      setSelectedProjectId(undefined)
    }
  }

  function runPetCommand(command: string) {
    const normalized = command.trim()
    if (normalized === '/pet hide' || normalized === '/pet close') {
      setPetVisible(false)
      return
    }
    if (normalized === '/pet mute') {
      showPetReaction('idle', 'quieto', 1400)
      return
    }
    if (petVisible) {
      setPetVisible(false)
      return
    }
    showPetReaction('wake', 'oi', 1600)
  }

  function ensureActiveConversation(): string {
    if (activeConversation && !activeConversation.archivedAt) return activeConversation.id
    const project = selectedProjectId ? chatStore.projects.find(item => item.id === selectedProjectId) : undefined
    const conversation = createConversation(project?.archivedAt ? undefined : project?.id)
    updateChatStore(store => ({ ...store, conversations: [conversation, ...store.conversations] }))
    setActiveConversationId(conversation.id)
    return conversation.id
  }

  function appendConversationItem(conversationId: string, item: TranscriptItem, title?: string) {
    updateConversation(conversationId, conversation => ({
      ...conversation,
      title: conversation.title === 'Novo chat' && title ? title : conversation.title,
      items: [...conversation.items, item],
      updatedAt: Date.now(),
    }))
  }

  function appendAssistantPlaceholder(conversationId: string, turnId: string) {
    const turnModel = turnModels.current[turnId]
    updateConversation(conversationId, conversation => {
      if (conversation.items.some(item => item.id === turnId)) return conversation
      return {
        ...conversation,
        items: [
          ...conversation.items,
          { id: turnId, role: 'assistant', text: '', timestamp: Date.now(), streaming: true, ...turnModel },
        ],
        updatedAt: Date.now(),
      }
    })
  }

  function appendAssistantText(conversationId: string, turnId: string, text: string) {
    const turnModel = turnModels.current[turnId]
    updateConversation(conversationId, conversation => {
      const hasAssistant = conversation.items.some(item => item.id === turnId)
      return {
        ...conversation,
        items: hasAssistant
          ? conversation.items.map(item =>
              item.id === turnId ? { ...item, text: item.text + text } : item,
            )
          : [
              ...conversation.items,
              { id: turnId, role: 'assistant', text, timestamp: Date.now(), streaming: true, ...turnModel },
            ],
        updatedAt: Date.now(),
      }
    })
  }

  function tagAssistantMessage(
    conversationId: string,
    turnId: string,
    turnModel: { modelId?: string; modelDisplayName?: string },
  ) {
    updateConversation(conversationId, conversation => ({
      ...conversation,
      items: conversation.items.map(item =>
        item.id === turnId ? { ...item, ...turnModel } : item,
      ),
      updatedAt: Date.now(),
    }))
  }

  function finishAssistantMessage(conversationId: string, turnId: string) {
    updateConversation(conversationId, conversation => ({
      ...conversation,
      items: conversation.items.map(item =>
        item.id === turnId ? { ...item, streaming: false } : item,
      ),
      updatedAt: Date.now(),
    }))
    delete turnModels.current[turnId]
  }

  function updateConversation(
    conversationId: string,
    updater: (conversation: StoredConversation) => StoredConversation,
  ) {
    updateChatStore(store => ({
      ...store,
      conversations: store.conversations.map(conversation =>
        conversation.id === conversationId ? updater(conversation) : conversation,
      ),
    }))
  }

  function updateChatStore(updater: (store: ChatStore) => ChatStore) {
    setChatStore(current => {
      const next = updater(current)
      persistChatStore(next)
      return next
    })
  }

  function showPetReaction(
    reaction: PetReaction,
    speech: string,
    duration?: number,
    nextReaction: PetReaction = 'idle',
  ) {
    if (petTimer.current) window.clearTimeout(petTimer.current)
    setPetVisible(true)
    setPetReaction(reaction)
    setPetSpeech(speech)
    if (duration) {
      petTimer.current = window.setTimeout(() => {
        setPetReaction(nextReaction)
        setPetSpeech(nextReaction === 'idle' ? 'pronto' : speech)
      }, duration)
    }
  }

  function isConversationRunning(conversationId: string): boolean {
    return Object.values(turnConversationIds.current).includes(conversationId)
  }

  function workingDirectoryForConversation(conversationId: string): string {
    const conversation = chatStore.conversations.find(item => item.id === conversationId)
    const project = conversation?.projectId
      ? chatStore.projects.find(item => item.id === conversation.projectId)
      : undefined
    return project?.path ?? config.workingDirectory
  }

  const shouldShowLogin = !noticeAccepted || !entryUnlocked
  const projectName = activeProject?.name ?? 'Sem projeto'
  const workspaceDirectory = activeProject?.path ?? config.workingDirectory
  const shownProjects = activeProjects(chatStore)
  const shownConversations = visibleConversations(chatStore)
  const archivedChats = archivedConversations(chatStore)
  const feedbackDiagnostics = useMemo<FeedbackDiagnostics>(() => ({
    appVersion: packageJson.version,
    platform: navigator.platform,
    appSource: 'desktop',
    projectName,
    activeView,
    modelId: selectedModel,
    modelDisplayName: selectedModelInfo?.displayName,
    modelSource: modelResult.source,
    accessMode,
    contextWindow: selectedContextWindow,
    contextUsage,
    authMethod: cliAuth.authMethod,
    cliLoggedIn: cliAuth.loggedIn,
    hasApiKey: credentials.hasApiKey,
  }), [
    accessMode,
    activeView,
    cliAuth.authMethod,
    cliAuth.loggedIn,
    contextUsage,
    credentials.hasApiKey,
    modelResult.source,
    projectName,
    selectedContextWindow,
    selectedModel,
    selectedModelInfo?.displayName,
  ])

  useEffect(() => {
    const state: Partial<MenuBarState> = {
      execution: runningTurnId ? 'thinking' : 'idle',
      label: runningTurnId ? 'trabalhando' : 'pronto',
      modelId: selectedModel,
      modelDisplayName: selectedModelInfo?.displayName,
      contextWindow: selectedContextWindow,
      contextUsage: contextUsage?.percentage,
      workingDirectory: activeProject?.path ?? config.workingDirectory,
      loggedIn: cliAuth.loggedIn || credentials.hasApiKey,
      email: cliAuth.email ?? profile.user?.email,
    }
    void window.verboo.updateMenuBar(state)
  }, [
    activeProject?.path,
    cliAuth.email,
    cliAuth.loggedIn,
    config.workingDirectory,
    contextUsage?.percentage,
    credentials.hasApiKey,
    profile.user?.email,
    runningTurnId,
    selectedContextWindow,
    selectedModel,
    selectedModelInfo?.displayName,
  ])

  if (shouldShowLogin) {
    return (
      <>
        <LoginScreen
          noticeAccepted={noticeAccepted}
          checking={authChecking}
          authError={authError}
          credentials={credentials}
          cliAuth={cliAuth}
          modelResult={modelResult}
          onStartLogin={startCliLogin}
          onOpenDashboard={() => window.verboo.openDashboard()}
          onOpenSignup={() => window.verboo.openSignup()}
          onCheckExistingAuth={() => validateAccess(true)}
          onSaveApiKey={saveApiKey}
          onAcceptNotice={acceptDevelopmentNotice}
          onOpenFeedback={() => setFeedbackOpen(true)}
        />
        <FeedbackDialog
          open={feedbackOpen}
          defaultContact={cliAuth.email ?? profile.user?.email}
          diagnostics={feedbackDiagnostics}
          onClose={() => setFeedbackOpen(false)}
          onSubmit={sendFeedback}
        />
      </>
    )
  }

  return (
    <main className="app-shell">
      <TopBar />

      <div className={`app-layout ${activeView === 'settings' ? 'settings-open' : ''}`}>
        <AppSidebar
          activeView={activeView}
          projects={shownProjects}
          conversations={shownConversations}
          activeConversationId={activeConversationId}
          selectedProjectId={selectedProjectId}
          profile={profile}
          cliAuth={cliAuth}
          onSelectView={setActiveView}
          onOpenSettings={() => {
            setSettingsTab('permissions')
            setActiveView('settings')
          }}
          onOpenArchivedChats={() => {
            setSettingsTab('archived')
            setActiveView('settings')
          }}
          onOpenFeedback={() => setFeedbackOpen(true)}
          onLogout={logout}
          onNewChat={newChat}
          onOpenProject={openProjectFolder}
          onSelectConversation={selectConversation}
          onToggleProject={toggleProject}
          onRenameProject={renameProject}
          onArchiveProject={archiveProject}
          onDeleteProject={deleteProject}
          onArchiveConversation={archiveConversation}
          onDeleteConversation={deleteConversation}
        />

        <section className={`workspace ${activeView === 'chat' && !hasConversation ? 'empty-workspace' : ''} ${activeView === 'settings' ? 'settings-workspace' : ''}`}>
          {activeView === 'chat' && (
            <div className="workspace-folder-badge" title={workspaceDirectory || 'Sem projeto aberto'}>
              <FolderClosed size={14} />
              <span>{workspaceFolderName(workspaceDirectory, activeProject?.name)}</span>
            </div>
          )}
          {activeView === 'profile' ? (
            <ProfileView
              profile={profile}
              loading={profileLoading}
              onRefresh={refreshProfile}
              onManagePlan={() => window.verboo.openSubscriptions()}
            />
          ) : activeView === 'settings' ? (
            <SettingsView
              credentials={credentials}
              modelResult={modelResult}
              selectedModel={selectedModelInfo}
              selectedContextWindow={selectedContextWindow}
              maxContextWindow={maxContextWindow}
              theme={theme}
              activeTab={settingsTab}
              userSettings={userSettings}
              archivedConversations={archivedChats}
              onOpenDashboard={() => window.verboo.openDashboard()}
              onSaveApiKey={async apiKey => {
                await saveApiKey(apiKey)
              }}
              onContextWindowChange={changeContextWindow}
              onThemeChange={setTheme}
              onActiveTabChange={setSettingsTab}
              onUserSettingsChange={updateUserSettings}
              onResetUserSettings={resetUserSettings}
              onRestoreConversation={restoreConversation}
              onDeleteConversation={deleteConversation}
              onClose={() => setActiveView('chat')}
            />
          ) : hasConversation ? (
            <Transcript items={items} />
          ) : (
            <EmptyChat projectName={projectName || 'Sem projeto'} line={emptyLine} />
          )}
        </section>
      </div>

      <PetSprite visible={petVisible} reaction={petReaction} speech={petSpeech} promptText={petPrompt} />

      {activeView === 'chat' && (
        <div className={`bottom-dock ${hasConversation ? '' : 'empty-mode'}`}>
          <Composer
            disabled={Boolean(runningTurnId)}
            skills={skills}
            selectedSkills={selectedSkills}
            attachments={attachedFiles}
            onSelectedSkillsChange={setSelectedSkills}
            onAttachFiles={attachFiles}
            onRemoveAttachment={path => setAttachedFiles(current => current.filter(item => item.path !== path))}
            onSubmit={sendMessage}
            onPetCommand={runPetCommand}
            leftToolbar={
              <AccessSelector value={accessMode} onChange={setAccessMode} />
            }
            rightToolbar={
              <>
                <ContextMeter usage={contextUsage} contextWindow={selectedContextWindow} />
                <ModelSelector
                  models={modelResult.models}
                  selectedModel={selectedModel}
                  modelResult={modelResult}
                  onSelect={setSelectedModel}
                  onRefresh={() => refreshModels(true)}
                />
              </>
            }
          />
          {!hasConversation && (
            <ProjectPicker
              projects={shownProjects}
              selectedProjectId={selectedProjectId}
              onSelectProject={selectProject}
              onClearProject={clearProjectSelection}
              onUseExistingFolder={openProjectFolder}
              onCreateProject={createProjectFolder}
            />
          )}
        </div>
      )}

      <FeedbackDialog
        open={feedbackOpen}
        defaultContact={cliAuth.email ?? profile.user?.email}
        diagnostics={feedbackDiagnostics}
        onClose={() => setFeedbackOpen(false)}
        onSubmit={sendFeedback}
      />
    </main>
  )
}

function readContextWindows(): Record<string, number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CONTEXT_WINDOWS_KEY) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
    ) as Record<string, number>
  } catch {
    return {}
  }
}

function readTheme(): ThemeMode {
  return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
}

function isVerifiedModelDiscovery(result: ModelDiscoveryResult): boolean {
  return !result.stale && result.models.length > 0 && (result.source === 'cli' || result.source === 'api-key')
}

function workspaceFolderName(path: string, projectName?: string): string {
  if (projectName?.trim()) return projectName.trim()
  const trimmed = path.trim()
  if (!trimmed) return 'Sem projeto'
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? trimmed
}

function clampContextWindow(value: number, max: number): number {
  const min = Math.min(4_000, max)
  return Math.min(Math.max(Math.round(value), min), max)
}

function extractContextUsage(payload: unknown, maxTokens?: number): ContextUsageSnapshot | undefined {
  const usage = extractUsageObject(payload)
  if (!usage) return undefined

  const inputTokens = numberValue(usage.input_tokens)
  const outputTokens = numberValue(usage.output_tokens)
  const cacheCreationTokens = numberValue(usage.cache_creation_input_tokens)
  const cacheReadTokens = numberValue(usage.cache_read_input_tokens)
  const usedTokens = inputTokens + cacheCreationTokens + cacheReadTokens
  if (usedTokens <= 0) return undefined

  return {
    usedTokens,
    maxTokens,
    percentage: maxTokens ? Math.min(1, usedTokens / maxTokens) : undefined,
    inputTokens,
    outputTokens,
    source: 'cli-usage',
    updatedAt: Date.now(),
  }
}

function extractUsageObject(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined
  if (isRecord(payload.usage)) return payload.usage
  if (isRecord(payload.message) && isRecord(payload.message.usage)) return payload.message.usage

  if (payload.type === 'stream_event' && isRecord(payload.event)) {
    if (isRecord(payload.event.usage)) return payload.event.usage
    if (isRecord(payload.event.message) && isRecord(payload.event.message.usage)) return payload.event.message.usage
  }

  return undefined
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

function buildMemoryContext(
  store: ChatStore,
  currentConversationId: string,
  settings: UserSettings,
): string | undefined {
  if (!settings.memoriesEnabled) return undefined

  const current = store.conversations.find(conversation => conversation.id === currentConversationId)
  const related = store.conversations
    .filter(conversation => conversation.id !== currentConversationId)
    .filter(conversation => !conversation.archivedAt)
    .filter(conversation => conversation.projectId === current?.projectId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6)

  if (!related.length) return undefined

  const lines = related.flatMap(conversation => {
    const usefulItems = conversation.items
      .filter(item => settings.ignoreToolChatsForMemory ? item.role !== 'tool' : true)
      .filter(item => item.role === 'user' || item.role === 'assistant' || item.role === 'system')
      .slice(-4)
    if (!usefulItems.length) return []
    return [
      `Chat: ${conversation.title}`,
      ...usefulItems.map(item => `${item.role}: ${snippet(item.text)}`),
    ]
  })

  return lines.length ? lines.join('\n') : undefined
}

function snippet(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 360)
}
