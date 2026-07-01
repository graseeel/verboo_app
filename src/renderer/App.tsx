import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDown, FolderClosed, ShieldCheck, Terminal, XCircle } from 'lucide-react'
import type {
  AccessMode,
  AgentEvent,
  AgentResultSnapshot,
  AgentTurnRequest,
  AppConfig,
  AttachmentMeta,
  ChatStore,
  CliAuthStatus,
  ContextUsageSnapshot,
  CredentialStatus,
  FeedbackDiagnostics,
  FeedbackRequest,
  FeedbackResult,
  GoalEvaluationInput,
  GoalState,
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
import { createGoalState, goalSystemMessage } from './features/goal/goalState'
import { GoalStatusBar, type GoalStatusBarState } from './features/goal/GoalStatusBar'
import { runGoalCycle, type GoalSchedulerDelegate } from './features/goal/goalScheduler'
import type { ReservedSlashCommand } from './features/composer/slashCommands'
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
const AUTH_SESSION_KEY = 'verboo:last-verified-auth'
const AUTH_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const CONTEXT_WINDOWS_KEY = 'verboo:context-windows-by-model'
const THEME_KEY = 'verboo:theme'
const SIDEBAR_PREF_KEY = 'verboo:sidebar-preference'
const SIDEBAR_DEFAULT_WIDTH = 292
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const SIDEBAR_COMPACT_WIDTH = 72
const DEFAULT_USER_SETTINGS: UserSettings = {
  defaultAccessMode: 'approval',
  showInMenuBar: true,
  showMenuBarText: true,
  staySignedIn: true,
  preventSleepWhileRunning: true,
  completionNotifications: 'background',
  permissionNotifications: true,
  questionNotifications: true,
  personality: 'pragmatic',
  customInstructions: '',
  trustedCommands: [],
  memoriesEnabled: false,
  chroniclePreview: false,
  ignoreToolChatsForMemory: true,
  goalMode: {
    enabled: true,
    maxTurns: 3,
    maxElapsedMinutes: 30,
    allowAutoAccess: true,
  },
}
const EMPTY_LINES = [
  'Bom te ver por aqui.',
  'Vamos deixar esse projeto mais claro.',
  'Qual parte merece atencao agora?',
  'Pronto para trabalhar com contexto de verdade.',
]

type TurnActivity = {
  key: string
  label: string
  detail?: string
  kind: NonNullable<TranscriptItem['activityKind']>
}

type QueuedFollowUp = {
  id: string
  conversationId: string
  message: string
  request: AgentTurnRequest
  turnModel: {
    modelId?: string
    modelDisplayName?: string
  }
}

type PendingPermissionPrompt = {
  id: string
  turnId: string
  conversationId: string
  command?: string
  detail: string
  autoApprove: boolean
}

type PermissionDecision = 'allow' | 'deny' | 'always'
type SidebarMode = 'expanded' | 'compact' | 'hidden'

export function App() {
  const initialSidebarPreference = useRef(readSidebarPreference())
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
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedFollowUp[]>([])
  const [pendingPermissionPrompt, setPendingPermissionPrompt] = useState<PendingPermissionPrompt | undefined>()
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | undefined>()
  const [goal, setGoal] = useState<GoalState | undefined>()
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(initialSidebarPreference.current.mode)
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarPreference.current.width)
  const goalRef = useRef(goal)
  const [goalBarStatus, setGoalBarStatus] = useState<GoalStatusBarState>({ kind: 'idle' })
  const [emptyLine] = useState(() => EMPTY_LINES[Math.floor(Math.random() * EMPTY_LINES.length)])
  const workspaceRef = useRef<HTMLElement | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const userSettingsRef = useRef(userSettings)
  const turnConversationIds = useRef<Record<string, string>>({})
  const turnModels = useRef<Record<string, { modelId?: string; modelDisplayName?: string }>>({})
  const pendingConversationId = useRef<string | undefined>(undefined)
  const goalSessionId = useRef<string | undefined>(undefined)
  const goalAbortRef = useRef<AbortController | undefined>(undefined)
  const queuedFollowUpsRef = useRef<QueuedFollowUp[]>([])
  const lastEscapeAt = useRef(0)
  const selectedContextWindowRef = useRef<number | undefined>(undefined)
  const turnStartedAt = useRef<Record<string, number>>({})
  const turnActivityKeys = useRef<Record<string, Set<string>>>({})
  const turnActivityCounts = useRef<Record<string, Partial<Record<NonNullable<TranscriptItem['activityKind']>, number>>>>({})
  const turnResultSnapshots = useRef<Record<string, AgentResultSnapshot>>({})
  const turnTerminalErrors = useRef<Record<string, string[]>>({})
  const turnCompletionDeferred = useRef<{ turnId: string; resolve: () => void; reject: (reason: unknown) => void } | undefined>(undefined)
  const turnAssistantText = useRef<Record<string, string>>({})
  const turnLastCommand = useRef<Record<string, string>>({})
  const autoApprovalSent = useRef<Set<string>>(new Set())

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
  const conversationItemsRef = useRef<readonly TranscriptItem[]>(items)
  const hasConversation = items.some(item => item.role === 'user' || item.role === 'assistant')
  const latestItem = items[items.length - 1]
  const latestItemSignature = `${latestItem?.id ?? ''}:${latestItem?.text.length ?? 0}:${latestItem?.streaming ? 1 : 0}`
  const visiblePermissionPrompt = pendingPermissionPrompt && pendingPermissionPrompt.conversationId === activeConversationId && !pendingPermissionPrompt.autoApprove
    ? pendingPermissionPrompt
    : undefined
  const effectiveSidebarWidth = sidebarMode === 'hidden'
    ? 0
    : sidebarMode === 'compact'
      ? SIDEBAR_COMPACT_WIDTH
      : sidebarWidth
  const appLayoutStyle = { '--sidebar-width': `${effectiveSidebarWidth}px` } as CSSProperties

  useEffect(() => {
    let cancelled = false

    async function loadStartupState() {
      const [settings, nextConfig] = await Promise.all([
        window.verboo.getUserSettings(),
        window.verboo.getConfig(),
      ])
      if (cancelled) return
      setUserSettings(settings)
      setAccessMode(settings.defaultAccessMode)
      setConfig(nextConfig)
      setAccessMode(nextConfig.accessMode)
      if (settings.staySignedIn && readRememberedAuthSession()) {
        setEntryUnlocked(true)
      }
      void validateAccess(!settings.staySignedIn, settings.staySignedIn)
    }

    void loadStartupState()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    saveSidebarPreference({ mode: sidebarMode, width: sidebarWidth })
  }, [sidebarMode, sidebarWidth])

  useEffect(() => {
    function handleSidebarShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'b') return
      event.preventDefault()
      event.stopPropagation()
      toggleSidebarVisibility()
    }

    window.addEventListener('keydown', handleSidebarShortcut, { capture: true })
    return () => window.removeEventListener('keydown', handleSidebarShortcut, { capture: true })
  }, [])

  useEffect(() => {
    const workingDirectory = activeProject?.path ?? config.workingDirectory
    if (!workingDirectory) return
    window.verboo.listSkills(workingDirectory).then(setSkills)
  }, [config.workingDirectory, activeProject?.path])

  useEffect(() => {
    return window.verboo.onAgentEvent(handleAgentEvent)
  }, [])

  useEffect(() => {
    goalRef.current = goal
  }, [goal])

  useEffect(() => {
    conversationItemsRef.current = items
  }, [items])

  useEffect(() => {
    userSettingsRef.current = userSettings
  }, [userSettings])

  useEffect(() => {
    if (activeView !== 'chat') return
    if (!hasConversation) return
    if (!stickToBottomRef.current) {
      setShowJumpToLatest(true)
      return
    }
    scrollToLatest('smooth')
  }, [activeView, activeConversationId, hasConversation, latestItemSignature])

  useEffect(() => {
    if (!pendingPermissionPrompt?.autoApprove) return
    if (autoApprovalSent.current.has(pendingPermissionPrompt.id)) return
    autoApprovalSent.current.add(pendingPermissionPrompt.id)
    void respondToPermissionPrompt(pendingPermissionPrompt, 'allow', true)
  }, [pendingPermissionPrompt])

  useEffect(() => {
    return window.verboo.onRefreshDataRequest(() => {
      void refreshModels(true)
      void refreshProfile()
      void validateAccess(true)
    })
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
    if (runningTurnId || queuedFollowUps.length === 0) return
    void flushQueuedFollowUps()
  }, [runningTurnId, queuedFollowUps])

  useEffect(() => {
    function handleEscapeInterrupt(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !runningTurnId) return
      event.preventDefault()
      event.stopPropagation()
      const now = Date.now()
      if (now - lastEscapeAt.current <= 1300) {
        lastEscapeAt.current = 0
        goalAbortRef.current?.abort()
        void window.verboo.interrupt()
        return
      }
      lastEscapeAt.current = now
    }

    window.addEventListener('keydown', handleEscapeInterrupt, { capture: true })
    return () => window.removeEventListener('keydown', handleEscapeInterrupt, { capture: true })
  }, [runningTurnId])

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

  function toggleSidebarVisibility() {
    setSidebarMode(current => current === 'hidden' ? 'expanded' : 'hidden')
  }

  function toggleSidebarCompact() {
    setSidebarMode(current => current === 'compact' ? 'expanded' : 'compact')
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarMode === 'compact' ? SIDEBAR_COMPACT_WIDTH : sidebarWidth
    setSidebarMode('expanded')

    function handlePointerMove(moveEvent: PointerEvent) {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX))
    }

    function stopResize() {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
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
      forgetRememberedAuthSession()
      setEntryUnlocked(false)
      setActiveView('chat')
      setAuthError(result.ok ? undefined : result.message)
    } finally {
      setAuthChecking(false)
    }
  }

  async function validateAccess(forceRefresh: boolean, allowRememberedSession = userSettings.staySignedIn): Promise<boolean> {
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
      if (unlocked) {
        writeRememberedAuthSession(allowRememberedSession, credentialStatus, cliStatus, modelDiscovery)
        await refreshProfile()
        return true
      }

      const rememberedSession = allowRememberedSession ? readRememberedAuthSession() : undefined
      if (rememberedSession && hasLocalAuthEvidence(credentialStatus, cliStatus)) {
        setEntryUnlocked(true)
        setAuthError(modelDiscovery.error ?? cliStatus.error)
        void refreshProfile()
        return true
      }

      if (!allowRememberedSession) forgetRememberedAuthSession()
      setAuthError(modelDiscovery.error ?? cliStatus.error ?? 'Entre com Verboo pelo CLI ou salve uma chave API valida.')
      return false
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
    if (patch.staySignedIn === false) forgetRememberedAuthSession()
  }

  async function updateStaySignedIn(staySignedIn: boolean) {
    await updateUserSettings({ staySignedIn })
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
      turnStartedAt.current[event.turnId] = Date.now()
      turnActivityKeys.current[event.turnId] = new Set()
      turnActivityCounts.current[event.turnId] = {}
      turnTerminalErrors.current[event.turnId] = []
      setRunningTurnId(event.turnId)
      if (conversationId) {
        appendActivityItem(conversationId, event.turnId, {
          key: 'turn:thinking',
          label: 'Pensando',
          kind: 'thinking',
        })
        appendAssistantPlaceholder(conversationId, event.turnId)
      }
      return
    }

    if (event.type === 'stdout') {
      const conversationId = turnConversationIds.current[event.turnId]
      if (conversationId) {
        appendAssistantText(conversationId, event.turnId, event.text)
        trackPermissionPrompt(conversationId, event.turnId, event.text)
      }
      return
    }

    if (event.type === 'stderr') {
      const conversationId = turnConversationIds.current[event.turnId]
      const cleanText = event.text.trim()
      if (cleanText) {
        turnTerminalErrors.current[event.turnId] = [
          ...(turnTerminalErrors.current[event.turnId] ?? []),
          cleanText,
        ]
      }
      if (conversationId) {
        appendActivityItem(conversationId, event.turnId, {
          key: `stderr:${snippet(event.text)}`,
          label: 'Leu terminal',
          detail: snippet(event.text),
          kind: 'terminal',
        })
      }
      return
    }

    if (event.type === 'json') {
      const conversationId = turnConversationIds.current[event.turnId]
      const usage = extractContextUsage(event.payload, selectedContextWindowRef.current)
      if (usage) {
        setContextUsage(usage)
        if (conversationId && usage.maxTokens && usage.usedTokens > usage.maxTokens) {
          appendActivityItem(conversationId, event.turnId, {
            key: `context-over:${usage.maxTokens}`,
            label: 'Contexto acima do limite configurado',
            detail: `${formatCompactNumber(usage.usedTokens)} de ${formatCompactNumber(usage.maxTokens)} reportados pelo CLI.`,
            kind: 'context',
          })
        }
      }
      const activity = describeRuntimeActivity(event.payload)
      if (conversationId && activity) {
        if (activity.kind === 'command' && activity.detail) {
          turnLastCommand.current[event.turnId] = activity.detail
        }
        appendActivityItem(conversationId, event.turnId, activity)
      }
      return
    }

    if (event.type === 'result') {
      turnResultSnapshots.current[event.turnId] = event.result
      if (event.result.sessionId) goalSessionId.current = event.result.sessionId
      if (event.result.usage) {
        setGoal(current => {
          if (!current) return current
          return {
            ...current,
            usedInputTokens: current.usedInputTokens + (event.result.usage?.input_tokens ?? 0),
            usedOutputTokens: current.usedOutputTokens + (event.result.usage?.output_tokens ?? 0),
          }
        })
      }
      return
    }

    if (event.type === 'error') {
      const conversationId = turnConversationIds.current[event.turnId]
      setRunningTurnId(undefined)

      // Reject goal turn completion promise on error
      if (turnCompletionDeferred.current?.turnId === event.turnId) {
        turnCompletionDeferred.current.reject(new Error(event.message))
        turnCompletionDeferred.current = undefined
      }

      if (conversationId) {
        appendConversationItem(conversationId, {
          id: `${event.turnId}:error`,
          role: 'system',
          text: event.message,
          timestamp: Date.now(),
        })
      }
      delete turnAssistantText.current[event.turnId]
      delete turnLastCommand.current[event.turnId]
      return
    }

    if (event.type === 'done') {
      const conversationId = turnConversationIds.current[event.turnId]
      setRunningTurnId(undefined)
      if (conversationId && event.exitCode !== 0) {
        const failureMessage = buildCliFailureMessage(turnTerminalErrors.current[event.turnId])
        if (failureMessage) appendAssistantText(conversationId, event.turnId, failureMessage)
      }
      if (conversationId) finishAssistantMessage(conversationId, event.turnId)
      if (conversationId) appendTurnSummary(conversationId, event.turnId, event.exitCode)

      // Resolve goal turn completion promise if this turn was started by the goal scheduler
      if (turnCompletionDeferred.current?.turnId === event.turnId) {
        turnCompletionDeferred.current.resolve()
        turnCompletionDeferred.current = undefined
      }

      delete turnConversationIds.current[event.turnId]
      delete turnStartedAt.current[event.turnId]
      delete turnActivityKeys.current[event.turnId]
      delete turnActivityCounts.current[event.turnId]
      delete turnResultSnapshots.current[event.turnId]
      delete turnTerminalErrors.current[event.turnId]
      delete turnAssistantText.current[event.turnId]
      delete turnLastCommand.current[event.turnId]
    }
  }

  async function sendMessage(message: string) {
    const trimmed = message.trim()
    if (!trimmed) return
    const conversationId = ensureActiveConversation()
    const queued = createQueuedFollowUp(conversationId, trimmed)
    setActiveView('chat')
    stickToBottomRef.current = true
    setShowJumpToLatest(false)
    setPendingPermissionPrompt(current => current?.conversationId === conversationId ? undefined : current)

    appendConversationItem(conversationId, {
      id: `user:${Date.now()}`,
      role: 'user',
      text: trimmed,
      timestamp: Date.now(),
      skills: selectedSkills,
    }, titleFromMessage(trimmed))

    if (runningTurnId) {
      enqueueFollowUp(queued)
      setAttachedFiles([])
      return
    }

    await runTurn(queued)
    setAttachedFiles([])
  }

  function createQueuedFollowUp(conversationId: string, message: string): QueuedFollowUp {
    const turnModel = {
      modelId: selectedModel,
      modelDisplayName: selectedModelInfo?.displayName ?? selectedModel,
    }

    return {
      id: `queue:${crypto.randomUUID()}`,
      conversationId,
      message,
      turnModel,
      request: {
        message,
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
      },
    }
  }

  function enqueueFollowUp(item: QueuedFollowUp) {
    setQueuedFollowUpsList(current => [...current, item])
    appendConversationItem(item.conversationId, {
      id: `${item.id}:queued`,
      role: 'tool',
      kind: 'activity',
      activityKind: 'queued',
      text: 'Mensagem na fila',
      activityDetail: 'Sera enviada automaticamente quando o turno atual terminar.',
      timestamp: Date.now(),
    })
  }

  async function flushQueuedFollowUps() {
    if (runningTurnId || queuedFollowUpsRef.current.length === 0) return
    const [next, ...rest] = queuedFollowUpsRef.current
    if (!next) return
    setQueuedFollowUpsList(() => rest)
    await runTurn(next)
  }

  async function runTurn(item: QueuedFollowUp) {
    pendingConversationId.current = item.conversationId
    setContextUsage(undefined)

    const turnId = await window.verboo.sendTurn(item.request)
    turnConversationIds.current[turnId] = item.conversationId
    turnModels.current[turnId] = item.turnModel
    tagAssistantMessage(item.conversationId, turnId, item.turnModel)
    if (pendingConversationId.current === item.conversationId) pendingConversationId.current = undefined
  }

  function setQueuedFollowUpsList(updater: (current: QueuedFollowUp[]) => QueuedFollowUp[]) {
    setQueuedFollowUps(current => {
      const next = updater(current)
      queuedFollowUpsRef.current = next
      return next
    })
  }

  function trackPermissionPrompt(conversationId: string, turnId: string, text: string) {
    const combined = `${turnAssistantText.current[turnId] ?? ''}${text}`
    turnAssistantText.current[turnId] = combined

    const detail = detectPermissionRequest(combined)
    if (!detail) return

    const command = turnLastCommand.current[turnId] ?? extractCommandFromPermissionText(combined)
    const trusted = command ? findTrustedCommand(command, userSettingsRef.current) : undefined

    setPendingPermissionPrompt(current => {
      if (current?.turnId === turnId) return current
      return {
        id: `permission:${turnId}:${Date.now()}`,
        turnId,
        conversationId,
        command,
        detail,
        autoApprove: Boolean(trusted),
      }
    })
  }

  async function respondToPermissionPrompt(
    prompt: PendingPermissionPrompt,
    decision: PermissionDecision,
    automatic = false,
  ) {
    if (decision === 'always' && prompt.command) {
      await rememberTrustedCommand(prompt.command)
    }
    if (decision === 'allow' && automatic && prompt.command) {
      await markTrustedCommandUsed(prompt.command)
    }

    setPendingPermissionPrompt(current => current?.id === prompt.id ? undefined : current)

    const approved = decision !== 'deny'
    appendConversationItem(prompt.conversationId, {
      id: `permission:${Date.now()}`,
      role: 'tool',
      kind: 'activity',
      activityKind: 'permission',
      text: approved
        ? automatic ? 'Permissao aprovada automaticamente' : 'Permissao aprovada'
        : 'Permissao negada',
      activityDetail: prompt.command ?? prompt.detail,
      timestamp: Date.now(),
    })

    const message = buildPermissionFollowUpMessage(prompt, decision, automatic)
    const followUp = createPermissionFollowUp(prompt.conversationId, message)
    stickToBottomRef.current = true
    setShowJumpToLatest(false)

    if (runningTurnId) {
      enqueueFollowUp(followUp)
      return
    }
    await runTurn(followUp)
  }

  function createPermissionFollowUp(conversationId: string, message: string): QueuedFollowUp {
    const turnModel = {
      modelId: selectedModel,
      modelDisplayName: selectedModelInfo?.displayName ?? selectedModel,
    }

    return {
      id: `queue:${crypto.randomUUID()}`,
      conversationId,
      message,
      turnModel,
      request: {
        message,
        model: selectedModel,
        modelSupportsVision: Boolean(selectedModelInfo?.supportsVision),
        contextWindow: selectedContextWindow,
        accessMode,
        workingDirectory: workingDirectoryForConversation(conversationId),
        skills: [],
        attachments: [],
        personality: userSettings.personality,
        customInstructions: userSettings.customInstructions,
        memoryContext: buildMemoryContext(chatStore, conversationId, userSettings),
      },
    }
  }

  async function rememberTrustedCommand(command: string) {
    const normalized = normalizeCommand(command)
    if (!normalized) return
    const now = Date.now()
    const current = userSettingsRef.current.trustedCommands
    const existing = current.find(rule => normalizeCommand(rule.command) === normalized)
    const next = existing
      ? current.map(rule => rule.id === existing.id ? { ...rule, lastUsedAt: now, useCount: rule.useCount + 1 } : rule)
      : [
          ...current,
          {
            id: crypto.randomUUID(),
            command: normalized,
            createdAt: now,
            lastUsedAt: now,
            useCount: 1,
          },
        ]
    await updateUserSettings({ trustedCommands: next })
  }

  async function markTrustedCommandUsed(command: string) {
    const normalized = normalizeCommand(command)
    const current = userSettingsRef.current.trustedCommands
    if (!current.some(rule => normalizeCommand(rule.command) === normalized)) return
    const next = current.map(rule => (
      normalizeCommand(rule.command) === normalized
        ? { ...rule, lastUsedAt: Date.now(), useCount: rule.useCount + 1 }
        : rule
    ))
    await updateUserSettings({ trustedCommands: next })
  }

  function handleGoalCommand(command: Extract<ReservedSlashCommand, { kind: 'goal' }>) {
    if (command.action === 'show') {
      return // status is shown in the GoalStatusBar
    }

    if (command.action === 'pause') {
      setGoal(current => current ? { ...current, status: 'paused' as const, pausedAt: Date.now() } : current)
      setGoalBarStatus({ kind: 'idle' })
      goalAbortRef.current?.abort()
      return
    }

    if (command.action === 'resume') {
      setGoal(current => {
        if (!current || (current.status !== 'paused' && current.status !== 'blocked' && current.status !== 'budget_limited')) return current
        const resumed: GoalState = { ...current, status: 'active', noProgressCount: 0 }
        setGoalBarStatus({ kind: 'active', objective: resumed.objective, turn: resumed.turnsRun, maxTurns: resumed.maxTurns })
        void startGoalScheduler(resumed)
        return resumed
      })
      return
    }

    if (command.action === 'clear') {
      goalAbortRef.current?.abort()
      setGoal(undefined)
      setGoalBarStatus({ kind: 'idle' })
      goalSessionId.current = undefined
      return
    }

    if (command.action === 'start' && command.objective) {
      if (accessMode === 'full') {
        const conversationId = ensureActiveConversation()
        appendConversationItem(conversationId, goalSystemMessage(
          'Goal automatico nao inicia com Acesso completo nesta versao beta. Troque para "Solicitar aprovacao" ou "Aprovar por mim" antes de comecar.'
        ))
        return
      }

      goalAbortRef.current?.abort()

      const conversationId = ensureActiveConversation()
      const wd = workingDirectoryForConversation(conversationId)

      setGoal(undefined)
      setGoalBarStatus({ kind: 'idle' })
      goalSessionId.current = undefined

      const goalState = createGoalState({
        objective: command.objective,
        accessMode,
        modelId: selectedModel,
        modelDisplayName: selectedModelInfo?.displayName,
        workingDirectory: wd,
        skills: selectedSkills,
      })

      appendConversationItem(conversationId, goalSystemMessage(`Objetivo iniciado: ${command.objective}`))

      const message = buildGoalStartMessage(command.objective, selectedSkills, wd)
      appendConversationItem(conversationId, {
        id: `user:goal:${Date.now()}`,
        role: 'user',
        text: message,
        timestamp: Date.now(),
        skills: selectedSkills,
      }, `Objetivo: ${command.objective}`)

      setGoal(goalState)
      setGoalBarStatus({ kind: 'active', objective: goalState.objective, turn: 0, maxTurns: goalState.maxTurns })

      void startGoalScheduler(goalState)
    }
  }

  async function startGoalScheduler(initialGoal: GoalState) {
    const controller = new AbortController()
    goalAbortRef.current = controller

    const delegate: GoalSchedulerDelegate = {
      getGoal: () => goalRef.current ?? initialGoal,
      updateGoal: (update) => {
        setGoal(current => {
          const updated = typeof update === 'function' ? update(current ?? initialGoal) : update
          goalRef.current = updated
          if (current) updateConversationGoal(updated)
          return updated
        })
      },
      evaluateGoal: async (currentGoal) => {
        const conversationItems = conversationItemsRef.current
        const conversationId = activeConversation?.id
        if (!conversationId || controller.signal.aborted) return { status: 'cancelled' }

        const input: GoalEvaluationInput = {
          goal: currentGoal,
          conversationItems: [...conversationItems],
        }

        try {
          const result = await window.verboo.evaluateGoal(input)
          if (controller.signal.aborted) return { status: 'cancelled' }

          setGoal(current => current ? {
            ...current,
            lastEvaluation: result.evaluation,
            updatedAt: Date.now(),
          } : current)

          if (result.evaluation.decision === 'complete') return { status: 'completed' }
          if (result.evaluation.decision === 'blocked') return { status: 'blocked', nextMessage: result.evaluation.reason }
          return { status: 'continuing', nextMessage: result.evaluation.nextMessage ?? currentGoal.objective }
        } catch {
          return { status: 'continuing', nextMessage: currentGoal.objective }
        }
      },
      continueGoal: async (currentGoal, nextMessage) => {
        if (controller.signal.aborted) return undefined

        const conversationId = activeConversation?.id
        if (!conversationId) return undefined

        const turnModel = {
          modelId: selectedModel,
          modelDisplayName: selectedModelInfo?.displayName ?? selectedModel,
        }

        appendConversationItem(conversationId, {
          id: `user:goal-continue:${Date.now()}`,
          role: 'user',
          text: nextMessage,
          timestamp: Date.now(),
        })

        setContextUsage(undefined)

        const turnId = await window.verboo.sendTurn({
          message: nextMessage,
          model: selectedModel,
          modelSupportsVision: Boolean(selectedModelInfo?.supportsVision),
          contextWindow: selectedContextWindow,
          accessMode,
          workingDirectory: currentGoal.workingDirectory,
          skills: currentGoal.skills,
          attachments: [],
          personality: userSettings.personality,
          customInstructions: userSettings.customInstructions,
          memoryContext: buildMemoryContext(chatStore, conversationId, userSettings),
        }, goalSessionId.current)

        if (controller.signal.aborted) return undefined

        turnConversationIds.current[turnId] = conversationId
        turnModels.current[turnId] = turnModel

        setGoal(current => current ? {
          ...current,
          turnsRun: current.turnsRun + 1,
          lastTurnId: turnId,
          lastSessionId: goalSessionId.current,
          updatedAt: Date.now(),
        } : current)

        // Wait for the turn to complete before continuing the goal cycle
        await new Promise<void>((resolve, reject) => {
          if (controller.signal.aborted) {
            resolve()
            return
          }
          turnCompletionDeferred.current = {
            turnId,
            resolve,
            reject,
          }
          // If aborted while waiting, resolve to unblock
          controller.signal.addEventListener('abort', () => {
            if (turnCompletionDeferred.current?.turnId === turnId) {
              turnCompletionDeferred.current = undefined
              resolve()
            }
          }, { once: true })
        })

        if (controller.signal.aborted) return undefined
        return goalSessionId.current
      },
      abortTurn: () => {
        void window.verboo.interrupt()
      },
      onStatusChange: setGoalBarStatus,
      onLog: (message) => {
        console.log('[goal]', message)
      },
    }

    await runGoalCycle(delegate)
  }

  function buildGoalStartMessage(objective: string, skills: SkillSummary[], workingDirectory: string): string {
    const skillLines = skills.length
      ? skills.map(skill => `- Use skill "${skill.name}" (${skill.path})`).join('\n')
      : ''

    return [
      `## Goal: ${objective}`,
      '',
      'You are now working autonomously toward this objective.',
      'Complete the objective step by step. Do NOT ask for confirmation for each step.',
      'When you believe the objective is complete, summarize what was done.',
      '',
      skillLines ? `Skills available:\n${skillLines}\n` : '',
      `Working directory: ${workingDirectory}`,
    ].filter(Boolean).join('\n')
  }

  function updateConversationGoal(updatedGoal: GoalState) {
    updateConversation(activeConversationId ?? '', conversation => ({
      ...conversation,
      goal: updatedGoal,
      updatedAt: Date.now(),
    }))
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
          ? { ...project, collapsed: !project.collapsed }
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

  function appendActivityItem(conversationId: string, turnId: string, activity: TurnActivity) {
    const keys = turnActivityKeys.current[turnId] ?? new Set<string>()
    turnActivityKeys.current[turnId] = keys
    if (keys.has(activity.key)) return
    keys.add(activity.key)

    if (activity.kind !== 'thinking') {
      const counts = turnActivityCounts.current[turnId] ?? {}
      counts[activity.kind] = (counts[activity.kind] ?? 0) + 1
      turnActivityCounts.current[turnId] = counts
    }

    updateConversation(conversationId, conversation => ({
      ...conversation,
      items: [
        ...conversation.items,
        {
          id: `${turnId}:activity:${keys.size}`,
          role: 'tool',
          kind: 'activity',
          activityKind: activity.kind,
          activityDetail: activity.detail,
          text: activity.label,
          timestamp: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    }))
  }

  function appendTurnSummary(conversationId: string, turnId: string, exitCode: number | null) {
    const startedAt = turnStartedAt.current[turnId]
    const elapsed = startedAt ? formatElapsed(Date.now() - startedAt) : 'alguns segundos'
    const counts = turnActivityCounts.current[turnId] ?? {}
    const result = turnResultSnapshots.current[turnId]
    const summaryLines = buildTurnSummaryLines(counts, result, exitCode)

    appendConversationItem(conversationId, {
      id: `${turnId}:summary`,
      role: 'system',
      kind: 'summary',
      text: `Trabalhou por ${elapsed}`,
      activityDetail: summaryLines.join('\n'),
      timestamp: Date.now(),
    })
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

  function handleWorkspaceScroll() {
    if (activeView !== 'chat') return
    const element = workspaceRef.current
    if (!element) return
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    const atBottom = distanceFromBottom < 96
    stickToBottomRef.current = atBottom
    setShowJumpToLatest(!atBottom && hasConversation)
  }

  function scrollToLatest(behavior: ScrollBehavior = 'smooth') {
    stickToBottomRef.current = true
    setShowJumpToLatest(false)
    window.requestAnimationFrame(() => {
      transcriptEndRef.current?.scrollIntoView({ block: 'end', behavior })
    })
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
      label: runningTurnId ? 'working' : 'ready',
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
          staySignedIn={userSettings.staySignedIn}
          onStartLogin={startCliLogin}
          onOpenDashboard={() => window.verboo.openDashboard()}
          onOpenSignup={() => window.verboo.openSignup()}
          onCheckExistingAuth={() => validateAccess(true)}
          onSaveApiKey={saveApiKey}
          onStaySignedInChange={updateStaySignedIn}
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
    <main className="app-shell" style={appLayoutStyle}>
      <TopBar sidebarVisible={sidebarMode !== 'hidden'} onToggleSidebar={toggleSidebarVisibility} />

      <div
        className={`app-layout sidebar-${sidebarMode} ${activeView === 'settings' ? 'settings-open' : ''}`}
      >
        {sidebarMode !== 'hidden' && (
          <>
            <AppSidebar
              activeView={activeView}
              projects={shownProjects}
              conversations={shownConversations}
              activeConversationId={activeConversationId}
              selectedProjectId={selectedProjectId}
              profile={profile}
              cliAuth={cliAuth}
              compact={sidebarMode === 'compact'}
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
            <div
              className="sidebar-resizer"
              role="separator"
              aria-orientation="vertical"
              title="Arraste para redimensionar. Duplo clique para compactar."
              onPointerDown={startSidebarResize}
              onDoubleClick={toggleSidebarCompact}
            />
          </>
        )}

        <section
          ref={workspaceRef}
          className={`workspace ${activeView === 'chat' && !hasConversation ? 'empty-workspace' : ''} ${activeView === 'settings' ? 'settings-workspace' : ''}`}
          onScroll={handleWorkspaceScroll}
        >
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
            <>
              <Transcript items={items} />
              <div ref={transcriptEndRef} className="transcript-end" />
            </>
          ) : (
            <EmptyChat projectName={projectName || 'Sem projeto'} line={emptyLine} />
          )}
        </section>
      </div>
      <GoalStatusBar
        status={goalBarStatus}
        onPause={() => handleGoalCommand({ kind: 'goal', action: 'pause', raw: '/goal pause' })}
        onResume={() => handleGoalCommand({ kind: 'goal', action: 'resume', raw: '/goal resume' })}
        onCancel={() => handleGoalCommand({ kind: 'goal', action: 'clear', raw: '/goal clear' })}
        onClear={() => handleGoalCommand({ kind: 'goal', action: 'clear', raw: '/goal clear' })}
      />

      {activeView === 'chat' && showJumpToLatest && hasConversation && (
        <button className="jump-to-latest" type="button" onClick={() => scrollToLatest('smooth')} title="Ir para a ultima mensagem">
          <ArrowDown size={17} />
        </button>
      )}

      {activeView === 'chat' && (
        <div className={`bottom-dock ${hasConversation ? '' : 'empty-mode'}`}>
          {visiblePermissionPrompt && (
            <PermissionApprovalPanel
              prompt={visiblePermissionPrompt}
              onAllow={() => respondToPermissionPrompt(visiblePermissionPrompt, 'allow')}
              onDeny={() => respondToPermissionPrompt(visiblePermissionPrompt, 'deny')}
              onAlwaysAllow={() => respondToPermissionPrompt(visiblePermissionPrompt, 'always')}
            />
          )}
          <Composer
            disabled={false}
            skills={skills}
            selectedSkills={selectedSkills}
            attachments={attachedFiles}
            onSelectedSkillsChange={setSelectedSkills}
            onAttachFiles={attachFiles}
            onRemoveAttachment={path => setAttachedFiles(current => current.filter(item => item.path !== path))}
            onSubmit={sendMessage}
            onGoalCommand={handleGoalCommand}
            busy={Boolean(runningTurnId)}
            queuedCount={queuedFollowUps.length}
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

function PermissionApprovalPanel({
  prompt,
  onAllow,
  onDeny,
  onAlwaysAllow,
}: {
  prompt: PendingPermissionPrompt
  onAllow: () => void
  onDeny: () => void
  onAlwaysAllow: () => void
}) {
  return (
    <section className="permission-approval-panel" aria-live="polite">
      <div className="permission-approval-icon">
        <Terminal size={16} />
      </div>
      <div className="permission-approval-copy">
        <strong>Permitir esta acao?</strong>
        <p>{prompt.command ? 'O agente quer executar um comando antes de continuar.' : prompt.detail}</p>
        {prompt.command && <code>{prompt.command}</code>}
      </div>
      <div className="permission-approval-actions">
        <button type="button" onClick={onDeny}>
          <XCircle size={15} />
          Negar
        </button>
        {prompt.command && (
          <button className="trust" type="button" onClick={onAlwaysAllow}>
            <ShieldCheck size={15} />
            Sempre permitir
          </button>
        )}
        <button className="primary" type="button" onClick={onAllow}>
          Permitir
        </button>
      </div>
    </section>
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

function readRememberedAuthSession(): { verifiedAt: number } | undefined {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AUTH_SESSION_KEY) ?? 'null') as unknown
    if (!parsed || typeof parsed !== 'object' || !('verifiedAt' in parsed)) return undefined
    const verifiedAt = Number(parsed.verifiedAt)
    if (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt > AUTH_SESSION_MAX_AGE_MS) {
      forgetRememberedAuthSession()
      return undefined
    }
    return { verifiedAt }
  } catch {
    return undefined
  }
}

function writeRememberedAuthSession(
  enabled: boolean,
  credentials: CredentialStatus,
  cliAuth: CliAuthStatus,
  modelResult: ModelDiscoveryResult,
): void {
  if (!enabled) {
    forgetRememberedAuthSession()
    return
  }
  window.localStorage.setItem(
    AUTH_SESSION_KEY,
    JSON.stringify({
      verifiedAt: Date.now(),
      source: modelResult.source,
      email: cliAuth.email,
      apiKeyHint: credentials.apiKeyHint,
    }),
  )
}

function forgetRememberedAuthSession(): void {
  window.localStorage.removeItem(AUTH_SESSION_KEY)
}

function hasLocalAuthEvidence(credentials: CredentialStatus, cliAuth: CliAuthStatus): boolean {
  return cliAuth.loggedIn || credentials.hasApiKey
}

function readTheme(): ThemeMode {
  return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
}

function readSidebarPreference(): { mode: SidebarMode; width: number } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SIDEBAR_PREF_KEY) ?? '{}') as unknown
    if (!isRecord(parsed)) return { mode: 'expanded', width: SIDEBAR_DEFAULT_WIDTH }
    const mode = parsed.mode === 'compact' || parsed.mode === 'hidden' ? parsed.mode : 'expanded'
    const width = typeof parsed.width === 'number' ? clampSidebarWidth(parsed.width) : SIDEBAR_DEFAULT_WIDTH
    return { mode, width }
  } catch {
    return { mode: 'expanded', width: SIDEBAR_DEFAULT_WIDTH }
  }
}

function saveSidebarPreference(preference: { mode: SidebarMode; width: number }) {
  window.localStorage.setItem(
    SIDEBAR_PREF_KEY,
    JSON.stringify({
      mode: preference.mode,
      width: clampSidebarWidth(preference.width),
    }),
  )
}

function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)))
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

function describeRuntimeActivity(payload: unknown): TurnActivity | undefined {
  const subagent = describeSubagentActivity(payload)
  if (subagent) return subagent

  const block = extractToolBlock(payload)
  if (!block) return undefined

  const name = textValue(block.name) || textValue(block.tool_name)
  if (!name) return undefined

  const input = toolInput(block)
  const id = textValue(block.id)
  const detail = detailForTool(name, input)
  const activity = activityForTool(name)

  return {
    key: `${id || name}:${detail ?? ''}`,
    label: activity.label,
    detail,
    kind: activity.kind,
  }
}

function extractToolBlock(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined

  if (isToolBlock(payload)) return payload

  const event = isRecord(payload.event) ? payload.event : undefined
  const contentBlock = isRecord(event?.content_block) ? event.content_block : undefined
  if (isToolBlock(contentBlock)) return contentBlock

  const message = isRecord(payload.message) ? payload.message : undefined
  const content = Array.isArray(message?.content) ? message.content : undefined
  return content?.find((block): block is Record<string, unknown> => isToolBlock(block))
}

function isToolBlock(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const type = textValue(value.type).toLowerCase()
  return type.includes('tool_use') || Boolean(textValue(value.name) || textValue(value.tool_name))
}

function activityForTool(toolName: string): Pick<TurnActivity, 'label' | 'kind'> {
  const normalized = toolName.toLowerCase()
  if (normalized === 'task') return { label: 'Subagente ativo', kind: 'subagent' }
  if (normalized === 'read' || normalized === 'read_file') return { label: 'Leu arquivo', kind: 'read' }
  if (normalized === 'ls' || normalized === 'glob' || normalized === 'grep' || normalized === 'search') return { label: 'Inspecionou arquivos', kind: 'read' }
  if (normalized === 'edit' || normalized === 'multiedit' || normalized === 'multi_edit' || normalized === 'write' || normalized === 'notebookedit') {
    return { label: 'Editou arquivo', kind: 'edit' }
  }
  if (normalized === 'bash' || normalized === 'shell' || normalized === 'exec_command') return { label: 'Executou comando', kind: 'command' }
  if (normalized === 'websearch' || normalized === 'webfetch') return { label: 'Pesquisou na internet', kind: 'search' }
  if (normalized === 'askuserquestion') return { label: 'Pediu resposta', kind: 'permission' }
  if (normalized === 'todowrite') return { label: 'Atualizou tarefas', kind: 'tool' }
  return { label: 'Usou ferramenta', kind: 'tool' }
}

function detailForTool(toolName: string, input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined
  const normalized = toolName.toLowerCase()
  if (normalized === 'task') return snippet(textValue(input.description) || textValue(input.subagent_type) || textValue(input.prompt))
  if (normalized === 'bash' || normalized === 'shell' || normalized === 'exec_command') return snippet(textValue(input.command) || textValue(input.cmd))
  if (normalized === 'websearch') return snippet(textValue(input.query))
  if (normalized === 'webfetch') return snippet(textValue(input.url))
  if (normalized === 'grep') return snippet(textValue(input.pattern) || textValue(input.path))
  if (normalized === 'glob') return snippet(textValue(input.pattern))
  if (normalized === 'ls') return snippet(textValue(input.path))
  if (normalized === 'askuserquestion') return snippet(textValue(input.question))
  return snippet(textValue(input.file_path) || textValue(input.filePath) || textValue(input.path) || textValue(input.notebook_path))
}

function toolInput(block: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(block.input)) return block.input
  if (isRecord(block.arguments)) return block.arguments
  const inputJson = textValue(block.input_json) || textValue(block.arguments_json)
  if (!inputJson) return undefined
  try {
    const parsed = JSON.parse(inputJson) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function describeSubagentActivity(payload: unknown): TurnActivity | undefined {
  if (!isRecord(payload)) return undefined
  const event = isRecord(payload.event) ? payload.event : undefined
  const eventType = textValue(event?.type) || textValue(payload.type)
  const normalized = eventType.toLowerCase()
  if (!normalized.includes('subagent')) return undefined
  const started = normalized.includes('start')
  const stopped = normalized.includes('stop')
  const label = started ? 'Subagente iniciado' : stopped ? 'Subagente finalizado' : 'Subagente ativo'
  return {
    key: `subagent:${eventType}`,
    label,
    detail: snippet(textValue(payload.agentName) || textValue(payload.agentType) || textValue(event?.agentName) || textValue(event?.agentType)),
    kind: 'subagent',
  }
}

function buildTurnSummaryLines(
  counts: Partial<Record<NonNullable<TranscriptItem['activityKind']>, number>>,
  result: AgentResultSnapshot | undefined,
  exitCode: number | null,
): string[] {
  const actions = [
    actionCount(counts.read, 'leu/inspecionou arquivos'),
    actionCount(counts.edit, 'editou arquivos'),
    actionCount(counts.command, 'executou comandos'),
    actionCount(counts.search, 'pesquisou na internet'),
    actionCount(counts.terminal, 'leu terminal'),
    actionCount(counts.permission, 'pediu permissao/resposta'),
    actionCount(counts.tool, 'usou ferramentas'),
  ].filter(Boolean)

  const lines = actions.length ? [`Resumo: ${actions.join(', ')}.`] : []

  if (result?.stopReason) lines.push(`Motivo de parada: ${result.stopReason}.`)
  if (exitCode !== 0) lines.push(`Processo terminou com codigo ${exitCode ?? 'desconhecido'}.`)
  return lines
}

function buildCliFailureMessage(lines: string[] | undefined): string | undefined {
  const cleaned = (lines ?? [])
    .flatMap(line => line.split(/\r?\n/))
    .map(line => cleanCliFailureLine(line))
    .filter(Boolean)
  const important = cleaned.filter(line =>
    !line.includes('[DEBUG]') &&
    !line.includes('Broken symlink or missing file'),
  )
  const visible = (important.length ? important : cleaned).slice(-4)
  if (visible.length === 0) return undefined
  return `Nao consegui executar o agente.\n\n${visible.join('\n')}\n`
}

function cleanCliFailureLine(line: string): string {
  return line.replace(/\x1B\[[0-9;]*m/g, '').trim()
}

function detectPermissionRequest(text: string): string | undefined {
  const normalized = text.toLowerCase()
  const asksForApproval = (
    normalized.includes('aprovar') ||
    normalized.includes('autoriza') ||
    normalized.includes('permitir') ||
    normalized.includes('pode rodar') ||
    normalized.includes('can i run')
  )
  const mentionsAction = (
    normalized.includes('comando') ||
    normalized.includes('command') ||
    normalized.includes('acao') ||
    normalized.includes('ação') ||
    normalized.includes('executar') ||
    normalized.includes('rodar')
  )
  if (!asksForApproval || !mentionsAction) return undefined

  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  const focusedLine = [...lines].reverse().find(line => {
    const value = line.toLowerCase()
    return value.includes('aprovar') || value.includes('permitir') || value.includes('autoriza') || value.includes('can i run')
  })
  return snippet(focusedLine ?? 'O agente pediu permissao para continuar.')
}

function extractCommandFromPermissionText(text: string): string | undefined {
  const commandLike = /^(npm|pnpm|yarn|bun|node|npx|git|python|python3|pip|uv|make|cargo|go|swift|xcodebuild|electron-builder|rm|mv|cp|mkdir|touch)\b/
  const matches = [...text.matchAll(/`([^`\n]+)`/g)]
    .map(match => normalizeCommand(match[1] ?? ''))
    .filter(Boolean)
  return matches.reverse().find(value => commandLike.test(value))
}

function buildPermissionFollowUpMessage(
  prompt: PendingPermissionPrompt,
  decision: PermissionDecision,
  automatic: boolean,
): string {
  if (decision === 'deny') {
    return [
      'Permissao negada.',
      prompt.command ? `Nao execute este comando: ${prompt.command}` : '',
      'Continue com uma alternativa segura ou explique o bloqueio de forma objetiva.',
    ].filter(Boolean).join('\n')
  }

  return [
    automatic ? 'Permissao aprovada automaticamente por regra confiavel salva neste app.' : 'Permissao aprovada.',
    prompt.command ? `Comando aprovado: ${prompt.command}` : '',
    'Continue exatamente do ponto em que parou e execute apenas a acao aprovada antes de seguir.',
  ].filter(Boolean).join('\n')
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

function findTrustedCommand(command: string, settings: UserSettings): UserSettings['trustedCommands'][number] | undefined {
  const normalized = normalizeCommand(command)
  if (!normalized) return undefined
  return settings.trustedCommands.find(rule => normalizeCommand(rule.command) === normalized)
}

function actionCount(count: number | undefined, label: string): string | undefined {
  return count && count > 0 ? `${count} ${label}` : undefined
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes}m ${rest}s` : `${seconds}s`
}

function formatCompactNumber(value: number): string {
  return Intl.NumberFormat('pt-BR', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
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
