import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDown, CheckCircle2, ChevronDown, ChevronRight, FolderClosed, GitBranch, LoaderCircle, ShieldCheck, Terminal, XCircle } from 'lucide-react'
import type {
  AccessMode,
  AgentEvent,
  AgentResultSnapshot,
  AgentTurnRequest,
  AppConfig,
  AttachmentMeta,
  ChatStore,
  CliAuthStatus,
  CommandRun,
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
  ResearchSubagentResult,
  RuntimeActivity,
  SettingsTab,
  SkillSummary,
  StoredConversation,
  ThemeMode,
  TranscriptItem,
  UserSettings,
  VerbooModel,
  WorkspaceChangeEntry,
  WorkspaceChangeSummary,
  WorkspaceReviewMetadata,
} from '../shared/types'
import { createGoalState, goalSystemMessage } from './features/goal/goalState'
import { GoalStatusBar, type GoalStatusBarState } from './features/goal/GoalStatusBar'
import { runGoalCycle, type GoalSchedulerDelegate } from './features/goal/goalScheduler'
import type { ReservedSlashCommand } from './features/composer/slashCommands'
import { AppSidebar, type AppView } from './components/AppSidebar'
import { useLocalTerminal } from './features/terminal/useLocalTerminal'
import { LocalTerminalPanel } from './features/terminal/LocalTerminalPanel'
import { ReviewPanel } from './features/review/ReviewPanel'
import { useReviewPanel } from './features/review/useReviewPanel'
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
import mascotUrl from '../../assets/branding/verboo-mascot.png'
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
const BOTTOM_STICK_THRESHOLD = 72
const SCROLL_SETTLE_MS = 360
const DEFAULT_USER_SETTINGS: UserSettings = {
  defaultAccessMode: 'approval',
  fullAccessEnabled: false,
  lastSelectedModelId: undefined,
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
  'Qual parte merece atenção agora?',
  'Pronto para trabalhar com contexto de verdade.',
]

type TurnActivity = RuntimeActivity

type ActiveSubagent = {
  id: string
  runId?: string
  label: string
  detail?: string
  mission?: string
  history?: ActiveSubagentHistoryItem[]
  status: 'thinking' | 'reading' | 'searching' | 'done' | 'failed'
  updatedAt: number
}

type ActiveSubagentHistoryItem = {
  id: string
  label: string
  text: string
  timestamp: number
}

const SUBAGENT_NAMES = [
  'Atlas',
  'Nova',
  'Orbit',
  'Prism',
  'Quill',
  'Ember',
  'Lumen',
  'Cobalt',
  'Vale',
  'Sable',
  'Mira',
  'Solis',
  'Argo',
  'Pixel',
  'Nimbo',
  'Calyx',
  'Rune',
  'Vela',
  'Koda',
  'Onyx',
  'Lyra',
  'Juno',
  'Aster',
  'Vector',
  'Quartz',
  'Slate',
  'Terra',
  'Echo',
  'Flux',
  'Beacon',
  'Verboo Nova',
  'Verboo Trace',
  'Verboo Lens',
  'Verboo Pulse',
  'Verboo Scout',
  'North',
  'Delta',
  'Indigo',
  'Radial',
  'Meridian',
]

const SUBAGENT_STATUS_LABELS: Record<ActiveSubagent['status'], string> = {
  thinking: 'pensando',
  reading: 'lendo',
  searching: 'pesquisando',
  done: 'concluído',
  failed: 'falhou',
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
  const [activeSubagents, setActiveSubagents] = useState<ActiveSubagent[]>([])
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | undefined>()
  const [subagentSummaryExpanded, setSubagentSummaryExpanded] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | undefined>()
  const [goal, setGoal] = useState<GoalState | undefined>()
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(initialSidebarPreference.current.mode)
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarPreference.current.width)
  const [reviewMetadata, setReviewMetadata] = useState<WorkspaceReviewMetadata | undefined>()
  const terminal = useLocalTerminal()
  const review = useReviewPanel()
  const goalRef = useRef(goal)
  const [goalBarStatus, setGoalBarStatus] = useState<GoalStatusBarState>({ kind: 'idle' })
  const [emptyLine] = useState(() => EMPTY_LINES[Math.floor(Math.random() * EMPTY_LINES.length)])
  const workspaceRef = useRef<HTMLElement | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const autoScrollingRef = useRef(false)
  const scrollSettleTimer = useRef<number | undefined>(undefined)
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
  const turnCommands = useRef<Record<string, string[]>>({})
  const turnReferences = useRef<Record<string, string[]>>({})
  const turnChangeBaselines = useRef<Record<string, WorkspaceChangeSummary | undefined>>({})
  const turnWorkingDirectories = useRef<Record<string, string>>({})
  const turnTouchedFiles = useRef<Record<string, Set<string>>>({})
  const activeSubagentsRef = useRef<Record<string, ActiveSubagent>>({})
  const pendingResearchSubagentsRef = useRef<ActiveSubagent[]>([])
  const autoApprovalSent = useRef<Set<string>>(new Set())
  const turnOpenTextSegment = useRef<Record<string, string | undefined>>({})
  const turnTextSegmentCount = useRef<Record<string, number>>({})
  const turnCommandItemIds = useRef<Record<string, Record<string, string>>>({})
  const [thinkingTurnId, setThinkingTurnId] = useState<string | undefined>(undefined)

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
  const chatStoreRef = useRef(chatStore)
  const hasConversation = items.some(item => item.role === 'user' || item.role === 'assistant')
  const latestItem = items[items.length - 1]
  const latestItemSignature = `${latestItem?.id ?? ''}:${latestItem?.text.length ?? 0}:${latestItem?.streaming ? 1 : 0}`
  const visiblePermissionPrompt = pendingPermissionPrompt && pendingPermissionPrompt.conversationId === activeConversationId && !pendingPermissionPrompt.autoApprove
    ? pendingPermissionPrompt
    : undefined
  const shouldShowLogin = !noticeAccepted || !entryUnlocked
  const effectiveSidebarWidth = sidebarMode === 'hidden'
    ? 0
    : sidebarMode === 'compact'
      ? SIDEBAR_COMPACT_WIDTH
      : sidebarWidth
  const workingSubagents = useMemo(() => activeSubagents.filter(isActiveSubagentWorking), [activeSubagents])
  const selectedSubagent = selectedSubagentId
    ? activeSubagents.find(agent => agent.id === selectedSubagentId)
    : undefined
  const showSubagentThreadPanel = activeView === 'chat' && Boolean(selectedSubagent) && !terminal.terminalOpen && !review.reviewOpen
  const showSubagentSummary = activeView === 'chat' && workingSubagents.length > 0 && !terminal.terminalOpen && !review.reviewOpen
  const appLayoutStyle = {
    '--sidebar-width': `${effectiveSidebarWidth}px`,
    '--subagents-panel-width': showSubagentThreadPanel ? '320px' : '0px',
    '--terminal-width': terminal.terminalOpen ? `${terminal.terminalWidth}px` : '0px',
    '--review-width': review.reviewOpen ? `${review.reviewWidth}px` : '0px',
  } as CSSProperties

  useEffect(() => {
    if (!selectedSubagentId) return
    if (activeSubagents.some(agent => agent.id === selectedSubagentId)) return
    setSelectedSubagentId(undefined)
  }, [activeSubagents, selectedSubagentId])

  useEffect(() => {
    if (runningTurnId || workingSubagents.length > 0) return
    setSelectedSubagentId(undefined)
    setSubagentSummaryExpanded(false)
  }, [runningTurnId, workingSubagents.length])

  useEffect(() => {
    let cancelled = false

    async function loadStartupState() {
      const [settings, nextConfig] = await Promise.all([
        window.verboo.getUserSettings(),
        window.verboo.getConfig(),
      ])
      if (cancelled) return
      setUserSettings(settings)
      setSelectedModel(settings.lastSelectedModelId)
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
    const workingDirectory = activeProject?.path ?? config.workingDirectory
    if (!workingDirectory) return
    window.verboo.getWorkspaceReviewMetadata(workingDirectory).then(setReviewMetadata)
  }, [config.workingDirectory, activeProject?.path])

  useEffect(() => {
    return window.verboo.onAgentEvent(handleAgentEvent)
  }, [])

  useEffect(() => {
    return () => {
      if (scrollSettleTimer.current) window.clearTimeout(scrollSettleTimer.current)
    }
  }, [])

  useEffect(() => {
    goalRef.current = goal
  }, [goal])

  useEffect(() => {
    conversationItemsRef.current = items
  }, [items])

  // Debounced persistence: mirror the store into a ref immediately, but only
  // write to localStorage 400ms after changes settle. This collapses the burst
  // of per-token updates during a streaming turn into a single write.
  useEffect(() => {
    chatStoreRef.current = chatStore
    const timer = window.setTimeout(() => persistChatStore(chatStore), 400)
    return () => window.clearTimeout(timer)
  }, [chatStore])

  // Guarantee the latest store is flushed when the window closes or the app
  // unmounts, so debouncing never drops the final state.
  useEffect(() => {
    const flush = () => persistChatStore(chatStoreRef.current)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [])

  useEffect(() => {
    userSettingsRef.current = userSettings
  }, [userSettings])

  useLayoutEffect(() => {
    if (shouldShowLogin || activeView !== 'chat' || !hasConversation || !workspaceRef.current) return undefined

    stickToBottomRef.current = true
    setShowJumpToLatest(false)
    forceWorkspaceToBottom()
    const frame = window.requestAnimationFrame(forceWorkspaceToBottom)
    const timeout = window.setTimeout(forceWorkspaceToBottom, 180)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
    }
  }, [activeView, activeConversationId, hasConversation, shouldShowLogin])

  useLayoutEffect(() => {
    if (shouldShowLogin || activeView !== 'chat' || !hasConversation || !workspaceRef.current) return undefined

    if (!stickToBottomRef.current) {
      setShowJumpToLatest(true)
      return undefined
    }

    scrollToLatest(latestItem?.streaming ? 'auto' : 'smooth')
    return undefined
  }, [activeView, activeConversationId, hasConversation, latestItemSignature, shouldShowLogin])

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
      return resolveSelectedModel(result.models, current, userSettingsRef.current.lastSelectedModelId)
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
        return resolveSelectedModel(modelDiscovery.models, current, userSettingsRef.current.lastSelectedModelId)
      })

      const unlocked = isVerifiedModelDiscovery(modelDiscovery)
      setEntryUnlocked(unlocked)
      if (unlocked) {
        writeRememberedAuthSession(allowRememberedSession, credentialStatus, cliStatus, modelDiscovery)
        await refreshProfile()
        return true
      }

      const rememberedSession = allowRememberedSession ? readRememberedAuthSession() : undefined
      if (rememberedSession && !isAuthoritativelySignedOut(credentialStatus, cliStatus)) {
        setEntryUnlocked(true)
        setAuthError(modelDiscovery.error ?? cliStatus.error)
        void refreshProfile()
        return true
      }

      if (!allowRememberedSession) forgetRememberedAuthSession()
      setAuthError(modelDiscovery.error ?? cliStatus.error ?? 'Entre com Verboo pelo CLI ou salve uma chave de API válida.')
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

  function handleModelSelect(modelId: string) {
    setSelectedModel(modelId)
    void updateUserSettings({ lastSelectedModelId: modelId })
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
      turnCommands.current[event.turnId] = []
      turnReferences.current[event.turnId] = []
      if (pendingResearchSubagentsRef.current.length > 0) {
        attachPendingResearchSubagents(event.turnId)
      } else if (!Object.keys(activeSubagentsRef.current).some(id => id.startsWith(`${event.turnId}:`))) {
        activeSubagentsRef.current = {}
        setActiveSubagents([])
      }
      setRunningTurnId(event.turnId)
      setThinkingTurnId(event.turnId)
      if (conversationId) {
        appendAssistantPlaceholder(conversationId, event.turnId)
      }
      return
    }

    if (event.type === 'stdout') {
      const conversationId = turnConversationIds.current[event.turnId]
      setThinkingTurnId(current => (current === event.turnId ? undefined : current))
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
      const activity = event.runtimeActivity
      if (activity?.kind === 'subagent') trackActiveSubagent(event.turnId, activity)
      if (conversationId && activity) {
        if (activity.kind === 'command' && activity.detail) {
          turnLastCommand.current[event.turnId] = activity.detail
          appendTurnMetadata(turnCommands, event.turnId, activity.detail)
        }
        if (activity.kind === 'search' && activity.detail) {
          appendTurnMetadata(turnReferences, event.turnId, activity.detail)
        }
        if (activity.kind === 'edit' && activity.detail) {
          appendTouchedFile(event.turnId, activity.detail)
        }
        appendActivityItem(conversationId, event.turnId, activity)
      }
      if (conversationId) {
        for (const result of extractToolResults(event.payload)) {
          const itemId = turnCommandItemIds.current[event.turnId]?.[result.toolUseId]
          if (itemId) updateActivityCommand(conversationId, itemId, result.output, result.isError ? 'failure' : 'success')
        }
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
      setThinkingTurnId(current => (current === event.turnId ? undefined : current))
      clearActiveSubagentsForTurn(event.turnId)

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
      cleanupTurnState(event.turnId)
      return
    }

    if (event.type === 'done') {
      const conversationId = turnConversationIds.current[event.turnId]
      setRunningTurnId(undefined)
      setThinkingTurnId(current => (current === event.turnId ? undefined : current))
      clearActiveSubagentsForTurn(event.turnId)
      if (conversationId && event.exitCode !== 0) {
        const failureMessage = buildCliFailureMessage(turnTerminalErrors.current[event.turnId])
        if (failureMessage) appendAssistantText(conversationId, event.turnId, failureMessage)
      }
      if (conversationId) finishAssistantMessage(conversationId, event.turnId)
      if (conversationId) {
        void appendTurnSummary(conversationId, event.turnId, event.exitCode)
          .finally(() => cleanupTurnState(event.turnId))
          .catch(() => undefined)
      } else {
        cleanupTurnState(event.turnId)
      }

      // Resolve goal turn completion promise if this turn was started by the goal scheduler
      if (turnCompletionDeferred.current?.turnId === event.turnId) {
        turnCompletionDeferred.current.resolve()
        turnCompletionDeferred.current = undefined
      }

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

    appendDowngradeActivity(conversationId)
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
        accessMode: accessMode === 'full' && !userSettings.fullAccessEnabled ? 'approval' : accessMode,
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

    const request = await prepareRequestWithResearchSubagents(item)
    const turnId = await sendTrackedTurn(request)
    turnConversationIds.current[turnId] = item.conversationId
    turnModels.current[turnId] = item.turnModel
    attachPendingResearchSubagents(turnId)
    tagAssistantMessage(item.conversationId, turnId, item.turnModel)
    if (pendingConversationId.current === item.conversationId) pendingConversationId.current = undefined
  }

  async function sendTrackedTurn(request: AgentTurnRequest, resumeSessionId?: string): Promise<string> {
    const baseline = await snapshotWorkspaceChanges(request.workingDirectory)
    const turnId = await window.verboo.sendTurn(request, resumeSessionId)
    turnChangeBaselines.current[turnId] = baseline
    turnWorkingDirectories.current[turnId] = request.workingDirectory
    return turnId
  }

  async function prepareRequestWithResearchSubagents(item: QueuedFollowUp): Promise<AgentTurnRequest> {
    const researchRequest = parseResearchSubagentRequest(item.message)
    if (!researchRequest) return item.request

    const runId = `research:${item.id}`
    const agents = Array.from({ length: researchRequest.count }, (_, index): ActiveSubagent => {
      const mission = index === 0
        ? 'Pesquisar o código local, arquivos relevantes e riscos de implementação.'
        : 'Pesquisar contexto complementar, validação e possíveis lacunas.'
      const status = index === 0 ? 'reading' : 'searching'
      return {
        id: `research:${item.id}:${index + 1}`,
        runId,
        label: subagentNameFor(`${item.id}:${index}`, index),
        detail: index === 0 ? 'Código local e arquivos relevantes.' : 'Contexto complementar e validação.',
        mission,
        history: [
          {
            id: `mission:${index + 1}`,
            label: 'Missão recebida',
            text: mission,
            timestamp: Date.now() + index,
          },
          {
            id: `status:${index + 1}:start`,
            label: SUBAGENT_STATUS_LABELS[status],
            text: index === 0 ? 'Lendo arquivos do projeto.' : 'Pesquisando contexto de apoio.',
            timestamp: Date.now() + index + 1,
          },
        ],
        status,
        updatedAt: Date.now() + index,
      }
    })

    activeSubagentsRef.current = Object.fromEntries(agents.map(agent => [agent.id, agent]))
    pendingResearchSubagentsRef.current = agents
    setActiveSubagents(agents)

    appendConversationItem(item.conversationId, {
      id: `research:${item.id}:activity:1`,
      role: 'tool',
      kind: 'activity',
      activityKind: 'subagent',
      text: `${researchRequest.count} subagente${researchRequest.count === 1 ? '' : 's'} pesquisando`,
      activityDetail: researchRequest.requestedCount > researchRequest.count
        ? `Pedido limitado a ${researchRequest.count} subagentes de pesquisa.`
        : 'Pesquisas somente leitura antes do turno principal.',
      timestamp: Date.now(),
    })

    try {
      const results = await window.verboo.runResearchSubagents({
        runId,
        count: researchRequest.count,
        requestedCount: researchRequest.requestedCount,
        baseRequest: item.request,
      })

      appendConversationItem(item.conversationId, {
        id: `research:${item.id}:activity:2`,
        role: 'tool',
        kind: 'activity',
        activityKind: 'subagent',
        text: 'Pesquisa dos subagentes concluída',
        activityDetail: formatResearchResultsForTranscript(results, agents),
        timestamp: Date.now(),
      })

      const finishedAgents = agents.map((agent, index) => {
        const result = results[index]
        const status = result?.status === 'complete' ? 'done' : 'failed'
        const summary = result?.summary || (status === 'done' ? 'Pesquisa concluída.' : 'Pesquisa interrompida.')
        return {
          ...agent,
          status,
          detail: summary,
          updatedAt: Date.now() + index,
          history: [
            ...(agent.history ?? []),
            {
              id: `result:${index + 1}`,
              label: status === 'done' ? 'Pesquisa concluída' : 'Pesquisa falhou',
              text: summary,
              timestamp: Date.now() + index,
            },
          ],
        } satisfies ActiveSubagent
      })
      const researchContext = buildResearchResultsContext(results, finishedAgents)
      activeSubagentsRef.current = {}
      pendingResearchSubagentsRef.current = []
      setActiveSubagents([])
      if (!researchContext) return item.request

      return {
        ...item.request,
        memoryContext: [item.request.memoryContext, researchContext].filter(Boolean).join('\n\n'),
      }
    } catch (error) {
      appendConversationItem(item.conversationId, {
        id: `research:${item.id}:activity:2`,
        role: 'tool',
        kind: 'activity',
        activityKind: 'subagent',
        text: 'Pesquisa dos subagentes falhou',
        activityDetail: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      })
      activeSubagentsRef.current = {}
      pendingResearchSubagentsRef.current = []
      setActiveSubagents([])
      return item.request
    }
  }

  async function cancelResearchSubagent(agent: ActiveSubagent) {
    const now = Date.now()
    const runId = agent.runId
    if (runId) await window.verboo.cancelResearchSubagents(runId)

    const next = Object.fromEntries(Object.entries(activeSubagentsRef.current).map(([id, current]) => {
      const sameRun = runId ? current.runId === runId : current.id === agent.id
      if (!sameRun) return [id, current]
      return [id, {
        ...current,
        status: 'failed',
        detail: 'Pesquisa cancelada pelo usuário.',
        updatedAt: now,
        history: appendSubagentHistory(current.history, {
          id: `${current.id}:cancelled:${now}`,
          label: 'Pesquisa cancelada',
          text: 'O subagente foi interrompido antes de concluir a pesquisa.',
          timestamp: now,
        }),
      } satisfies ActiveSubagent]
    }))

    activeSubagentsRef.current = next
    pendingResearchSubagentsRef.current = pendingResearchSubagentsRef.current.filter(current =>
      runId ? current.runId !== runId : current.id !== agent.id,
    )
    setActiveSubagents(Object.values(next).sort((a, b) => a.updatedAt - b.updatedAt))
    setSelectedSubagentId(undefined)
  }

  function setQueuedFollowUpsList(updater: (current: QueuedFollowUp[]) => QueuedFollowUp[]) {
    setQueuedFollowUps(current => {
      const next = updater(current)
      queuedFollowUpsRef.current = next
      return next
    })
  }

  function appendDowngradeActivity(conversationId: string) {
    if (accessMode !== 'full' || userSettings.fullAccessEnabled) return
    appendConversationItem(conversationId, {
      id: `downgrade:${Date.now()}`,
      role: 'tool',
      kind: 'activity',
      activityKind: 'permission',
      text: 'Modo livre não está ativado nas configurações. Usando Aprovar por mim.',
      timestamp: Date.now(),
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
        ? automatic ? 'Permissão aprovada automaticamente' : 'Permissão aprovada'
        : 'Permissão negada',
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
    appendDowngradeActivity(prompt.conversationId)
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
        accessMode: accessMode === 'full' && !userSettings.fullAccessEnabled ? 'approval' : accessMode,
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
          'Goal automático não inicia com Modo livre nesta versão beta. Troque para "Solicitar aprovação" ou "Aprovar por mim" antes de começar.'
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
        accessMode, // 'full' blocked above; safe to pass as-is
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

        appendDowngradeActivity(conversationId)

        const turnId = await sendTrackedTurn({
          message: nextMessage,
          model: selectedModel,
          modelSupportsVision: Boolean(selectedModelInfo?.supportsVision),
          contextWindow: selectedContextWindow,
          accessMode: accessMode === 'full' && !userSettings.fullAccessEnabled ? 'approval' : accessMode,
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
    const segId = `${turnId}:text:1`
    turnTextSegmentCount.current[turnId] = 1
    turnOpenTextSegment.current[turnId] = segId
    updateConversation(conversationId, conversation => {
      if (conversation.items.some(item => item.id === segId)) return conversation
      return {
        ...conversation,
        items: [
          ...conversation.items,
          { id: segId, role: 'assistant', text: '', timestamp: Date.now(), streaming: true, ...turnModel },
        ],
        updatedAt: Date.now(),
      }
    })
  }

  // Assistant text is stored as one item per burst-between-actions
  // (`turnId:text:N`). The "open" segment is where new deltas land; it is closed
  // whenever an activity happens (see appendActivityItem), so the next text opens
  // a fresh segment — this is what interleaves message/action/message in order.
  function appendAssistantText(conversationId: string, turnId: string, text: string) {
    const turnModel = turnModels.current[turnId]
    const openId = turnOpenTextSegment.current[turnId]
    if (!openId) {
      const next = (turnTextSegmentCount.current[turnId] ?? 0) + 1
      turnTextSegmentCount.current[turnId] = next
      const segId = `${turnId}:text:${next}`
      turnOpenTextSegment.current[turnId] = segId
      updateConversation(conversationId, conversation => ({
        ...conversation,
        items: [...conversation.items, { id: segId, role: 'assistant', text, timestamp: Date.now(), streaming: true, ...turnModel }],
        updatedAt: Date.now(),
      }))
      return
    }
    updateConversation(conversationId, conversation => ({
      ...conversation,
      items: conversation.items.map(item => item.id === openId ? { ...item, text: mergeAssistantText(item.text, text) } : item),
      updatedAt: Date.now(),
    }))
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
        item.id === turnId || item.id.startsWith(`${turnId}:text:`) ? { ...item, streaming: false } : item,
      ),
      updatedAt: Date.now(),
    }))
    delete turnModels.current[turnId]
  }

  function appendActivityItem(conversationId: string, turnId: string, activity: TurnActivity) {
    // A command's tool_use often streams twice (once at block-start with no
    // input, then with the real command). Dedupe by tool_use_id and backfill the
    // input instead of creating a second phantom "Comando" row that never resolves.
    if (activity.kind === 'command' && activity.toolUseId) {
      const existingItemId = turnCommandItemIds.current[turnId]?.[activity.toolUseId]
      if (existingItemId) {
        if (activity.detail) {
          const detail = activity.detail
          updateConversation(conversationId, conversation => ({
            ...conversation,
            items: conversation.items.map(item => item.id === existingItemId
              ? { ...item, activityDetail: detail, command: item.command ? { ...item.command, input: detail } : item.command }
              : item),
            updatedAt: Date.now(),
          }))
        }
        return
      }
    }
    const keys = turnActivityKeys.current[turnId] ?? new Set<string>()
    turnActivityKeys.current[turnId] = keys
    if (keys.has(activity.key)) return
    keys.add(activity.key)
    if (activity.kind !== 'thinking') turnOpenTextSegment.current[turnId] = undefined

    if (activity.kind !== 'thinking') {
      const counts = turnActivityCounts.current[turnId] ?? {}
      counts[activity.kind] = (counts[activity.kind] ?? 0) + 1
      turnActivityCounts.current[turnId] = counts
    }

    const itemId = `${turnId}:activity:${keys.size}`
    const command: CommandRun | undefined = activity.kind === 'command'
      ? { input: activity.detail ?? 'Comando', output: '', status: 'running' }
      : undefined
    if (command && activity.toolUseId) {
      const map = turnCommandItemIds.current[turnId] ?? {}
      map[activity.toolUseId] = itemId
      turnCommandItemIds.current[turnId] = map
    }

    updateConversation(conversationId, conversation => ({
      ...conversation,
      items: [
        ...conversation.items,
        {
          id: itemId,
          role: 'tool',
          kind: 'activity',
          activityKind: activity.kind,
          activityDetail: activity.detail,
          command,
          text: activity.label,
          timestamp: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    }))
  }

  // Fill in a command's real stdout + success/failure once its tool_result
  // arrives (matched by tool_use_id → the activity item created above).
  function updateActivityCommand(conversationId: string, itemId: string, output: string, status: CommandRun['status']) {
    updateConversation(conversationId, conversation => ({
      ...conversation,
      items: conversation.items.map(item => item.id === itemId && item.command
        ? { ...item, command: { ...item.command, output, status } }
        : item),
      updatedAt: Date.now(),
    }))
  }

  function trackActiveSubagent(turnId: string, activity: TurnActivity) {
    const isStop = /stop|stopp|finish|complete|done|finaliz/i.test(`${activity.key} ${activity.label}`)
    const identity = normalizeSubagentIdentity(activity)
    const id = `${turnId}:subagent:${identity}`
    const previous = activeSubagentsRef.current[id]
    if (isStop) {
      if (!previous) return
      activeSubagentsRef.current = {
        ...activeSubagentsRef.current,
        [id]: {
          ...previous,
          status: 'done',
          detail: 'Pesquisa concluída.',
          updatedAt: Date.now(),
          history: appendSubagentHistory(previous.history, {
            id: `${id}:done:${Date.now()}`,
            label: 'Pesquisa concluída',
            text: activity.detail || 'Subagente finalizado.',
            timestamp: Date.now(),
          }),
        },
      }
      setActiveSubagents(Object.values(activeSubagentsRef.current).sort((a, b) => a.updatedAt - b.updatedAt))
      return
    }

    const next = {
      id,
      label: previous?.label ?? subagentNameFor(identity, Object.keys(activeSubagentsRef.current).length),
      detail: compactSubagentDetail(activity),
      mission: previous?.mission ?? 'Acompanhar a pesquisa delegada pelo agente principal.',
      history: appendSubagentHistory(previous?.history, {
        id: `${id}:activity:${Date.now()}`,
        label: activity.label,
        text: activity.detail || compactSubagentDetail(activity),
        timestamp: Date.now(),
      }),
      status: subagentStatusForActivity(activity),
      updatedAt: Date.now(),
    }
    activeSubagentsRef.current = {
      ...activeSubagentsRef.current,
      [id]: next,
    }
    setActiveSubagents(Object.values(activeSubagentsRef.current).sort((a, b) => a.updatedAt - b.updatedAt))
  }

  function attachPendingResearchSubagents(turnId: string) {
    if (pendingResearchSubagentsRef.current.length === 0) return
    const attached = pendingResearchSubagentsRef.current
      .filter(isActiveSubagentWorking)
      .map((agent, index) => ({
        ...agent,
        id: `${turnId}:research:${index + 1}`,
        updatedAt: agent.updatedAt + index,
      }))
    pendingResearchSubagentsRef.current = []
    if (attached.length === 0) {
      activeSubagentsRef.current = {}
      setActiveSubagents([])
      return
    }
    activeSubagentsRef.current = Object.fromEntries(attached.map(agent => [agent.id, agent]))
    setActiveSubagents(attached)
  }

  function clearActiveSubagentsForTurn(turnId: string) {
    const next = Object.fromEntries(
      Object.entries(activeSubagentsRef.current).filter(([id]) => !id.startsWith(`${turnId}:`)),
    )
    pendingResearchSubagentsRef.current = []
    activeSubagentsRef.current = next
    setActiveSubagents(Object.values(next).sort((a, b) => a.updatedAt - b.updatedAt))
  }

  function normalizeSubagentIdentity(activity: TurnActivity): string {
    return (activity.detail || activity.label || activity.key)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 96) || 'default'
  }

  async function appendTurnSummary(conversationId: string, turnId: string, exitCode: number | null) {
    const startedAt = turnStartedAt.current[turnId]
    const elapsed = startedAt ? formatElapsed(Date.now() - startedAt) : 'alguns segundos'
    const counts = turnActivityCounts.current[turnId] ?? {}
    const result = turnResultSnapshots.current[turnId]
    const changeSummary = await buildTurnChangeSummary(turnId)
    const summaryLines = buildTurnSummaryLines(counts, result, exitCode, {
      validationCommands: validationCommandsForTurn(turnCommands.current[turnId] ?? []),
      references: turnReferences.current[turnId] ?? [],
      changeSummary,
    })

    appendConversationItem(conversationId, {
      id: `${turnId}:summary`,
      role: 'system',
      kind: 'summary',
      text: `Trabalhou por ${elapsed}`,
      activityDetail: summaryLines.join('\n'),
      changeSummary,
      timestamp: Date.now(),
    })
  }

  async function buildTurnChangeSummary(turnId: string): Promise<WorkspaceChangeSummary | undefined> {
    const workingDirectory = turnWorkingDirectories.current[turnId]
    const baseline = turnChangeBaselines.current[turnId]
    if (!workingDirectory || !baseline) return undefined

    // Local-folder fallback: use touched files observed during the turn
    if (baseline.totalFiles === 0) {
      const metadata = await window.verboo.getWorkspaceReviewMetadata(workingDirectory).catch(() => undefined)
      if (metadata?.scope === 'local-folder') {
        const touched = turnTouchedFiles.current[turnId]
        if (!touched || touched.size === 0) return undefined
        const files = [...touched]
          .sort((a, b) => a.localeCompare(b))
          .map(path => ({ path, additions: 0, deletions: 0, status: 'modified' as const }))
        return files.length > 0 ? { files, totalFiles: files.length, additions: 0, deletions: 0 } : undefined
      }
    }

    const current = await snapshotWorkspaceChanges(workingDirectory)
    if (!current) return undefined

    const summary = diffWorkspaceChanges(baseline, current)
    return summary.totalFiles > 0 ? summary : undefined
  }

  async function snapshotWorkspaceChanges(workingDirectory: string): Promise<WorkspaceChangeSummary | undefined> {
    try {
      return await window.verboo.getWorkspaceChanges(workingDirectory)
    } catch {
      return undefined
    }
  }

  function cleanupTurnState(turnId: string) {
    delete turnConversationIds.current[turnId]
    delete turnStartedAt.current[turnId]
    delete turnActivityKeys.current[turnId]
    delete turnActivityCounts.current[turnId]
    delete turnResultSnapshots.current[turnId]
    delete turnTerminalErrors.current[turnId]
    delete turnAssistantText.current[turnId]
    delete turnLastCommand.current[turnId]
    delete turnCommands.current[turnId]
    delete turnReferences.current[turnId]
    delete turnChangeBaselines.current[turnId]
    delete turnWorkingDirectories.current[turnId]
    delete turnTouchedFiles.current[turnId]
    delete turnOpenTextSegment.current[turnId]
    delete turnTextSegmentCount.current[turnId]
    delete turnCommandItemIds.current[turnId]
  }

  function appendTouchedFile(turnId: string, filePath: string) {
    const current = turnTouchedFiles.current[turnId] ?? new Set<string>()
    current.add(filePath)
    turnTouchedFiles.current[turnId] = current
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
    // Persistence is debounced (see the effect below). During streaming, state
    // updates fire on every token delta; serializing the whole store to
    // localStorage on each one was pegging the main thread and thrashing GC.
    setChatStore(current => updater(current))
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
    const atBottom = isWorkspaceAtBottom(element)
    if (atBottom) {
      autoScrollingRef.current = false
      stickToBottomRef.current = true
      setShowJumpToLatest(false)
      return
    }
    if (autoScrollingRef.current) return
    stickToBottomRef.current = false
    setShowJumpToLatest(hasConversation)
  }

  function forceWorkspaceToBottom() {
    const element = workspaceRef.current
    if (!element) return
    if (scrollSettleTimer.current) window.clearTimeout(scrollSettleTimer.current)
    autoScrollingRef.current = true
    element.scrollTop = latestScrollTop(element)
    stickToBottomRef.current = true
    setShowJumpToLatest(false)
    scrollSettleTimer.current = window.setTimeout(() => {
      autoScrollingRef.current = false
      if (!isWorkspaceAtBottom(element)) element.scrollTop = latestScrollTop(element)
      stickToBottomRef.current = true
      setShowJumpToLatest(false)
    }, 0)
  }

  function scrollToLatest(behavior: ScrollBehavior = 'smooth') {
    const element = workspaceRef.current
    stickToBottomRef.current = true
    setShowJumpToLatest(false)
    if (!element) return
    if (scrollSettleTimer.current) window.clearTimeout(scrollSettleTimer.current)
    autoScrollingRef.current = true
    window.requestAnimationFrame(() => {
      element.scrollTo({ top: latestScrollTop(element), behavior })
      scrollSettleTimer.current = window.setTimeout(() => {
        autoScrollingRef.current = false
        if (!isWorkspaceAtBottom(element)) {
          element.scrollTo({ top: latestScrollTop(element), behavior: 'auto' })
        }
        stickToBottomRef.current = true
        setShowJumpToLatest(false)
      }, behavior === 'smooth' ? SCROLL_SETTLE_MS : 0)
    })
  }

  const projectName = activeProject?.name ?? 'Sem projeto'
  const workspaceDirectory = activeProject?.path ?? config.workingDirectory
  const shownProjects = activeProjects(chatStore)
  const shownConversations = visibleConversations(chatStore)
  const archivedChats = archivedConversations(chatStore)

  const handleToggleTerminal = useCallback((cwd: string) => {
    review.close()
    void terminal.toggle(cwd)
  }, [review, terminal])

  const handleOpenReview = useCallback((files: WorkspaceChangeEntry[], index: number) => {
    const workingDirectory = activeProject?.path ?? config.workingDirectory ?? ''
    if (!workingDirectory) return
    terminal.close()
    setSelectedSubagentId(undefined)
    review.open(workingDirectory, files, index)
  }, [activeProject?.path, config.workingDirectory, review, terminal])

  async function refreshWorkspaceReview() {
    if (!review.target) return
    const summary = await window.verboo.getWorkspaceChanges(review.target.workingDirectory)
    review.open(review.target.workingDirectory, summary.files, Math.min(review.target.index, Math.max(0, summary.files.length - 1)))
  }

  useEffect(() => {
    function handleTerminalShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'j') return
      event.preventDefault()
      event.stopPropagation()
      handleToggleTerminal(workspaceDirectory || '')
    }

    window.addEventListener('keydown', handleTerminalShortcut, { capture: true })
    return () => window.removeEventListener('keydown', handleTerminalShortcut, { capture: true })
  }, [handleToggleTerminal, workspaceDirectory])

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
    const subagentsRunning = workingSubagents.length > 0
    const state: Partial<MenuBarState> = {
      execution: runningTurnId ? subagentsRunning ? 'tool' : 'thinking' : 'idle',
      label: runningTurnId ? subagentsRunning ? 'subagent' : 'working' : 'ready',
      startedAt: runningTurnId ? turnStartedAt.current[runningTurnId] : undefined,
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
    workingSubagents.length,
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
      <TopBar
        sidebarVisible={sidebarMode !== 'hidden'}
        statusLabel={runningTurnId ? 'trabalhando' : 'pronto'}
        onToggleSidebar={toggleSidebarVisibility}
        terminalOpen={terminal.terminalOpen}
        terminalUnavailableReason={terminal.terminalUnavailableReason}
        onToggleTerminal={() => handleToggleTerminal(workspaceDirectory || '')}
      />

      <div
        className={`app-layout sidebar-${sidebarMode} ${activeView === 'settings' ? 'settings-open' : ''} ${terminal.terminalOpen ? 'terminal-open' : ''} ${review.reviewOpen ? 'review-open' : ''}`}
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
              <Transcript items={items} onOpenReview={handleOpenReview} reviewMetadata={reviewMetadata} thinkingTurnId={thinkingTurnId} />
              <div ref={transcriptEndRef} className="transcript-end" />
            </>
          ) : (
            <EmptyChat projectName={projectName || 'Sem projeto'} line={emptyLine} />
          )}
        </section>
        {showSubagentThreadPanel && selectedSubagent && (
          <ResearchSubagentPanel
            agent={selectedSubagent}
            onClose={() => setSelectedSubagentId(undefined)}
            onCancel={cancelResearchSubagent}
          />
        )}
        <LocalTerminalPanel
          terminalOpen={terminal.terminalOpen}
          terminalWidth={terminal.terminalWidth}
          onSetWidth={terminal.setWidth}
          onWrite={terminal.write}
          onResize={terminal.resize}
          onClose={terminal.close}
          onStop={terminal.stop}
          onRestartInProject={async () => terminal.restartInProject(workspaceDirectory || '')}
          onTerminalData={terminal.onTerminalData}
          onTerminalExit={terminal.onTerminalExit}
          session={terminal.terminalSession}
          workingDirectory={workspaceDirectory || ''}
          minWidth={terminal.MIN_WIDTH}
          maxWidth={terminal.MAX_WIDTH}
        />
        <ReviewPanel
          open={review.reviewOpen}
          width={review.reviewWidth}
          target={review.target}
          onSetWidth={review.setWidth}
          onClose={review.close}
          onNext={review.next}
          onPrev={review.prev}
          onReverted={refreshWorkspaceReview}
          minWidth={review.MIN_WIDTH}
          maxWidth={review.MAX_WIDTH}
        />
      </div>
      <GoalStatusBar
        status={goalBarStatus}
        onPause={() => handleGoalCommand({ kind: 'goal', action: 'pause', raw: '/goal pause' })}
        onResume={() => handleGoalCommand({ kind: 'goal', action: 'resume', raw: '/goal resume' })}
        onCancel={() => handleGoalCommand({ kind: 'goal', action: 'clear', raw: '/goal clear' })}
        onClear={() => handleGoalCommand({ kind: 'goal', action: 'clear', raw: '/goal clear' })}
      />

      {activeView === 'chat' && (
        <div className={`bottom-dock ${hasConversation ? '' : 'empty-mode'}`}>
          {showSubagentSummary && (
            <SubagentSummaryCard
              agents={workingSubagents}
              expanded={subagentSummaryExpanded}
              selectedAgentId={selectedSubagentId}
              onToggleExpanded={() => setSubagentSummaryExpanded(current => !current)}
              onSelectAgent={setSelectedSubagentId}
            />
          )}
          {showJumpToLatest && hasConversation && (
            <button className="jump-to-latest" type="button" onClick={() => scrollToLatest('smooth')} title="Ir para a última mensagem">
              <ArrowDown size={17} />
            </button>
          )}
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
            leftToolbar={
              <AccessSelector
                value={accessMode}
                fullAccessEnabled={userSettings.fullAccessEnabled}
                onChange={setAccessMode}
                onRequestFullAccessSettings={() => {
                  setSettingsTab('permissions')
                  setActiveView('settings')
                }}
              />
            }
            rightToolbar={
              <>
                <ContextMeter usage={contextUsage} contextWindow={selectedContextWindow} />
                <ModelSelector
                  models={modelResult.models}
                  selectedModel={selectedModel}
                  modelResult={modelResult}
                  onSelect={handleModelSelect}
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

function SubagentSummaryCard({
  agents,
  expanded,
  selectedAgentId,
  onToggleExpanded,
  onSelectAgent,
}: {
  agents: ActiveSubagent[]
  expanded: boolean
  selectedAgentId?: string
  onToggleExpanded: () => void
  onSelectAgent: (agentId: string) => void
}) {
  if (agents.length === 0) return null
  const title = String(agents.length)

  return (
    <section className={`subagent-summary-card ${expanded ? 'expanded' : ''}`} aria-label="Subagentes ativos">
      <button
        className="subagent-summary-header"
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
      >
        <span className="subagent-summary-title">
          <GitBranch size={14} />
          Subagentes
        </span>
        <span className="subagent-summary-count">{title}</span>
        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>

      {expanded && (
        <div className="subagent-summary-list">
          {agents.map(agent => {
            const Icon = subagentStatusIcon(agent.status)
            return (
              <button
                key={agent.id}
                className={`subagent-summary-item ${agent.id === selectedAgentId ? 'selected' : ''}`}
                data-status={agent.status}
                type="button"
                onClick={() => onSelectAgent(agent.id)}
              >
                <span className="subagent-summary-avatar" aria-hidden="true">
                  <img src={mascotUrl} alt="" />
                </span>
                <strong>{agent.label}</strong>
                <span className="subagent-summary-state">
                  <Icon size={13} />
                  {SUBAGENT_STATUS_LABELS[agent.status]}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function ResearchSubagentPanel({
  agent,
  onClose,
  onCancel,
}: {
  agent: ActiveSubagent
  onClose: () => void
  onCancel: (agent: ActiveSubagent) => Promise<void>
}) {
  const Icon = subagentStatusIcon(agent.status)
  const history = agent.history ?? []
  const canCancel = isActiveSubagentWorking(agent)

  return (
    <aside className="research-subagent-panel" data-status={agent.status} aria-label={`Conversa com ${agent.label}`}>
      <header className="research-subagent-header">
        <div className="research-subagent-header-row">
          <span className="research-subagent-tab">
            <GitBranch size={14} />
            <strong>{agent.label}</strong>
          </span>
          <button
            type="button"
            className="research-subagent-close ui-tooltip"
            data-tooltip={canCancel ? 'Cancelar pesquisa' : 'Fechar painel'}
            data-tooltip-align="end"
            onClick={() => {
              if (canCancel) {
                void onCancel(agent)
                return
              }
              onClose()
            }}
            aria-label={canCancel ? 'Cancelar pesquisa do subagente' : 'Fechar painel do subagente'}
          >
            <XCircle size={16} />
          </button>
        </div>
        <span className="research-subagent-state">
          <Icon size={13} />
          {SUBAGENT_STATUS_LABELS[agent.status]}
        </span>
      </header>

      <section className="research-subagent-thread" aria-label={`Histórico de ${agent.label}`}>
        <div className="research-subagent-message mission">
          <small>Missão</small>
          <p>{agent.mission || agent.detail || 'Coletar contexto somente leitura para o agente principal.'}</p>
        </div>
        {history.map(item => (
          <div key={item.id} className="research-subagent-message">
            <small>{item.label}</small>
            <p>{item.text}</p>
          </div>
        ))}
      </section>

      <footer className="research-subagent-footer">
        Histórico somente leitura
      </footer>
    </aside>
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
        <strong>Permitir esta ação?</strong>
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

function isAuthoritativelySignedOut(credentials: CredentialStatus, cliAuth: CliAuthStatus): boolean {
  // A remembered "stay signed in" session should survive transient failures to
  // confirm live auth. Only drop it on positive proof of being signed out: no
  // saved API key AND a *successful* CLI status check that reports loggedIn:false.
  // When the status check itself failed it carries `error` — that's transient,
  // not a logout, so keep the session instead of kicking the user out.
  if (credentials.hasApiKey) return false
  return cliAuth.loggedIn === false && !cliAuth.error
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

function isWorkspaceAtBottom(element: HTMLElement): boolean {
  return Math.abs(latestScrollTop(element) - element.scrollTop) <= BOTTOM_STICK_THRESHOLD
}

function latestScrollTop(element: HTMLElement): number {
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
  const transcript = element.querySelector<HTMLElement>('.transcript')
  const dock = document.querySelector<HTMLElement>('.bottom-dock')
  if (!transcript || !dock) return maxScrollTop

  const transcriptBottom = transcript.getBoundingClientRect().bottom
  const dockTop = dock.getBoundingClientRect().top
  const target = element.scrollTop + transcriptBottom - (dockTop - 14)
  return Math.min(maxScrollTop, Math.max(0, Math.round(target)))
}

function isVerifiedModelDiscovery(result: ModelDiscoveryResult): boolean {
  return !result.stale && result.models.length > 0 && (result.source === 'cli' || result.source === 'api-key')
}

function resolveSelectedModel(
  models: VerbooModel[],
  currentModelId?: string,
  preferredModelId?: string,
): string | undefined {
  if (models.length === 0) return currentModelId
  if (currentModelId && models.some(model => model.id === currentModelId)) return currentModelId
  if (preferredModelId && models.some(model => model.id === preferredModelId)) return preferredModelId
  return models[0]?.id
}

function parseResearchSubagentRequest(message: string): { count: number; requestedCount: number } | undefined {
  const normalized = normalizeForSubagentParsing(message)
  const explicitCount = normalized.match(/\b(\d+|um|uma|dois|duas|tres)\s+sub-?agentes?\b/)
  if (explicitCount) {
    const requestedCount = numberFromSubagentToken(explicitCount[1])
    if (!requestedCount) return undefined
    return {
      requestedCount,
      count: Math.min(Math.max(requestedCount, 1), 2),
    }
  }

  if (!requestsResearchSubagents(normalized)) return undefined
  const requestedCount = inferResearchSubagentCount(normalized)
  return {
    requestedCount,
    count: requestedCount,
  }
}

function numberFromSubagentToken(token: string): number | undefined {
  const normalized = token.toLowerCase()
  if (normalized === 'um' || normalized === 'uma') return 1
  if (normalized === 'dois' || normalized === 'duas') return 2
  if (normalized === 'tres' || normalized === 'três') return 3
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeForSubagentParsing(message: string): string {
  return message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function requestsResearchSubagents(normalizedMessage: string): boolean {
  if (/\bnao\s+(?:use|usar|utilize|utilizar|rode|rodar|crie|criar|chame|chamar|acione|acionar).{0,40}\bsub-?agentes?\b/.test(normalizedMessage)) {
    return false
  }
  return (
    /\bsub-?agentes?\b/.test(normalizedMessage) ||
    /\bagentes?\s+(?:de\s+)?pesquisa\b/.test(normalizedMessage) ||
    /\bagentes?\s+pesquisadores?\b/.test(normalizedMessage)
  )
}

function inferResearchSubagentCount(normalizedMessage: string): 1 | 2 {
  const signals = [
    /\bviabilidade\b/,
    /\barquitetura\b/,
    /\bsistema\b/,
    /\bimplementar\b|\bimplementacao\b/,
    /\brefatorar\b|\brefatoracao\b/,
    /\bplanejamento\b|\bplano\b/,
    /\bprojeto\b/,
    /\binvestigar\b|\banalisar\b/,
    /\bfrontend\b|\bbackend\b|\bintegracao\b/,
    /\bseguranca\b|\bperformance\b/,
  ].filter(pattern => pattern.test(normalizedMessage)).length
  const asksForTwoAngles = /\bpesquisa\b.*\bviabilidade\b|\bviabilidade\b.*\bpesquisa\b/.test(normalizedMessage)
  const broadRequest = normalizedMessage.length > 140
  return signals >= 2 || asksForTwoAngles || broadRequest ? 2 : 1
}

function formatResearchResultsForTranscript(results: ResearchSubagentResult[], agents: ActiveSubagent[]): string {
  if (results.length === 0) return 'Nenhum resultado de pesquisa foi retornado.'
  return results
    .map(result => {
      const agentName = agents[result.index - 1]?.label ?? `Subagente ${result.index}`
      const status = result.status === 'complete' ? 'concluído' : 'falhou'
      const sources = result.sources.length ? ` Fontes: ${result.sources.slice(0, 3).join('; ')}.` : ''
      return `${agentName} ${status}: ${result.summary}${sources}`
    })
    .join('\n')
}

function buildResearchResultsContext(results: ResearchSubagentResult[], agents: ActiveSubagent[]): string {
  if (results.length === 0) return ''
  return [
    'Pesquisas de subagentes somente leitura:',
    '',
    ...results.map(result => [
      `${agents[result.index - 1]?.label ?? `Subagente ${result.index}`} (${result.status}):`,
      `Resumo: ${result.summary}`,
      result.findings.length ? `Achados:\n${result.findings.map(finding => `- ${finding}`).join('\n')}` : '',
      result.sources.length ? `Fontes:\n${result.sources.map(source => `- ${source}`).join('\n')}` : '',
    ].filter(Boolean).join('\n')),
  ].join('\n\n')
}

function subagentNameFor(seed: string, index: number): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0
  }
  const offset = Math.abs(hash + index * 7) % SUBAGENT_NAMES.length
  return SUBAGENT_NAMES[offset]
}

function isActiveSubagentWorking(agent: ActiveSubagent): boolean {
  return agent.status !== 'done' && agent.status !== 'failed'
}

function subagentStatusIcon(status: ActiveSubagent['status']) {
  if (status === 'done') return CheckCircle2
  if (status === 'failed') return XCircle
  return LoaderCircle
}

function subagentStatusForActivity(activity: TurnActivity): ActiveSubagent['status'] {
  const text = `${activity.key} ${activity.label} ${activity.detail ?? ''}`.toLowerCase()
  if (/finish|complete|done|finaliz/.test(text)) return 'done'
  if (/fail|erro|error/.test(text)) return 'failed'
  if (/read|leu|lendo|file|arquivo/.test(text)) return 'reading'
  if (/search|pesquis|grep|glob|internet/.test(text)) return 'searching'
  return 'thinking'
}

function compactSubagentDetail(activity: TurnActivity): string {
  const status = subagentStatusForActivity(activity)
  if (status === 'reading') return 'Lendo arquivos e referências.'
  if (status === 'searching') return 'Pesquisando contexto relevante.'
  if (status === 'done') return 'Pesquisa concluída.'
  if (status === 'failed') return 'Pesquisa interrompida.'
  return 'Organizando o escopo da pesquisa.'
}

function appendSubagentHistory(
  current: ActiveSubagentHistoryItem[] | undefined,
  item: ActiveSubagentHistoryItem,
): ActiveSubagentHistoryItem[] {
  const next = [...(current ?? []), item]
  return next.slice(-8)
}

function mergeAssistantText(current: string, incoming: string): string {
  if (!current || !incoming) return current + incoming
  const left = current.at(-1) ?? ''
  const right = incoming[0] ?? ''
  if (!left || !right || /\s/.test(left) || /\s/.test(right)) return current + incoming
  if (left === '`' || right === '`' || left === '/' || right === '/') return current + incoming
  if (/[.!?:;,)]/.test(left) && /[\p{L}\p{N}("'“]/u.test(right)) return `${current} ${incoming}`
  if (/[\p{Ll}\p{N})]/u.test(left) && /[\p{Lu}]/u.test(right)) return `${current} ${incoming}`
  return current + incoming
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

  const inputTokens = numberValue(usage.input_tokens) ?? 0
  const outputTokens = numberValue(usage.output_tokens) ?? 0
  const cacheCreationTokens = numberValue(usage.cache_creation_input_tokens) ?? 0
  const cacheReadTokens = numberValue(usage.cache_read_input_tokens) ?? 0
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

function buildTurnSummaryLines(
  counts: Partial<Record<NonNullable<TranscriptItem['activityKind']>, number>>,
  result: AgentResultSnapshot | undefined,
  exitCode: number | null,
  details?: {
    validationCommands?: string[]
    references?: string[]
    changeSummary?: WorkspaceChangeSummary
  },
): string[] {
  const actions = [
    actionCount(counts.read, 'leu/inspecionou arquivos'),
    actionCount(counts.edit, 'editou arquivos'),
    actionCount(counts.command, 'executou comandos'),
    actionCount(counts.search, 'pesquisou na internet'),
    actionCount(counts.terminal, 'leu terminal'),
    actionCount(counts.permission, 'pediu permissão/resposta'),
    actionCount(counts.tool, 'usou ferramentas'),
  ].filter(Boolean)

  const lines = actions.length ? [`Resumo: ${actions.join(', ')}.`] : []

  if (details?.references?.length) {
    lines.push(`Referências verificadas: ${formatShortList(details.references)}.`)
  }
  if (details?.validationCommands?.length) {
    lines.push(`Validação feita: ${formatShortList(details.validationCommands)}.`)
  }
  if (details?.changeSummary?.totalFiles) {
    lines.push(
      `Arquivos alterados: ${details.changeSummary.totalFiles} (${formatSignedCount(details.changeSummary.additions, '+')} ${formatSignedCount(details.changeSummary.deletions, '-')}).`,
    )
  }
  if (result?.stopReason) lines.push(`Motivo de parada: ${result.stopReason}.`)
  if (exitCode !== 0) lines.push(`Processo terminou com código ${exitCode ?? 'desconhecido'}.`)
  return lines
}

function diffWorkspaceChanges(before: WorkspaceChangeSummary, after: WorkspaceChangeSummary): WorkspaceChangeSummary {
  const beforeByPath = new Map(before.files.map(file => [file.path, file]))
  const files = after.files.flatMap(file => {
    const previous = beforeByPath.get(file.path)
    if (!previous) return [file]

    const additions = Math.max(0, file.additions - previous.additions)
    const deletions = Math.max(0, file.deletions - previous.deletions)
    if (additions === 0 && deletions === 0) return []
    return [{
      ...file,
      additions,
      deletions,
    }]
  })

  return {
    files,
    totalFiles: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  }
}

function appendTurnMetadata(
  target: MutableRefObject<Record<string, string[]>>,
  turnId: string,
  value: string,
) {
  const trimmed = value.trim()
  if (!trimmed) return
  const current = target.current[turnId] ?? []
  if (current.some(item => item.toLowerCase() === trimmed.toLowerCase())) return
  target.current[turnId] = [...current, trimmed]
}

function validationCommandsForTurn(commands: string[]): string[] {
  return commands.filter(command => {
    const normalized = command.toLowerCase()
    return (
      /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|check)\b/.test(normalized) ||
      /\b(tsc|vitest|jest|playwright|electron-vite)\b/.test(normalized) ||
      /\bgit\s+diff\s+--check\b/.test(normalized)
    )
  })
}

function formatShortList(values: string[]): string {
  const unique = values.filter((value, index) => values.findIndex(item => item.toLowerCase() === value.toLowerCase()) === index)
  const visible = unique.slice(0, 3)
  const suffix = unique.length > visible.length ? ` e mais ${unique.length - visible.length}` : ''
  return `${visible.join(', ')}${suffix}`
}

function formatSignedCount(value: number, sign: '+' | '-'): string {
  return `${sign}${Math.max(0, value)}`
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
  return `Não consegui executar o agente.\n\n${visible.join('\n')}\n`
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
  return snippet(focusedLine ?? 'O agente pediu permissão para continuar.')
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
      'Permissão negada.',
      prompt.command ? `Não execute este comando: ${prompt.command}` : '',
      'Continue com uma alternativa segura ou explique o bloqueio de forma objetiva.',
    ].filter(Boolean).join('\n')
  }

  return [
    automatic ? 'Permissão aprovada automaticamente por regra confiável salva neste app.' : 'Permissão aprovada.',
    prompt.command ? `Comando aprovado: ${prompt.command}` : '',
    'Continue exatamente do ponto em que parou e execute apenas a ação aprovada antes de seguir.',
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

// Pull tool_result blocks out of a stream-json payload so a command's real
// stdout and success/failure can be attached to its activity row.
function extractToolResults(payload: unknown): Array<{ toolUseId: string; output: string; isError: boolean }> {
  if (!isRecord(payload)) return []
  const message = isRecord(payload.message) ? payload.message : undefined
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(payload.content) ? payload.content : undefined
  if (!content) return []
  const results: Array<{ toolUseId: string; output: string; isError: boolean }> = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if ((typeof block.type === 'string' ? block.type : '').toLowerCase() !== 'tool_result') continue
    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
    if (!toolUseId) continue
    results.push({ toolUseId, output: toolResultText(block.content), isError: block.is_error === true })
  }
  return results
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map(part => (isRecord(part) && typeof part.text === 'string') ? part.text : '')
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
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
