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
  LanguageCode,
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
  WorkspaceBranchInfo,
  WorkspaceChangeEntry,
  WorkspaceChangeSummary,
  WorkspaceReviewMetadata,
} from '../shared/types'
import { createGoalState, goalSystemMessage } from './features/goal/goalState'
import { GoalStatusBar, type GoalStatusBarState } from './features/goal/GoalStatusBar'
import { runGoalCycle, type GoalSchedulerDelegate } from './features/goal/goalScheduler'
import type { ReservedSlashCommand } from './features/composer/slashCommands'
import { AppSidebar, type AppView } from './components/AppSidebar'
import { CommandPalette, paletteIcons, type PaletteAction } from './components/CommandPalette'
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog'
import { useToast } from './components/Toast'
import { VerbooPet, PET_MIN_SIZE, PET_MAX_SIZE, type PetState } from './features/pet/VerbooPet'
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
import { I18nProvider, createTranslator, useI18n, type Translator } from './i18n'
import {
  DEFAULT_CONVERSATION_TITLE,
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
  language: 'en-US',
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
  responseEnhancementsEnabled: false,
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
const EMPTY_LINE_KEYS = ['empty.line1', 'empty.line2', 'empty.line3', 'empty.line4'] as const

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

function isUsableWorkspaceDirectory(path?: string): path is string {
  const trimmed = path?.trim()
  return Boolean(trimmed && trimmed !== '/' && trimmed !== '.')
}

function firstUsableWorkspaceDirectory(...paths: Array<string | undefined>): string {
  return paths.find(isUsableWorkspaceDirectory) ?? ''
}

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
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | undefined>()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [petEnabled, setPetEnabled] = useState(() => window.localStorage.getItem('verboo:pet-enabled') === '1')
  const [petSize, setPetSize] = useState(() => {
    const stored = Number(window.localStorage.getItem('verboo:pet-size'))
    return Number.isFinite(stored) && stored >= PET_MIN_SIZE && stored <= PET_MAX_SIZE ? stored : 104
  })
  const [petActivity, setPetActivity] = useState<{ kind: string; label: string } | undefined>()
  const [petFlash, setPetFlash] = useState<'success' | 'error' | undefined>()
  const petFlashTimer = useRef<number>(undefined)
  const { toast } = useToast()
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [activeSubagents, setActiveSubagents] = useState<ActiveSubagent[]>([])
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | undefined>()
  const [subagentSummaryExpanded, setSubagentSummaryExpanded] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | undefined>()
  const [goal, setGoal] = useState<GoalState | undefined>()
  const [imageReadingTurnId, setImageReadingTurnId] = useState<string | undefined>()
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(initialSidebarPreference.current.mode)
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarPreference.current.width)
  const [reviewMetadata, setReviewMetadata] = useState<WorkspaceReviewMetadata | undefined>()
  const [branchInfo, setBranchInfo] = useState<WorkspaceBranchInfo | undefined>()
  const [reviewUnavailableReason, setReviewUnavailableReason] = useState<string | undefined>()
  const terminal = useLocalTerminal()
  const review = useReviewPanel()
  const t = useMemo(() => createTranslator(userSettings.language), [userSettings.language])
  const goalRef = useRef(goal)
  const [goalBarStatus, setGoalBarStatus] = useState<GoalStatusBarState>({ kind: 'idle' })
  const [emptyLineKey] = useState(() => EMPTY_LINE_KEYS[Math.floor(Math.random() * EMPTY_LINE_KEYS.length)])
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
  const currentWorkspaceDirectory = firstUsableWorkspaceDirectory(activeProject?.path, config.workingDirectory)
  const items = activeConversation?.items ?? [initialSystemMessage()]
  const conversationItemsRef = useRef<readonly TranscriptItem[]>(items)
  const chatStoreRef = useRef(chatStore)
  const hasConversation = items.some(item => item.role === 'user' || item.role === 'assistant')
  const emptyLine = t(emptyLineKey)
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
    const workingDirectory = currentWorkspaceDirectory
    if (!workingDirectory) return
    window.verboo.listSkills(workingDirectory).then(setSkills)
  }, [currentWorkspaceDirectory])

  useEffect(() => {
    const workingDirectory = currentWorkspaceDirectory
    if (!workingDirectory) {
      setReviewMetadata(undefined)
      setBranchInfo(undefined)
      return
    }
    window.verboo.getWorkspaceReviewMetadata(workingDirectory).then(setReviewMetadata).catch(() => setReviewMetadata(undefined))
    window.verboo.getWorkspaceBranches(workingDirectory).then(setBranchInfo).catch(() => setBranchInfo(undefined))
  }, [currentWorkspaceDirectory])

  useEffect(() => {
    if (!reviewUnavailableReason) return undefined
    const timer = window.setTimeout(() => setReviewUnavailableReason(undefined), 3600)
    return () => window.clearTimeout(timer)
  }, [reviewUnavailableReason])

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

    // Track the pointer 1:1 during the drag — the grid transition must not
    // ease the column behind the cursor (rubber-band feel).
    document.querySelector('.app-layout')?.classList.add('is-resizing')

    function handlePointerMove(moveEvent: PointerEvent) {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX))
    }

    function stopResize() {
      document.querySelector('.app-layout')?.classList.remove('is-resizing')
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
      setAuthError(result.ok ? undefined : t('login.logoutFailed'))
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
        setAuthError(authAccessMessage(modelDiscovery.error, cliStatus.error, t))
        void refreshProfile()
        return true
      }

      if (!allowRememberedSession) forgetRememberedAuthSession()
      setAuthError(authAccessMessage(modelDiscovery.error, cliStatus.error, t))
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

  async function updateLanguage(language: LanguageCode) {
    await updateUserSettings({ language })
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
      turnActivityKeys.current[event.turnId] ??= new Set()
      turnActivityCounts.current[event.turnId] ??= {}
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
      setImageReadingTurnId(current => (current === event.turnId ? undefined : current))
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
          label: t('transcript.terminalOne'),
          detail: snippet(event.text),
          kind: 'terminal',
        })
      }
      return
    }

    if (event.type === 'json') {
      let conversationId = turnConversationIds.current[event.turnId]
      if (!conversationId && event.runtimeActivity?.kind === 'image') {
        const pendingId = pendingConversationId.current
        if (pendingId) {
          conversationId = pendingId
          turnConversationIds.current[event.turnId] = conversationId
          turnStartedAt.current[event.turnId] = Date.now()
          setRunningTurnId(event.turnId)
          setThinkingTurnId(event.turnId)
          setImageReadingTurnId(event.turnId)
        }
      }
      const usage = extractContextUsage(event.payload, selectedContextWindowRef.current)
      if (usage) {
        setContextUsage(usage)
        if (conversationId && usage.maxTokens && usage.usedTokens > usage.maxTokens) {
          appendActivityItem(conversationId, event.turnId, {
            key: `context-over:${usage.maxTokens}`,
            label: t('context.overLimitLabel'),
            detail: t('context.overLimitDetail', {
              used: formatCompactNumber(usage.usedTokens, userSettings.language),
              max: formatCompactNumber(usage.maxTokens, userSettings.language),
            }),
            kind: 'context',
          })
        }
      }
      const activity = event.runtimeActivity
      if (activity && activity.kind !== 'thinking') {
        setPetActivity({ kind: activity.kind, label: `${activity.label} ${activity.detail ?? ''}` })
      }
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
      const conversationId = turnConversationIds.current[event.turnId]
      if (conversationId && event.result.sessionId) {
        updateConversationSession(conversationId, event.result.sessionId)
      }
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
      setImageReadingTurnId(current => (current === event.turnId ? undefined : current))
      clearActiveSubagentsForTurn(event.turnId)
      flashPet('error')

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
      setImageReadingTurnId(current => (current === event.turnId ? undefined : current))
      clearActiveSubagentsForTurn(event.turnId)
      flashPet(event.exitCode === 0 ? 'success' : 'error')
      if (conversationId && event.exitCode !== 0) {
        const failureMessage = buildCliFailureMessage(turnTerminalErrors.current[event.turnId], t)
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
    const responseLanguage = inferResponseLanguage(message, conversationLanguageFallback(conversationId))

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
        responseLanguage,
        accessMode: accessMode === 'full' && !userSettings.fullAccessEnabled ? 'approval' : accessMode,
        workingDirectory: workingDirectoryForConversation(conversationId),
        skills: selectedSkills,
        attachments: attachedFiles,
        responseEnhancementsEnabled: userSettings.responseEnhancementsEnabled,
        personality: userSettings.personality,
        customInstructions: userSettings.customInstructions,
        memoryContext: buildMemoryContext(chatStore, conversationId, userSettings),
      },
    }
  }

  function conversationLanguageFallback(conversationId: string): LanguageCode {
    const conversation = chatStoreRef.current.conversations.find(item => item.id === conversationId)
    const messages = [...(conversation?.items ?? [])].reverse()
    for (const item of messages) {
      if (item.role !== 'user') continue
      const detected = detectResponseLanguage(item.text)
      if (detected) return detected
    }
    return userSettingsRef.current.language
  }

  function enqueueFollowUp(item: QueuedFollowUp) {
    setQueuedFollowUpsList(current => [...current, item])
    appendConversationItem(item.conversationId, {
      id: `${item.id}:queued`,
      role: 'tool',
      kind: 'activity',
      activityKind: 'queued',
      text: t('transcript.queuedTitle'),
      activityDetail: t('transcript.queuedDetail'),
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
    const turnId = await sendTrackedTurn(request, conversationCliSessionId(item.conversationId))
    turnConversationIds.current[turnId] = item.conversationId
    turnModels.current[turnId] = item.turnModel
    attachPendingResearchSubagents(turnId)
    tagAssistantMessage(item.conversationId, turnId, item.turnModel)
    if (pendingConversationId.current === item.conversationId) pendingConversationId.current = undefined
  }

  async function sendTrackedTurn(request: AgentTurnRequest, resumeSessionId?: string): Promise<string> {
    const baseline = await snapshotWorkspaceChanges(request.workingDirectory)
    const clientTurnId = request.turnId ?? crypto.randomUUID()
    const turnId = await window.verboo.sendTurn({ ...request, turnId: clientTurnId }, resumeSessionId)
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
        ? t('subagent.localMission')
        : t('subagent.complementaryMission')
      const status = index === 0 ? 'reading' : 'searching'
      return {
        id: `research:${item.id}:${index + 1}`,
        runId,
        label: subagentNameFor(`${item.id}:${index}`, index),
        detail: index === 0 ? t('subagent.localDetail') : t('subagent.complementaryDetail'),
        mission,
        history: [
          {
            id: `mission:${index + 1}`,
            label: t('subagent.missionReceived'),
            text: mission,
            timestamp: Date.now() + index,
          },
          {
            id: `status:${index + 1}:start`,
            label: subagentStatusLabel(status, t),
            text: index === 0 ? t('subagent.readingProject') : t('subagent.searchingSupport'),
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
      text: t('subagent.researching', {
        count: researchRequest.count,
        label: t(researchRequest.count === 1 ? 'subagent.single' : 'subagent.plural'),
      }),
      activityDetail: researchRequest.requestedCount > researchRequest.count
        ? t('subagent.limited', { count: researchRequest.count })
        : t('subagent.readOnlyBeforeTurn'),
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
        text: t('subagent.completed'),
        activityDetail: formatResearchResultsForTranscript(results, agents, t),
        timestamp: Date.now(),
      })

      const finishedAgents = agents.map((agent, index) => {
        const result = results[index]
        const status = result?.status === 'complete' ? 'done' : 'failed'
        const summary = result?.summary || (status === 'done' ? t('subagent.done') : t('subagent.failed'))
        return {
          ...agent,
          status,
          detail: summary,
          updatedAt: Date.now() + index,
          history: [
            ...(agent.history ?? []),
            {
              id: `result:${index + 1}`,
              label: subagentStatusLabel(status, t),
              text: summary,
              timestamp: Date.now() + index,
            },
          ],
        } satisfies ActiveSubagent
      })
      const researchContext = buildResearchResultsContext(results, finishedAgents, t)
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
        text: t('subagent.failed'),
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
        detail: t('subagent.cancelledDetail'),
        updatedAt: now,
        history: appendSubagentHistory(current.history, {
          id: `${current.id}:cancelled:${now}`,
          label: t('subagent.cancelledLabel'),
          text: t('subagent.cancelledText'),
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
      text: t('transcript.fullModeFallback'),
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
        ? automatic ? t('permissionPrompt.approvedAutomatic') : t('permissionPrompt.approved')
        : t('permissionPrompt.denied'),
      activityDetail: prompt.command ?? prompt.detail,
      timestamp: Date.now(),
    })

    const responseLanguage = inferResponseLanguage(
      turnAssistantText.current[prompt.turnId] ?? prompt.detail,
      conversationLanguageFallback(prompt.conversationId),
    )
    const message = buildPermissionFollowUpMessage(prompt, decision, automatic, responseLanguage)
    const followUp = createPermissionFollowUp(prompt.conversationId, message, responseLanguage)
    stickToBottomRef.current = true
    setShowJumpToLatest(false)

    if (runningTurnId) {
      enqueueFollowUp(followUp)
      return
    }
    appendDowngradeActivity(prompt.conversationId)
    await runTurn(followUp)
  }

  function createPermissionFollowUp(conversationId: string, message: string, responseLanguage: LanguageCode): QueuedFollowUp {
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
        responseLanguage,
        accessMode: accessMode === 'full' && !userSettings.fullAccessEnabled ? 'approval' : accessMode,
        workingDirectory: workingDirectoryForConversation(conversationId),
        skills: [],
        attachments: [],
        responseEnhancementsEnabled: userSettings.responseEnhancementsEnabled,
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

  function flashPet(kind: 'success' | 'error') {
    setPetActivity(undefined)
    setPetFlash(kind)
    window.clearTimeout(petFlashTimer.current)
    petFlashTimer.current = window.setTimeout(() => setPetFlash(undefined), 2600)
  }

  // The pet mirrors what the agent is doing. Deletion has no dedicated
  // activity kind, so it is inferred from the action label/command text.
  const petState: PetState = useMemo(() => {
    if (petFlash) return petFlash
    if (!runningTurnId) return 'idle'
    const kind = petActivity?.kind
    const label = petActivity?.label ?? ''
    const deleting = /\b(rm|del|delete|remove|unlink)\b|apag|remov|exclu/i.test(label)
    if (kind === 'command' || kind === 'terminal') return deleting ? 'deleting' : 'command'
    if (kind === 'edit') return deleting ? 'deleting' : 'editing'
    if (kind === 'read' || kind === 'search') return 'reading'
    return 'thinking'
  }, [petFlash, runningTurnId, petActivity])

  function togglePet() {
    setPetEnabled(current => {
      const next = !current
      window.localStorage.setItem('verboo:pet-enabled', next ? '1' : '0')
      return next
    })
  }

  function updatePetSize(size: number) {
    const clamped = Math.round(Math.max(PET_MIN_SIZE, Math.min(PET_MAX_SIZE, size)))
    setPetSize(clamped)
    window.localStorage.setItem('verboo:pet-size', String(clamped))
  }

  useEffect(() => {
    function handlePaletteShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(current => !current)
      }
    }
    window.addEventListener('keydown', handlePaletteShortcut)
    return () => window.removeEventListener('keydown', handlePaletteShortcut)
  }, [])

  // Actions only dereference their handlers when clicked (after render), so
  // referencing callbacks declared later in the component is safe here.
  const paletteActions: PaletteAction[] = useMemo(() => [
    { key: 'new-chat', label: t('palette.newChat'), icon: paletteIcons.newChat, run: () => { setActiveView('chat'); newChat() } },
    { key: 'settings', label: t('palette.openSettings'), icon: paletteIcons.settings, run: () => setActiveView('settings') },
    { key: 'theme', label: t('palette.toggleTheme'), icon: paletteIcons.theme, run: () => setTheme(current => current === 'dark' ? 'light' : 'dark') },
    { key: 'terminal', label: t('palette.toggleTerminal'), icon: paletteIcons.terminal, run: () => handleToggleTerminal(currentWorkspaceDirectory) },
    { key: 'review', label: t('palette.toggleReview'), icon: paletteIcons.review, run: () => { void handleToggleReview() } },
    { key: 'sidebar', label: t('palette.toggleSidebar'), icon: paletteIcons.sidebar, run: toggleSidebarVisibility },
    { key: 'pet', label: t('palette.togglePet'), icon: paletteIcons.pet, run: togglePet },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, currentWorkspaceDirectory])

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
      goalAbortRef.current?.abort()

      const conversationId = ensureActiveConversation()
      const wd = workingDirectoryForConversation(conversationId)

      setGoal(undefined)
      setGoalBarStatus({ kind: 'idle' })
      goalSessionId.current = undefined

      const goalState = createGoalState({
        objective: command.objective,
        accessMode, // any mode, incl. 'full'; continueGoal downgrades to 'approval' unless full access is enabled in settings
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

        const goalLanguage = inferResponseLanguage(currentGoal.objective, conversationLanguageFallback(conversationId))
        const turnId = await sendTrackedTurn({
          message: nextMessage,
          model: selectedModel,
          modelSupportsVision: Boolean(selectedModelInfo?.supportsVision),
          contextWindow: selectedContextWindow,
          responseLanguage: inferResponseLanguage(nextMessage, goalLanguage),
          accessMode: accessMode === 'full' && !userSettings.fullAccessEnabled ? 'approval' : accessMode,
          workingDirectory: currentGoal.workingDirectory,
          skills: currentGoal.skills,
          attachments: [],
          responseEnhancementsEnabled: userSettings.responseEnhancementsEnabled,
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
    appendAttachments(attachments)
  }

  async function attachDroppedFiles(paths: string[], files: File[]) {
    if (!paths.length && !files.length) return
    const attachments = paths.length
      ? await window.verboo.inspectFiles(paths)
      : await window.verboo.inspectDroppedFiles(files)
    if (!attachments.length) return
    appendAttachments(attachments)
  }

  function appendAttachments(attachments: AttachmentMeta[]) {
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
    setConfirmRequest({
      title: t('confirm.deleteChatTitle'),
      description: t('confirm.deleteChatBody'),
      confirmLabel: t('common.delete'),
      danger: true,
      onConfirm: () => {
        updateChatStore(store => ({
          ...store,
          conversations: store.conversations.filter(conversation => conversation.id !== conversationId),
        }))
        if (activeConversationId === conversationId) setActiveConversationId(undefined)
        toast(t('toast.chatDeleted'), 'info')
      },
    })
  }

  function archiveProject(projectId: string) {
    setConfirmRequest({
      title: t('confirm.archiveProjectTitle'),
      description: t('confirm.archiveProjectBody'),
      confirmLabel: t('confirm.archiveProjectAction'),
      onConfirm: () => {
        performArchiveProject(projectId)
        toast(t('toast.projectArchived'), 'info')
      },
    })
  }

  function performArchiveProject(projectId: string) {
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
    setConfirmRequest({
      title: t('confirm.deleteProjectTitle'),
      description: t('confirm.deleteProjectBody'),
      confirmLabel: t('common.delete'),
      danger: true,
      onConfirm: () => {
        updateChatStore(store => ({
          ...store,
          projects: store.projects.filter(project => project.id !== projectId),
          conversations: store.conversations.filter(conversation => conversation.projectId !== projectId),
        }))
        if (activeProject?.id === projectId) {
          setActiveConversationId(undefined)
          setSelectedProjectId(undefined)
        }
        toast(t('toast.projectDeleted'), 'info')
      },
    })
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
      title: conversation.title === DEFAULT_CONVERSATION_TITLE && title ? title : conversation.title,
      items: [...conversation.items, item],
      updatedAt: Date.now(),
    }))
  }

  function conversationCliSessionId(conversationId: string): string | undefined {
    return chatStoreRef.current.conversations.find(conversation => conversation.id === conversationId)?.cliSessionId
  }

  function updateConversationSession(conversationId: string, cliSessionId: string) {
    updateConversation(conversationId, conversation => {
      if (conversation.cliSessionId === cliSessionId) return conversation
      return {
        ...conversation,
        cliSessionId,
        updatedAt: Date.now(),
      }
    })
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
      ? { input: activity.detail ?? t('composer.command'), output: '', status: 'running' }
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
          text: activityDisplayLabel(activity, t),
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
          detail: t('subagent.completed'),
          updatedAt: Date.now(),
          history: appendSubagentHistory(previous.history, {
            id: `${id}:done:${Date.now()}`,
            label: t('subagent.completed'),
            text: activity.detail || t('subagent.completed'),
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
      detail: compactSubagentDetail(activity, t),
      mission: previous?.mission ?? t('subagent.readOnlyBeforeTurn'),
      history: appendSubagentHistory(previous?.history, {
        id: `${id}:activity:${Date.now()}`,
        label: activityDisplayLabel(activity, t),
        text: activity.detail || compactSubagentDetail(activity, t),
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
    const elapsed = startedAt ? formatElapsed(Date.now() - startedAt) : t('transcript.someSeconds')
    const counts = turnActivityCounts.current[turnId] ?? {}
    const result = turnResultSnapshots.current[turnId]
    const changeSummary = await buildTurnChangeSummary(turnId)
    const summaryLines = buildTurnSummaryLines(counts, result, exitCode, t, {
      validationCommands: validationCommandsForTurn(turnCommands.current[turnId] ?? []),
      references: turnReferences.current[turnId] ?? [],
      changeSummary,
    })

    appendConversationItem(conversationId, {
      id: `${turnId}:summary`,
      role: 'system',
      kind: 'summary',
      text: t('transcript.workedFor', { elapsed }),
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
    const conversationProject = conversation?.projectId
      ? chatStore.projects.find(item => item.id === conversation.projectId)
      : undefined
    const selectedProject = selectedProjectId
      ? chatStore.projects.find(item => item.id === selectedProjectId && !item.archivedAt)
      : undefined
    return firstUsableWorkspaceDirectory(
      conversationProject?.path,
      selectedProject?.path,
      activeProject?.path,
      config.workingDirectory,
    )
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

  const projectName = activeProject?.name ?? t('project.none')
  const workspaceDirectory = currentWorkspaceDirectory
  const shownProjects = activeProjects(chatStore)
  const shownConversations = visibleConversations(chatStore)
  const archivedChats = archivedConversations(chatStore)

  const handleToggleTerminal = useCallback((cwd: string) => {
    setReviewUnavailableReason(undefined)
    review.close()
    void terminal.toggle(cwd)
  }, [review, terminal])

  const handleToggleReview = useCallback(async () => {
    if (review.reviewOpen) {
      review.close()
      return
    }

    const workingDirectory = currentWorkspaceDirectory
    if (!workingDirectory) {
      setReviewUnavailableReason(t('review.openFolderRequired'))
      return
    }

    const metadata = await window.verboo.getWorkspaceReviewMetadata(workingDirectory).catch(() => undefined)
    if (metadata) setReviewMetadata(metadata)
    const branches = await window.verboo.getWorkspaceBranches(workingDirectory).catch(() => undefined)
    if (branches) setBranchInfo(branches)
    if (metadata?.capabilities.canDiff === false) {
      setReviewUnavailableReason(t('review.gitRequired'))
      return
    }

    const summary = await window.verboo.getWorkspaceChanges(workingDirectory).catch(() => undefined)
    if (!summary) {
      setReviewUnavailableReason(t('review.loadChangesFailed'))
      return
    }

    setReviewUnavailableReason(undefined)
    terminal.close()
    setSelectedSubagentId(undefined)
    review.open(workingDirectory, summary.files, 0)
  }, [currentWorkspaceDirectory, review, terminal, t])

  const handleOpenReview = useCallback((files: WorkspaceChangeEntry[], index: number) => {
    const workingDirectory = currentWorkspaceDirectory
    if (!workingDirectory) return
    terminal.close()
    setSelectedSubagentId(undefined)
    review.open(workingDirectory, files, index)
  }, [currentWorkspaceDirectory, review, terminal])

  async function refreshWorkspaceReview() {
    if (!review.target) return
    const summary = await window.verboo.getWorkspaceChanges(review.target.workingDirectory)
    review.open(review.target.workingDirectory, summary.files, Math.min(review.target.index, Math.max(0, summary.files.length - 1)))
  }

  const handleSwitchReviewBranch = useCallback(async (branchName: string) => {
    const workingDirectory = review.target?.workingDirectory ?? currentWorkspaceDirectory
    const result = await window.verboo.switchWorkspaceBranch(workingDirectory, branchName)
    if (result.branchInfo) setBranchInfo(result.branchInfo)
    if (!result.ok) return result

    const [metadata, branches, summary] = await Promise.all([
      window.verboo.getWorkspaceReviewMetadata(workingDirectory).catch(() => undefined),
      window.verboo.getWorkspaceBranches(workingDirectory).catch(() => undefined),
      window.verboo.getWorkspaceChanges(workingDirectory).catch(() => undefined),
    ])
    if (metadata) setReviewMetadata(metadata)
    if (branches) setBranchInfo(branches)
    if (summary) review.open(workingDirectory, summary.files, 0)
    return { ...result, branchInfo: branches ?? result.branchInfo }
  }, [currentWorkspaceDirectory, review])

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
      workingDirectory: currentWorkspaceDirectory,
      loggedIn: cliAuth.loggedIn || credentials.hasApiKey,
      email: cliAuth.email ?? profile.user?.email,
    }
    void window.verboo.updateMenuBar(state)
  }, [
    currentWorkspaceDirectory,
    workingSubagents.length,
    cliAuth.email,
    cliAuth.loggedIn,
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
      <I18nProvider language={userSettings.language}>
        <LoginScreen
          language={userSettings.language}
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
          onLanguageChange={updateLanguage}
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
      </I18nProvider>
    )
  }

  return (
    <I18nProvider language={userSettings.language}>
    <main className="app-shell" style={appLayoutStyle}>
      <TopBar
        sidebarVisible={sidebarMode !== 'hidden'}
        statusLabel={runningTurnId ? t('topbar.statusWorking') : t('topbar.statusReady')}
        onToggleSidebar={toggleSidebarVisibility}
        terminalOpen={terminal.terminalOpen}
        terminalUnavailableReason={terminal.terminalUnavailableReason}
        onToggleTerminal={() => handleToggleTerminal(workspaceDirectory || '')}
        reviewOpen={review.reviewOpen}
        reviewUnavailableReason={reviewUnavailableReason}
        onToggleReview={handleToggleReview}
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
              title={t('workspace.resizeSidebar')}
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
            <div className="workspace-folder-badge" title={workspaceDirectory || t('workspace.noProjectOpen')}>
              <FolderClosed size={14} />
              <span>{workspaceFolderName(workspaceDirectory, activeProject?.name, t('project.none'))}</span>
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
              petEnabled={petEnabled}
              petSize={petSize}
              onPetToggle={togglePet}
              onPetSizeChange={updatePetSize}
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
              <Transcript
                items={items}
                onOpenReview={handleOpenReview}
                reviewMetadata={reviewMetadata}
                thinkingTurnId={thinkingTurnId}
                imageReadingTurnId={imageReadingTurnId}
              />
              <div ref={transcriptEndRef} className="transcript-end" />
            </>
          ) : (
            <EmptyChat projectName={projectName || t('project.none')} line={emptyLine} />
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
          onReverted={refreshWorkspaceReview}
          onSwitchBranch={handleSwitchReviewBranch}
          minWidth={review.MIN_WIDTH}
          maxWidth={review.MAX_WIDTH}
          capabilities={reviewMetadata?.capabilities}
          branchInfo={branchInfo}
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
            <button className="jump-to-latest" type="button" onClick={() => scrollToLatest('smooth')} title={t('workspace.jumpToLatest')}>
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
            onDropFiles={attachDroppedFiles}
            onRemoveAttachment={path => setAttachedFiles(current => current.filter(item => item.path !== path))}
            onSubmit={sendMessage}
            onGoalCommand={handleGoalCommand}
            onPetCommand={togglePet}
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
                  hasConversationHistory={hasConversation}
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

      <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(undefined)} />

      <CommandPalette
        open={paletteOpen}
        conversations={chatStore.conversations}
        actions={paletteActions}
        onSelectConversation={conversationId => {
          setActiveView('chat')
          setActiveConversationId(conversationId)
        }}
        onClose={() => setPaletteOpen(false)}
      />

      <VerbooPet visible={petEnabled} state={petState} size={petSize} onSizeChange={updatePetSize} />
    </main>
    </I18nProvider>
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
  const { t } = useI18n()
  if (agents.length === 0) return null
  const title = String(agents.length)

  return (
    <section className={`subagent-summary-card ${expanded ? 'expanded' : ''}`} aria-label={t('subagent.activeAria')}>
      <button
        className="subagent-summary-header"
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
      >
        <span className="subagent-summary-title">
          <GitBranch size={14} />
          {t('subagent.summaryTitle')}
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
                  {subagentStatusLabel(agent.status, t)}
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
  const { t } = useI18n()
  const Icon = subagentStatusIcon(agent.status)
  const history = agent.history ?? []
  const canCancel = isActiveSubagentWorking(agent)

  return (
    <aside className="research-subagent-panel" data-status={agent.status} aria-label={t('subagent.threadAria', { name: agent.label })}>
      <header className="research-subagent-header">
        <div className="research-subagent-header-row">
          <span className="research-subagent-tab">
            <GitBranch size={14} />
            <strong>{agent.label}</strong>
          </span>
          <button
            type="button"
            className="research-subagent-close ui-tooltip"
            data-tooltip={canCancel ? t('subagent.cancelSearch') : t('subagent.closePanel')}
            data-tooltip-align="end"
            onClick={() => {
              if (canCancel) {
                void onCancel(agent)
                return
              }
              onClose()
            }}
            aria-label={canCancel ? t('subagent.cancelAria') : t('subagent.closeAria')}
          >
            <XCircle size={16} />
          </button>
        </div>
        <span className="research-subagent-state">
          <Icon size={13} />
          {subagentStatusLabel(agent.status, t)}
        </span>
      </header>

      <section className="research-subagent-thread" aria-label={t('subagent.historyAria', { name: agent.label })}>
        <div className="research-subagent-message mission">
          <small>{t('subagent.mission')}</small>
          <p>{agent.mission || agent.detail || t('subagent.defaultMission')}</p>
        </div>
        {history.map(item => (
          <div key={item.id} className="research-subagent-message">
            <small>{item.label}</small>
            <p>{item.text}</p>
          </div>
        ))}
      </section>

      <footer className="research-subagent-footer">
        {t('subagent.readOnlyHistory')}
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
  const { t } = useI18n()
  return (
    <section className="permission-approval-panel" aria-live="polite">
      <div className="permission-approval-icon">
        <Terminal size={16} />
      </div>
      <div className="permission-approval-copy">
        <strong>{t('permissionPrompt.title')}</strong>
        <p>{prompt.command ? t('permissionPrompt.commandBody') : prompt.detail}</p>
        {prompt.command && <code>{prompt.command}</code>}
      </div>
      <div className="permission-approval-actions">
        <button type="button" onClick={onDeny}>
          <XCircle size={15} />
          {t('permissionPrompt.deny')}
        </button>
        {prompt.command && (
          <button className="trust" type="button" onClick={onAlwaysAllow}>
            <ShieldCheck size={15} />
            {t('permissionPrompt.alwaysAllow')}
          </button>
        )}
        <button className="primary" type="button" onClick={onAllow}>
          {t('permissionPrompt.allow')}
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

function authAccessMessage(modelError: string | undefined, cliError: string | undefined, t: Translator): string {
  const error = modelError ?? cliError
  if (/401|expired token|invalid.*token/i.test(error ?? '')) {
    return t('model.expired')
  }
  if (/network|fetch|timeout|tempo limite/i.test(error ?? '')) {
    return t('model.networkError')
  }
  return t('login.sessionInvalid')
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

function formatResearchResultsForTranscript(
  results: ResearchSubagentResult[],
  agents: ActiveSubagent[],
  t: Translator,
): string {
  if (results.length === 0) return t('subagent.noResults')
  return results
    .map(result => {
      const agentName = agents[result.index - 1]?.label ?? `Subagente ${result.index}`
      const status = result.status === 'complete' ? t('subagent.resultComplete') : t('subagent.resultFailed')
      const sources = result.sources.length ? ` ${t('subagent.sources')}: ${result.sources.slice(0, 3).join('; ')}.` : ''
      return `${agentName} ${status}: ${result.summary}${sources}`
    })
    .join('\n')
}

function buildResearchResultsContext(
  results: ResearchSubagentResult[],
  agents: ActiveSubagent[],
  t: Translator,
): string {
  if (results.length === 0) return ''
  return [
    t('subagent.resultsContextTitle'),
    '',
    ...results.map(result => [
      `${agents[result.index - 1]?.label ?? `Subagente ${result.index}`} (${result.status}):`,
      `${t('subagent.summary')}: ${result.summary}`,
      result.findings.length ? `${t('subagent.findings')}:\n${result.findings.map(finding => `- ${finding}`).join('\n')}` : '',
      result.sources.length ? `${t('subagent.sources')}:\n${result.sources.map(source => `- ${source}`).join('\n')}` : '',
    ].filter(Boolean).join('\n')),
  ].join('\n\n')
}

function subagentStatusLabel(status: ActiveSubagent['status'], t: Translator): string {
  if (status === 'reading') return t('subagent.reading')
  if (status === 'searching') return t('subagent.searching')
  if (status === 'done') return t('subagent.done')
  if (status === 'failed') return t('subagent.failed')
  return t('subagent.thinking')
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

function compactSubagentDetail(activity: TurnActivity, t: Translator): string {
  const status = subagentStatusForActivity(activity)
  if (status === 'reading') return t('subagent.readingProject')
  if (status === 'searching') return t('subagent.searchingSupport')
  if (status === 'done') return t('subagent.completed')
  if (status === 'failed') return t('subagent.cancelledText')
  return t('subagent.defaultMission')
}

function activityDisplayLabel(activity: TurnActivity, t: Translator): string {
  if (activity.kind === 'read') return t('transcript.readOne')
  if (activity.kind === 'edit') return t('transcript.editOne')
  if (activity.kind === 'search') return t('transcript.searchOne')
  if (activity.kind === 'command') return t('transcript.commandOne')
  if (activity.kind === 'terminal') return t('transcript.terminalOne')
  if (activity.kind === 'image') return t('transcript.imageOne')
  if (activity.kind === 'permission') return t('transcript.permissionOne')
  if (activity.kind === 'subagent') return t('transcript.subagentOne')
  if (activity.kind === 'context') return activity.label
  if (activity.kind === 'queued') return activity.label
  if (activity.kind === 'thinking') return t('transcript.thinking')
  return t('transcript.toolOne')
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

function workspaceFolderName(path: string, projectName?: string, fallback = 'No project'): string {
  if (projectName?.trim()) return projectName.trim()
  const trimmed = path.trim()
  if (!trimmed) return fallback
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
  t: Translator,
  details?: {
    validationCommands?: string[]
    references?: string[]
    changeSummary?: WorkspaceChangeSummary
  },
): string[] {
  const actions = [
    actionCount(counts.read, t('transcript.readInspectedFiles')),
    actionCount(counts.edit, t('transcript.editedFiles')),
    actionCount(counts.command, t('transcript.ranCommands')),
    actionCount(counts.search, t('transcript.searchInternet')),
    actionCount(counts.terminal, t('transcript.readTerminal')),
    actionCount(counts.permission, t('transcript.askedPermission')),
    actionCount(counts.tool, t('transcript.usedTools')),
  ].filter(Boolean)

  const lines = actions.length ? [`${t('transcript.summaryPrefix')} ${actions.join(', ')}.`] : []

  if (details?.references?.length) {
    lines.push(t('transcript.referencesChecked', { items: formatShortList(details.references, t) }))
  }
  if (details?.validationCommands?.length) {
    lines.push(t('transcript.validationDone', { items: formatShortList(details.validationCommands, t) }))
  }
  if (details?.changeSummary?.totalFiles) {
    lines.push(t('transcript.changedFiles', {
      count: details.changeSummary.totalFiles,
      additions: formatSignedCount(details.changeSummary.additions, '+'),
      deletions: formatSignedCount(details.changeSummary.deletions, '-'),
    }))
  }
  if (result?.stopReason) lines.push(t('transcript.stopReason', { reason: result.stopReason }))
  if (exitCode !== 0) {
    lines.push(exitCode === null ? t('transcript.processUnknown') : t('transcript.exitCode', { code: exitCode }))
  }
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

function formatShortList(values: string[], t: Translator): string {
  const unique = values.filter((value, index) => values.findIndex(item => item.toLowerCase() === value.toLowerCase()) === index)
  const visible = unique.slice(0, 3)
  const suffix = unique.length > visible.length ? ` ${t('transcript.moreItems', { count: unique.length - visible.length })}` : ''
  return `${visible.join(', ')}${suffix}`
}

function formatSignedCount(value: number, sign: '+' | '-'): string {
  return `${sign}${Math.max(0, value)}`
}

function buildCliFailureMessage(lines: string[] | undefined, t: Translator): string | undefined {
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
  return `${t('transcript.cliFailureTitle')}\n\n${visible.join('\n')}\n`
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
  const fallback = inferResponseLanguage(text, 'en-US') === 'pt-BR'
    ? 'O agente pediu permissão para continuar.'
    : 'The agent asked for permission to continue.'
  return snippet(focusedLine ?? fallback)
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
  language: LanguageCode,
): string {
  const denied = language === 'en-US'
    ? [
        'Permission denied.',
        prompt.command ? `Do not run this command: ${prompt.command}` : '',
        'Continue with a safe alternative or explain the blocker clearly.',
      ]
    : [
        'Permissão negada.',
        prompt.command ? `Não execute este comando: ${prompt.command}` : '',
        'Continue com uma alternativa segura ou explique o bloqueio de forma objetiva.',
      ]
  const approved = language === 'en-US'
    ? [
        automatic ? 'Permission approved automatically by a trusted rule saved in this app.' : 'Permission approved.',
        prompt.command ? `Approved command: ${prompt.command}` : '',
        'Continue exactly where you stopped and run only the approved action before moving on.',
      ]
    : [
        automatic ? 'Permissão aprovada automaticamente por regra confiável salva neste app.' : 'Permissão aprovada.',
        prompt.command ? `Comando aprovado: ${prompt.command}` : '',
        'Continue exatamente do ponto em que parou e execute apenas a ação aprovada antes de seguir.',
      ]
  if (decision === 'deny') {
    return denied.filter(Boolean).join('\n')
  }

  return approved.filter(Boolean).join('\n')
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

function inferResponseLanguage(text: string, fallback: LanguageCode = 'en-US'): LanguageCode {
  return detectResponseLanguage(text) ?? fallback
}

function detectResponseLanguage(text: string): LanguageCode | undefined {
  const normalized = text.toLowerCase()
  const portugueseSignals = [
    /[áàâãéêíóôõúç]/i,
    /\b(o|a|os|as|um|uma|de|do|da|dos|das|para|por|com|sem|que|não|nao|você|voce|olá|ola|oi|teste|testar|quero|preciso|precisa|pode|faça|faca|mude|mudança|mudanca|arrume|verifique|corrija|implemente|adicione|remova|leia|crie|rode|execute|obrigado|obrigada|pronto)\b/i,
  ]
  const englishSignals = [
    /\b(the|and|or|to|from|with|without|please|hello|hi|test|ready|done|fix|check|verify|implement|add|remove|update|create|read|write|run|execute|open|package|build|thanks)\b/i,
  ]
  const ptScore = portugueseSignals.reduce((score, pattern) => score + (pattern.test(normalized) ? 1 : 0), 0)
  const enScore = englishSignals.reduce((score, pattern) => score + (pattern.test(normalized) ? 1 : 0), 0)
  if (ptScore > enScore) return 'pt-BR'
  if (enScore > ptScore) return 'en-US'
  return undefined
}

function formatCompactNumber(value: number, language: LanguageCode): string {
  return Intl.NumberFormat(language, {
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
