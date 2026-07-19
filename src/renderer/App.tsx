import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDown, CheckCircle2, ChevronDown, ChevronRight, FolderClosed, GitBranch, LoaderCircle, X, XCircle } from 'lucide-react'
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
  ResearchSubagentProgress,
  ResearchSubagentResult,
  RuntimeActivity,
  SettingsTab,
  SkillSummary,
  StoredConversation,
  ThemeMode,
  TokenRateSnapshot,
  TokenUsage,
  TranscriptItem,
  UpdateSnapshot,
  UserSettings,
  VerbooModel,
  WorkspaceBranchInfo,
  WorkspaceChangeEntry,
  WorkspaceChangeSummary,
  WorkspaceReviewMetadata,
} from '../shared/types'
import { createGoalState, goalSystemMessage } from './features/goal/goalState'
import { GoalStatusBar, type GoalStatusBarState } from './features/goal/GoalStatusBar'
import { GoalActivePanel } from './features/goal/GoalActivePanel'
import { buildObjectiveUpdatedPrompt } from './features/goal/goalPrompt'
import { runGoalCycle, type GoalSchedulerDelegate } from './features/goal/goalScheduler'
import type { ReservedSlashCommand } from './features/composer/slashCommands'
import { AppSidebar, type AppView } from './components/AppSidebar'
import { CommandPalette, paletteIcons, type PaletteAction } from './components/CommandPalette'
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog'
import { useToast } from './components/Toast'
import { VerbooPet, PET_MIN_SIZE, PET_MAX_SIZE, type PetState } from './features/pet/VerbooPet'
import { QuestionWizard, type ModelQuestion, type QuestionAnswer, type QuestionPromptState } from './features/questions/QuestionWizard'
import { detectTextQuestionPrompt, extractModelQuestionsFromPayload, mergeModelQuestions } from './features/questions/questionDetection'
import { MessageCircleQuestion } from 'lucide-react'
import { useLocalTerminal } from './features/terminal/useLocalTerminal'
import { LocalTerminalPanel } from './features/terminal/LocalTerminalPanel'
import { useTheme } from './features/theme/useTheme'
import { ReviewPanel } from './features/review/ReviewPanel'
import { useReviewPanel } from './features/review/useReviewPanel'
import { EmptyChat } from './components/EmptyChat'
import { LoginScreen } from './components/LoginScreen'
import { TopBar } from './components/TopBar'
import { Transcript } from './components/Transcript'
import { UpdateBanner } from './components/UpdateBanner'
import { AccessSelector } from './features/access/AccessSelector'
import { PermissionApprovalPanel, type PendingPermissionPrompt } from './features/permission/PermissionApprovalPanel'
import { VisionFallbackModal } from './features/vision/VisionFallbackModal'
import { SkillApprovalPanel } from './features/skills/SkillApprovalPanel'
import type { ExtractionStatus, ModelReasoning, VisionFallbackConsent, VisionFallbackState } from '../shared/types'
import { recognizeImage } from './features/ocr/ocrService'
import { Composer } from './features/composer/Composer'
import { estimateTotalContextTokens } from './features/context/ContextPanel'
import { TokenRateMeter } from './features/context/TokenRateMeter'
import { isAuthenticationFailure, shouldAutoRecoverAuthentication } from './features/transcript/cliFailureRecovery'
import { FeedbackDialog } from './features/feedback/FeedbackDialog'
import { ModelSelector } from './features/models/ModelSelector'
import { validOverride, displayEffort, migrateEffortPrefs } from './features/models/effortOverride'
import { ProfileView } from './features/profile/ProfileView'
import { PluginsView } from './features/plugins/PluginsView'
import { loadPluginSkillSummaries } from './features/plugins/pluginSkillSummaries'
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
const EFFORT_BY_MODEL_KEY = 'verboo:effort-by-model'
const AUTH_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const REPORTED_CONTEXT_WINDOWS_KEY = 'verboo:reported-context-windows'
const SIDEBAR_PREF_KEY = 'verboo:sidebar-preference'
const SIDEBAR_DEFAULT_WIDTH = 292
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const SIDEBAR_COMPACT_WIDTH = 72
const BOTTOM_STICK_THRESHOLD = 72
const SCROLL_SETTLE_MS = 360
const DEFAULT_USER_SETTINGS: UserSettings = {
  language: 'en-US',
  theme: 'system',
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
  customSlashCommands: [],
  memoriesEnabled: false,
  chroniclePreview: false,
  ignoreToolChatsForMemory: true,
  goalMode: {
    enabled: true,
    maxTurns: Number.MAX_SAFE_INTEGER,
    maxElapsedMinutes: Number.MAX_SAFE_INTEGER,
    allowAutoAccess: true,
  },
  updates: {
    channel: 'stable',
    autoCheck: true,
    autoDownload: false,
  },
  visionFallbackConsent: 'ask',
  trustedSkills: [],
  avatar: undefined,
  includeVerbooCoAuthor: false,
  loadWebIcons: true,
}
const EMPTY_LINE_KEYS = [
  'empty.line1',
  'empty.line2',
  'empty.line3',
  'empty.line4',
  'empty.line5',
  'empty.line6',
  'empty.line7',
  'empty.line8',
  'empty.line9',
  'empty.line10',
  'empty.line11',
  'empty.line12',
  'empty.line13',
  'empty.line14',
] as const

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

type TokenRateSample = {
  firstAt: number
  lastAt: number
  lastOutputTokens: number
  smoothedRate?: number
  requestCount: number
  requestsPerMinute?: number
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

type PermissionDecision = 'allow' | 'deny' | 'always'
type SidebarMode = 'expanded' | 'compact' | 'hidden'

// Transient peek state — when sidebarMode === 'hidden', hovering the rail
// expands the sidebar visually WITHOUT persisting as 'expanded'. Mouse leave
// (with a small delay to avoid flicker) returns to 'hidden'. Pin button or any
// persistent toggle sets sidebarMode='expanded' and clears peek.
// Touch devices keep the explicit topbar button (hover is unreliable).
const SIDEBAR_PEEK_LEAVE_DELAY_MS = 100
// Duration of the CSS leave animation (sidebar-peek-leave). The shell stays
// mounted with .is-peek-leaving for this long before final unmount, so the
// fade-out is actually visible. Must match the leave keyframe duration in
// layout.css.
const SIDEBAR_PEEK_LEAVE_ANIM_MS = 220

function isUsableWorkspaceDirectory(path?: string): path is string {
  const trimmed = path?.trim()
  return Boolean(trimmed && trimmed !== '/' && trimmed !== '.')
}

function firstUsableWorkspaceDirectory(...paths: Array<string | undefined>): string {
  return paths.find(isUsableWorkspaceDirectory) ?? ''
}

export function App() {
  const initialSidebarPreference = useRef(readSidebarPreference())
  const defaultWorkingDirectoryRef = useRef('')
  const [config, setConfig] = useState<AppConfig>({
    workingDirectory: '',
    accessMode: 'approval',
    platform: 'darwin',
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
  const { theme, setTheme, cycleTheme } = useTheme()
  const [modelResult, setModelResult] = useState<ModelDiscoveryResult>({
    models: defaultModels,
    source: 'none',
    stale: false,
  })
  const [selectedModel, setSelectedModel] = useState<string | undefined>()
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [pluginSkillSummaries, setPluginSkillSummaries] = useState<SkillSummary[]>([])

  // Merged skill list: filesystem + plugin skills (codex‑style @ palette).
  // Homonymous skills from different origins appear separately.
  const mentionableSkills = useMemo(
    () => skills.concat(pluginSkillSummaries),
    [skills, pluginSkillSummaries],
  )

  // Load plugin skills on mount; refresh on return from 'plugins' view.
  const prevActiveViewRef = useRef<AppView>('chat')
  const loadPluginSummaries = useCallback(() => {
    loadPluginSkillSummaries(
      () => window.verboo.pluginList(),
      (id) => window.verboo.pluginSkills(id),
    ).then(setPluginSkillSummaries).catch(() => setPluginSkillSummaries([]))
  }, [])
  useEffect(() => { loadPluginSummaries() }, [loadPluginSummaries])
  useEffect(() => {
    if (prevActiveViewRef.current === 'plugins' && activeView === 'chat') loadPluginSummaries()
    prevActiveViewRef.current = activeView
  }, [activeView, loadPluginSummaries])

  const [effortByModel, setEffortByModel] = useState<Record<string, string>>(
    () => readEffortByModel(),
  )
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot | undefined>(undefined)
  const [dismissedVersion, setDismissedVersion] = useState<string | undefined>(undefined)
  // Skills derived from / and @ tokens in the composer text. syncTokenSkills
  // (Composer) extracts both token types and sets this state. No parallel
  // chip state — user REJECTED chips (decided Feedback-3 ITEM 2a).
  const [tokenSkills, setTokenSkills] = useState<SkillSummary[]>([])
  const selectedSkillsUnion = tokenSkills
  const [attachedFiles, setAttachedFiles] = useState<AttachmentMeta[]>([])
  const [ocrProcessingPaths, setOcrProcessingPaths] = useState<string[]>([])
  // Refs keyed by image path, resolved when OCR completes or fails.
  // Used by sendMessage to await pending OCR before sending.
  const ocrCompletionsRef = useRef<Record<string, { resolve: () => void; promise: Promise<void> }>>({})
  const [accessMode, setAccessMode] = useState<AccessMode>('approval')
  const [chatStore, setChatStore] = useState<ChatStore>(readChatStore)
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(() => {
    return visibleConversations(readChatStore())[0]?.id
  })
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>()
  const [runningTurnId, setRunningTurnId] = useState<string | undefined>()
  const [runningConversations, setRunningConversations] = useState<Set<string>>(() => new Set())
  const [performanceWarningDismissed, setPerformanceWarningDismissed] = useState(false)
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedFollowUp[]>([])
  // Per-conversation composer drafts (in-memory). Survives chat switches and
  // settings navigation so each chat keeps its own composer text.
  const composerDrafts = useRef<Record<string, string>>({})
  const [composerValue, setComposerValue] = useState('')
  const prevConversationIdRef = useRef<string | undefined>(undefined)
  const [pendingPermissionPrompt, setPendingPermissionPrompt] = useState<PendingPermissionPrompt | undefined>()
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | undefined>()
  const [questionPrompt, setQuestionPrompt] = useState<QuestionPromptState | undefined>()
  const [questionWizardOpen, setQuestionWizardOpen] = useState(false)
  const questionPromptRef = useRef<QuestionPromptState | undefined>(undefined)

  // Vision fallback consent — deferred promise pattern like interject.
  // When set, the VisionFallbackModal is rendered as an overlay. The resolve
  // fn is called by the modal with the user's choice; awaiting code continues.
  const [visionFallbackState, setVisionFallbackState] = useState<VisionFallbackState | undefined>()
  const visionFallbackResolveRef = useRef<(value: { allowOnce: boolean } | { persist: VisionFallbackConsent }) => void>(undefined)

  // Skill approval — deferred promise pattern matching vision fallback.
  // Set when sendMessage encounters unapproved project-root skills.
  const [pendingSkillApproval, setPendingSkillApproval] = useState<SkillSummary[] | undefined>()
  const skillApprovalResolveRef = useRef<(value: { allowOnce: boolean } | { trust: string } | { cancel: true }) => void>(undefined)
  const turnQuestions = useRef<Record<string, ModelQuestion[]>>({})
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
  // Once the user closes the subagent panel, activity updates must not force
  // it back open — it only reopens by explicit click or on a fresh turn.
  const subagentPanelDismissed = useRef(false)
  const [subagentSummaryExpanded, setSubagentSummaryExpanded] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | undefined>()
  // Context windows the CLI itself reported via result.modelUsage — the Verboo
  // Router omits contextWindow from model discovery, so this is often the only
  // authoritative source. Persisted so the meter works from app launch.
  const [reportedContextWindows, setReportedContextWindows] = useState<Record<string, number>>(
    readReportedContextWindows,
  )
  const [goal, setGoal] = useState<GoalState | undefined>()
  const [imageReadingTurnId, setImageReadingTurnId] = useState<string | undefined>()
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(initialSidebarPreference.current.mode)
  // Transient peek: only meaningful when sidebarMode === 'hidden'. The rail
  // hit-area (rendered in App) calls setSidebarPeek(true) on hover/focus;
  // a leave timer clears it. Pin button persists expanded and clears peek.
  const [sidebarPeek, setSidebarPeek] = useState(false)
  // Leaving state: when true, the shell stays mounted with .is-peek-leaving so
  // the CSS fade-out (opacity 1→0 + translateX) is visible before unmount.
  // Without this, sidebarPeek=false unmounts the shell in the same frame and
  // the leave animation never plays.
  const [sidebarPeekLeaving, setSidebarPeekLeaving] = useState(false)
  const peekLeaveTimer = useRef<number | undefined>(undefined)
  const peekUnmountTimer = useRef<number | undefined>(undefined)
  // Suppress re-open: after the leave fade finishes and the shell unmounts,
  // the rail (8px hit-area on the left edge) mounts under the cursor. The
  // browser fires mouseenter on the rail → showSidebarPeek() → sidebar pops
  // back open. This ref blocks that re-open until the pointer actually leaves
  // the rail area (rail onMouseLeave clears it). Mid-leave re-enter via the
  // shell itself is NOT suppressed — only the post-unmount rail mouseenter.
  const peekSuppressUntilPointerLeft = useRef(false)
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarPreference.current.width)
  const [reviewMetadata, setReviewMetadata] = useState<WorkspaceReviewMetadata | undefined>()
  const [branchInfo, setBranchInfo] = useState<WorkspaceBranchInfo | undefined>()
  const [reviewUnavailableReason, setReviewUnavailableReason] = useState<string | undefined>()
  const terminal = useLocalTerminal()
  const review = useReviewPanel()
  const t = useMemo(() => createTranslator(userSettings.language), [userSettings.language])
  const [tokenRate, setTokenRate] = useState<TokenRateSnapshot | undefined>()
  const goalRef = useRef(goal)
  const [goalBarStatus, setGoalBarStatus] = useState<GoalStatusBarState>({ kind: 'idle' })
  const [emptyLineKey] = useState(() => EMPTY_LINE_KEYS[Math.floor(Math.random() * EMPTY_LINE_KEYS.length)])
  const workspaceRef = useRef<HTMLElement | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const autoScrollingRef = useRef(false)
  const scrollSettleTimer = useRef<number | undefined>(undefined)
  // Suppress stick-to-bottom autoscroll on user-initiated expand. The callback
  // is called from TurnView's toggleExpand before the state change. We set
  // stickToBottomRef to false and schedule a restore after the transition
  // completes — this prevents scrollToLatest/forceWorkspaceToBottom from
  // overriding the scroll-top restore that TurnView does in useLayoutEffect.
  const handleUserExpand = useCallback(() => {
    // Save the prior stick state so we can restore it after the expand
    // transition finishes. If the user expanded a message mid-history the
    // stick was already false; forcing it to true here would pull the next
    // streaming item back to the bottom against the user's intent.
    const prev = stickToBottomRef.current
    stickToBottomRef.current = false
    setTimeout(() => { stickToBottomRef.current = prev }, 400)
  }, [])
  const userSettingsRef = useRef(userSettings)
  const turnConversationIds = useRef<Record<string, string>>({})
  const turnModels = useRef<Record<string, { modelId?: string; modelDisplayName?: string }>>({})
  const pendingConversationId = useRef<string | undefined>(undefined)
  // Ref mirror of activeConversationId so the agent event handler (which has
  // a stale closure via useEffect []) can read the current value when a
  // turn completes — used to decide whether to fire a background notification.
  const activeConversationIdRef = useRef<string | undefined>(undefined)
  const goalSessionId = useRef<string | undefined>(undefined)
  const goalAbortRef = useRef<AbortController | undefined>(undefined)
  const queuedFollowUpsRef = useRef<QueuedFollowUp[]>([])
  const lastEscapeAt = useRef(0)
  const selectedContextWindowRef = useRef<number | undefined>(undefined)
  const turnStartedAt = useRef<Record<string, number>>({})
  const turnTokenRates = useRef<Record<string, TokenRateSample>>({})
  const turnLiveRates = useRef<Record<string, {
    samples: Array<{ at: number; chars: number }>
    charsSinceUsage: number
    tokensPerChar: number
    lastEmit: number
  }>>({})
  const turnActivityKeys = useRef<Record<string, Set<string>>>({})
  const turnActivityCounts = useRef<Record<string, Partial<Record<NonNullable<TranscriptItem['activityKind']>, number>>>>({})
  const turnResultSnapshots = useRef<Record<string, AgentResultSnapshot>>({})
  const turnTerminalErrors = useRef<Record<string, string[]>>({})
  const turnCompletionDeferred = useRef<{ turnId: string; resolve: () => void; reject: (reason: unknown) => void } | undefined>(undefined)
  // Resolves when a specific turn ends (done/error) — used by interjectMessage
  // to await the interrupted turn before sending the next message. Separate
  // from turnCompletionDeferred (used by goal scheduler) to avoid conflicts.
  const interjectDeferred = useRef<{ turnId: string; resolve: () => void } | undefined>(undefined)
  const turnThinkingText = useRef<Record<string, string>>({})
  const turnThinkingSnippets = useRef<Record<string, string[]>>({})
  const [thinkingSnippets, setThinkingSnippets] = useState<string[]>([])
  const turnAssistantText = useRef<Record<string, string>>({})
  const turnLastCommand = useRef<Record<string, string>>({})
  const turnCommands = useRef<Record<string, string[]>>({})
  const turnReferences = useRef<Record<string, string[]>>({})
  const turnChangeBaselines = useRef<Record<string, WorkspaceChangeSummary | undefined>>({})
  const turnWorkingDirectories = useRef<Record<string, string>>({})
  const turnTouchedFiles = useRef<Record<string, Set<string>>>({})
  /** One-shot recovery when CLI rejects a stale --resume session id. */
  const turnRetryPayload = useRef<Record<string, {
    conversationId: string
    message: string
    alreadyRetriedWithoutSession: boolean
  }>>({})
  const activeSubagentsRef = useRef<Record<string, ActiveSubagent>>({})
  const pendingResearchSubagentsRef = useRef<ActiveSubagent[]>([])
  const autoApprovalSent = useRef<Set<string>>(new Set())
  const turnOpenTextSegment = useRef<Record<string, string | undefined>>({})
  const turnTextSegmentCount = useRef<Record<string, number>>({})
  const turnCommandItemIds = useRef<Record<string, Record<string, string>>>({})
  // tool_use_id → activity itemId, for ALL activity kinds (read/edit/search/etc).
  // Commands go into turnCommandItemIds (legacy); this map covers the rest so
  // extractToolResults can attach real output to their activity rows.
  const turnToolUseItemIds = useRef<Record<string, Record<string, string>>>({})
  const turnSubagentToolIds = useRef<Record<string, Record<string, string>>>({})
  const [thinkingTurnId, setThinkingTurnId] = useState<string | undefined>(undefined)
  const [compactingTurnId, setCompactingTurnId] = useState<string | undefined>(undefined)
  const [compactedTurnIds, setCompactedTurnIds] = useState<Set<string>>(new Set())
  // After compacting, skip the local transcript estimate for 15s so the meter
  // doesn't show inflated % (pre-compact messages are still in the local array).
  // Once the CLI reports real usage (via agent:event), this becomes irrelevant.
  const skipContextEstimateUntil = useRef(0)
  // Conversations currently auto-recovering from a context overflow (see the
  // 'error' handler). Guards against an infinite compact→overflow→compact loop.
  const overflowRecovering = useRef<Set<string>>(new Set())
  const authRecovering = useRef<Set<string>>(new Set())
  // Latest menu-bar state, re-pushed on a heartbeat so the tray never sticks
  // (async updateMenuBar invokes can arrive out of order — a lagging
  // 'thinking' landing after the 'idle' would freeze the menubar counter).
  const menuBarStateRef = useRef<Partial<MenuBarState>>({})

  const activeConversation = useMemo(
    () => chatStore.conversations.find(conversation => conversation.id === activeConversationId),
    [chatStore.conversations, activeConversationId],
  )
  // activeProject resolves the project that owns the current conversation.
  // Only fall back to selectedProjectId when there is NO active conversation —
  // otherwise, a chat without a project would inherit the previously-selected
  // project, causing the sidebar to highlight both the chat and an unrelated
  // project simultaneously, and the transcript pill to show the wrong name.
  const activeProject = activeConversation?.projectId
    ? chatStore.projects.find(project => project.id === activeConversation.projectId)
    : !activeConversation && selectedProjectId
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
  // When peeking (hidden + hover), the sidebar column expands visually to
  // the user's last expanded width — but the persisted mode stays 'hidden'.
  // During the leave fade (sidebarPeekLeaving), the column collapses to 0
  // immediately (grid transition) while the shell floats (position:absolute)
  // to fade out on top. Expanding the grid ONLY when peek && !leaving avoids
  // the "ghost column" — an empty full-width column that appeared because the
  // grid stayed expanded while the shell had already faded.
  const sidebarVisualMode = sidebarMode === 'hidden' && sidebarPeek && !sidebarPeekLeaving ? 'expanded' : sidebarMode
  // Fullscreen views (Profile / Settings) don't render the sidebar at all —
  // collapse the column to 0 so the workspace takes the full grid width.
  const isFullscreenView = activeView === 'settings' || activeView === 'profile'
  const effectiveSidebarWidth = isFullscreenView
    ? 0
    : sidebarVisualMode === 'hidden'
      ? 0
      : sidebarVisualMode === 'compact'
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
    // Peek width is frozen at the user's sidebarWidth and used by the shell
    // during both enter and leave. This is critical for leave: when peek
    // flips false, --sidebar-width goes to 0 (grid collapses), but the shell
    // (position:absolute) must keep its own width or .app-sidebar grows to
    // content width → ghost expand with untruncated project names.
    '--sidebar-peek-width': `${sidebarMode === 'hidden' && (sidebarPeek || sidebarPeekLeaving) ? sidebarWidth : 0}px`,
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
    const hasResearchSubagents = activeSubagents.some(agent => agent.id.startsWith('research:'))
    if (runningTurnId || workingSubagents.length > 0 || hasResearchSubagents) return
    setSelectedSubagentId(undefined)
    setSubagentSummaryExpanded(false)
  }, [activeSubagents, runningTurnId, workingSubagents.length])

  useEffect(() => {
    let cancelled = false

    async function loadStartupState() {
      const [settings, nextConfig, defaultWDSettings] = await Promise.all([
        window.verboo.getUserSettings(),
        window.verboo.getConfig(),
        window.verboo.getDefaultWorkingDirectory().then(wd => { defaultWorkingDirectoryRef.current = wd; return wd }),
      ])
      if (cancelled) return
      // Merge locally-persisted avatar (the Rust backend may not have it yet).
      try {
        const ls = localStorage.getItem('verboo:avatar-settings')
        if (ls) settings.avatar = JSON.parse(ls)
      } catch { /* ignore parse errors */ }
      // Coalesce new fields for older settings.json payloads.
      setUserSettings({
        ...DEFAULT_USER_SETTINGS,
        ...settings,
        includeVerbooCoAuthor: settings.includeVerbooCoAuthor ?? false,
        loadWebIcons: settings.loadWebIcons ?? true,
      })
      // Reasoning effort prefs: backend is the durable source. When the
      // backend already has prefs, use them and drop localStorage. When the
      // backend is empty but localStorage has prefs (user set them before
      // backend support landed), hydrate from localStorage and kick off a
      // one-time migration to the backend.
      const effortMigration = migrateEffortPrefs(settings.effortByModel, readEffortByModel())
      setEffortByModel(effortMigration.prefs)
      if (effortMigration.migrate) {
        void updateUserSettings({ effortByModel: effortMigration.migrate })
          .then(() => {
            try { window.localStorage.removeItem(EFFORT_BY_MODEL_KEY) } catch { /* noop */ }
          })
      } else if (effortMigration.prefs && Object.keys(effortMigration.prefs).length > 0) {
        // Backend already has prefs — localStorage is stale, drop it.
        try { window.localStorage.removeItem(EFFORT_BY_MODEL_KEY) } catch { /* noop */ }
      }
      setSelectedModel(settings.lastSelectedModelId)
      setAccessMode(settings.defaultAccessMode)
      setConfig(nextConfig)
      setAccessMode(nextConfig.accessMode)
      document.documentElement.dataset.platform = nextConfig.platform
      if (settings.staySignedIn && readRememberedAuthSession()) {
        setEntryUnlocked(true)
      }
      void (async () => {
        const ok = await validateAccess(!settings.staySignedIn, settings.staySignedIn)
        // Cold-start hardening (B1): on a fresh launch the first keychain read
        // / CLI-token refresh can lose a race and report "no session". Retry
        // once with a forced refresh before leaving the user on the login
        // screen. validateAccess already no-ops the UI if it succeeds.
        if (!ok && !cancelled) {
          await new Promise(resolve => setTimeout(resolve, 700))
          if (!cancelled) await validateAccess(true, settings.staySignedIn)
        }
      })()
    }

    void loadStartupState()
    return () => {
      cancelled = true
    }
  }, [])

  // Notification click → focus conversation. Wired once at mount. The
  // backend emits "notification-clicked" with conversationId when the
  // user clicks an OS notification — currently a TODO for Geralt's
  // notification_service.rs. Until then the handler exists but the event
  // never fires.
  useEffect(() => {
    const unlisten = (window.verboo as any).listenForNotificationClick?.((conversationId: string) => {
      setActiveConversationId(conversationId)
      setActiveView('chat')
    })
    return () => { unlisten?.then((fn: () => void) => fn()) }
  }, [])

  useEffect(() => {
    saveSidebarPreference({ mode: sidebarMode, width: sidebarWidth })
  }, [sidebarMode, sidebarWidth])

  // Clear any pending peek-leave timer on unmount so it can't fire after the
  // component is gone (would be a no-op setState, but cleaner).
  useEffect(() => {
    return () => {
      if (peekLeaveTimer.current !== undefined) window.clearTimeout(peekLeaveTimer.current)
    }
  }, [])

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
    let mounted = true
    void window.verboo.getUpdateStatus().then(snapshot => {
      if (mounted) setUpdateSnapshot(snapshot)
    })
    const unsubscribe = window.verboo.onUpdateStatus(snapshot => {
      setUpdateSnapshot(snapshot)
      if (snapshot.status === 'downloaded') {
        toast(t('updates.readyToast'))
      }
      // Errors surface inside Settings > Updates only — raw updater failures
      // (e.g. background checks on dev builds) as toasts were pure noise.
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [t, toast])

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
    // ESC closes settings, profile, and plugins fullscreen views. Earlier this
    // only handled settings, so profile/plugins had no keyboard escape — users
    // had to click the back button. Now all three views respond to ESC.
    if (activeView !== 'settings' && activeView !== 'profile' && activeView !== 'plugins') return undefined

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
    ?? (selectedModel ? reportedContextWindows[selectedModel] : undefined)
  const selectedContextWindow = selectedModelInfo?.contextWindow
    ?? (selectedModel ? reportedContextWindows[selectedModel] : undefined)

  // ── Reasoning effort ──────────────────────────────────────────
  const selectedModelReasoning = selectedModelInfo ? getModelReasoning(selectedModelInfo) : undefined
  const selectedEffortLevels = selectedModelReasoning?.effortLevels ?? []
  /** Wire value: only set when the user has a saved, still-valid preference
   *  (i.e. the saved level is in the model's current `effortLevels`).
   *  Never falls back to defaultEffort — when no preference is set, the
   *  backend applies its own default. Preserves `"none"` when the model
   *  offers it as a deliberate level (it is NOT coerced to undefined). */
  const validEffortOverride = validOverride(effortByModel, selectedModel, selectedModelReasoning)
  /** UI value: same rule as `validEffortOverride`, but falls back to the
   *  model's `defaultEffort` so the pill always renders a meaningful level. */
  const displayEffortValue = displayEffort(effortByModel, selectedModel, selectedModelReasoning)

  useEffect(() => {
    selectedContextWindowRef.current = selectedContextWindow
  }, [selectedContextWindow])

  // The Verboo Router reports all-zero usage on every event, so real
  // cli-usage snapshots never arrive. Fall back to the same local estimate
  // the ContextPanel breakdown uses so the meter shows a live percentage.
  const estimatedContextUsage = useMemo<ContextUsageSnapshot | undefined>(() => {
    if (!selectedContextWindow) return undefined
    const usedTokens = estimateTotalContextTokens(items, attachedFiles, selectedSkillsUnion, queuedFollowUps)
    return {
      usedTokens,
      maxTokens: selectedContextWindow,
      percentage: Math.min(1, usedTokens / selectedContextWindow),
      source: 'estimated',
      updatedAt: Date.now(),
    }
  }, [items, attachedFiles, selectedSkillsUnion, queuedFollowUps, selectedContextWindow])
  const effectiveContextUsage = contextUsage ?? (Date.now() < skipContextEstimateUntil.current ? undefined : estimatedContextUsage)

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
        // Pass activeConversationId so only the active chat stops (Bug 4).
        // Guard: when activeConversationId is undefined (new chat with no
        // active session), interrupt(undefined) would stop ALL sessions.
        if (activeConversationId) {
          void window.verboo.interrupt(activeConversationId)
        }
        // User ESC×2 is deliberate: dismiss the question wizard entirely
        // (not just minimize). The auto-interrupt from presentTurnQuestions
        // (line ~2251) does NOT go through this handler — that path must
        // keep the wizard open for AskUserQuestion flow.
        questionPromptRef.current = undefined
        setQuestionPrompt(undefined)
        setQuestionWizardOpen(false)
        return
      }
      lastEscapeAt.current = now
    }

    window.addEventListener('keydown', handleEscapeInterrupt, { capture: true })
    return () => window.removeEventListener('keydown', handleEscapeInterrupt, { capture: true })
  }, [runningTurnId, activeConversationId])

  // Save the outgoing conversation's composer draft and restore the incoming
  // conversation's draft whenever the active conversation changes. Uses a
  // sentinel key for the "new chat" state (activeConversationId === undefined)
  // so drafts are preserved when switching between unsaved new chats and
  // existing conversations, and only writes composerValue when the key
  // actually changes (avoids clearing the composer on unrelated re-renders).
  useEffect(() => {
    const NEW_CHAT_KEY = '__new__'
    const previousKey = prevConversationIdRef.current ?? NEW_CHAT_KEY
    const nextKey = activeConversationId ?? NEW_CHAT_KEY
    if (previousKey !== nextKey) {
      composerDrafts.current[previousKey] = composerValue
      setComposerValue(composerDrafts.current[nextKey] ?? '')
      setTokenSkills([])
    }
    prevConversationIdRef.current = activeConversationId
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    setContextUsage(undefined)
  }, [activeConversationId, selectedContextWindow, selectedModel])

  // Hydrate goal state when the active conversation changes (covers initial
  // load, sidebar selection, and notification-click focus). Mirrors the
  // hydration in selectConversation but lives in an effect so it fires on
  // every activeConversationId transition, including the initial mount.
  useEffect(() => {
    if (!activeConversationId) {
      setGoal(undefined)
      goalRef.current = undefined
      setGoalBarStatus({ kind: 'idle' })
      return
    }
    const conversation = chatStore.conversations.find(item => item.id === activeConversationId)
    const storedGoal = conversation?.goal
    if (storedGoal && (storedGoal.status === 'active' || storedGoal.status === 'paused' || storedGoal.status === 'evaluating' || storedGoal.status === 'continuing')) {
      // Active goals are restored as paused — the user must explicitly
      // resume to restart the autonomous cycle. Prevents surprise execution
      // on app launch or conversation switch.
      const restored: GoalState = storedGoal.status === 'paused'
        ? storedGoal
        : { ...storedGoal, status: 'paused', pausedAt: storedGoal.pausedAt ?? Date.now() }
      setGoal(restored)
      goalRef.current = restored
      setGoalBarStatus({
        kind: 'stopped',
        objective: restored.objective,
        reason: restored.pauseReason ?? 'paused',
      })
    } else {
      setGoal(undefined)
      goalRef.current = undefined
      setGoalBarStatus({ kind: 'idle' })
    }
  }, [activeConversationId, chatStore.conversations])

  async function refreshModels(forceRefresh: boolean): Promise<ModelDiscoveryResult> {
    const result = await window.verboo.listModels(forceRefresh)
    setModelResult(result)
    setSelectedModel(current => {
      return resolveSelectedModel(result.models, current, userSettingsRef.current.lastSelectedModelId)
    })
    return result
  }

  function toggleSidebarVisibility() {
    if (peekLeaveTimer.current !== undefined) {
      window.clearTimeout(peekLeaveTimer.current)
      peekLeaveTimer.current = undefined
    }
    if (peekUnmountTimer.current !== undefined) {
      window.clearTimeout(peekUnmountTimer.current)
      peekUnmountTimer.current = undefined
    }
    peekSuppressUntilPointerLeft.current = false
    setSidebarPeekLeaving(false)
    setSidebarMode(current => current === 'hidden' ? 'expanded' : 'hidden')
    setSidebarPeek(false)
  }

  function toggleSidebarCompact() {
    if (peekLeaveTimer.current !== undefined) {
      window.clearTimeout(peekLeaveTimer.current)
      peekLeaveTimer.current = undefined
    }
    if (peekUnmountTimer.current !== undefined) {
      window.clearTimeout(peekUnmountTimer.current)
      peekUnmountTimer.current = undefined
    }
    peekSuppressUntilPointerLeft.current = false
    setSidebarPeekLeaving(false)
    setSidebarMode(current => current === 'compact' ? 'expanded' : 'compact')
    setSidebarPeek(false)
  }

  // Rail hover/focus → peek open. Clears any pending leave timer AND any
  // pending unmount so a re-enter during the leave fade cancels the close
  // (the sidebar slides back in instead of vanishing mid-fade).
  function showSidebarPeek() {
    if (sidebarMode !== 'hidden') return
    // Suppress: if the cursor never left the rail area after the last leave
    // finished, don't re-open. This blocks the rail mouseenter that fires
    // when the shell unmounts under the cursor. Cleared by rail onMouseLeave.
    if (peekSuppressUntilPointerLeft.current) return
    if (peekLeaveTimer.current !== undefined) {
      window.clearTimeout(peekLeaveTimer.current)
      peekLeaveTimer.current = undefined
    }
    if (peekUnmountTimer.current !== undefined) {
      window.clearTimeout(peekUnmountTimer.current)
      peekUnmountTimer.current = undefined
    }
    if (sidebarPeekLeaving) setSidebarPeekLeaving(false)
    setSidebarPeek(true)
  }

  // Rail/sidebar leave → schedule peek close after a short delay. The delay
  // tolerates the pointer crossing the gap between rail and sidebar. When the
  // delay fires, we flip to the leaving phase in a SINGLE tick:
  //   setSidebarPeek(false) + setSidebarPeekLeaving(true)
  // This is critical — if peek stays true while leaving is true, the shell
  // gets BOTH .is-peek and .is-peek-leaving classes and the enter+leave
  // animations play simultaneously → flicker. Mutually exclusive state means
  // the shell gets exactly one class: is-peek (enter) OR is-peek-leaving (leave).
  // The grid column collapses immediately (sidebarVisualMode sees peek=false)
  // while the shell floats (position:absolute) to fade out on top.
  function scheduleHideSidebarPeek() {
    if (sidebarMode !== 'hidden') return
    if (peekLeaveTimer.current !== undefined) window.clearTimeout(peekLeaveTimer.current)
    peekLeaveTimer.current = window.setTimeout(() => {
      peekLeaveTimer.current = undefined
      // Single-tick transition to leave phase. peek=false → grid collapses
      // (220ms transition) + shell gets .is-peek-leaving only (fade 220ms).
      setSidebarPeek(false)
      setSidebarPeekLeaving(true)
      // After the leave animation, unmount the shell. peek is already false;
      // we only clear leaving here. We also arm the suppress flag: the shell
      // unmounting means the rail (8px left edge) now sits under the cursor,
      // and the browser will fire mouseenter on it → showSidebarPeek would
      // re-open. Suppress blocks that until the pointer actually leaves the
      // rail (rail onMouseLeave clears it).
      peekUnmountTimer.current = window.setTimeout(() => {
        peekUnmountTimer.current = undefined
        setSidebarPeekLeaving(false)
        peekSuppressUntilPointerLeft.current = true
      }, SIDEBAR_PEEK_LEAVE_ANIM_MS)
    }, SIDEBAR_PEEK_LEAVE_DELAY_MS)
  }

  // Pin = persist expanded. Clears peek so the visual state transitions
  // cleanly to the persisted expanded mode.
  function pinSidebar() {
    if (peekLeaveTimer.current !== undefined) {
      window.clearTimeout(peekLeaveTimer.current)
      peekLeaveTimer.current = undefined
    }
    if (peekUnmountTimer.current !== undefined) {
      window.clearTimeout(peekUnmountTimer.current)
      peekUnmountTimer.current = undefined
    }
    peekSuppressUntilPointerLeft.current = false
    setSidebarPeekLeaving(false)
    setSidebarMode('expanded')
    setSidebarPeek(false)
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

  async function updateUserSettings(patch: Partial<UserSettings>) {
    // Persist avatar locally as fallback (the Rust backend may not have the
    // AvatarSettings field yet — note: coordinate with Ezio).
    if (patch.avatar) {
      try { localStorage.setItem('verboo:avatar-settings', JSON.stringify(patch.avatar)) } catch { /* quota */ }
    }
    const next = await window.verboo.updateUserSettings(patch)
    // Merge locally-persisted avatar back if the backend dropped it.
    if (!next.avatar && patch.avatar) next.avatar = patch.avatar
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

  function handleEffortSelect(modelId: string, effort: string) {
    // Optimistic update + durable persist. Rollback on backend failure so the
    // UI never drifts from what's actually saved. localStorage is migration-
    // only (see loadStartupState) — we do NOT mirror every change there.
    const prev = effortByModel
    const next = { ...prev, [modelId]: effort }
    setEffortByModel(next)
    // If the user picked effort for a model that isn't currently selected,
    // select it too — otherwise the preference silently applies to the
    // wrong model.
    if (modelId !== selectedModel) handleModelSelect(modelId)
    void updateUserSettings({ effortByModel: next }).catch(() => {
      setEffortByModel(prev)
    })
  }

  function handleClearEffortOverride(modelId: string) {
    if (!(modelId in effortByModel)) return
    const prev = effortByModel
    const next = { ...prev }
    delete next[modelId]
    setEffortByModel(next)
    void updateUserSettings({ effortByModel: next }).catch(() => {
      setEffortByModel(prev)
    })
  }

  async function updateStaySignedIn(staySignedIn: boolean) {
    await updateUserSettings({ staySignedIn })
  }

  async function resetUserSettings() {
    const next = await window.verboo.resetUserSettings()
    setUserSettings(next)
    setAccessMode(next.defaultAccessMode)
    try { window.localStorage.removeItem(EFFORT_BY_MODEL_KEY) } catch { /* noop */ }
    setEffortByModel({})
  }

  async function onCheckForUpdates(userInitiated = true) {
    return window.verboo.checkForUpdates(userInitiated)
  }

  async function onDownloadUpdate() {
    return window.verboo.downloadUpdate()
  }

  async function onInstallUpdate() {
    await window.verboo.installUpdate()
  }

  function beginTokenRateTracking(turnId: string) {
    const now = Date.now()
    // requestCount starts at 0 so RPM doesn't show a phantom "1 request" on
    // the first sample. RPM stays 0 during the first turn (no prior output to
    // compare for resetSample detection) and becomes meaningful once a second
    // request starts and output tokens reset.
    turnTokenRates.current[turnId] = { firstAt: now, lastAt: now, lastOutputTokens: 0, requestCount: 0 }
    setTokenRate(undefined)
  }

  // Real usage only arrives ONCE per request (in the final message_delta), so
  // a usage-driven meter reads "--" during generation. Live tk/s comes from
  // counting streamed text/thinking deltas (chars → tokens) over a sliding
  // window, calibrated against the real token count whenever usage lands.
  // Capture thinking_delta text from stream_event payloads, accumulated per-turn
  // and split into sentence-boundary snippets for the real-time rotating display.
  function collectThinkingText(turnId: string, payload: unknown): void {
    if (!isRecord(payload) || payload.type !== 'stream_event' || !isRecord(payload.event)) return
    const delta = isRecord(payload.event.delta) ? payload.event.delta : undefined
    if (!delta || delta.type !== 'thinking_delta' || typeof delta.thinking !== 'string') return
    const text = delta.thinking
    const accumulated = (turnThinkingText.current[turnId] ?? '') + text
    turnThinkingText.current[turnId] = accumulated
    // Split by sentence boundaries, then group into pairs so each snippet
    // is at least 2 sentences — fewer, meatier chunks the user can actually
    // read before the timer rotates to the next one.
    const sentences = accumulated
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
    const pairs: string[] = []
    for (let i = 0; i < sentences.length; i += 2) {
      const pair = [sentences[i], sentences[i + 1]].filter(Boolean).join(' ')
      if (pair.length > 4) pairs.push(pair)
    }
    turnThinkingSnippets.current[turnId] = pairs
    setThinkingSnippets([...pairs])
  }

  function trackLiveTokenRate(turnId: string, payload: unknown) {
    const text = streamDeltaText(payload)
    if (!text) return
    const now = Date.now()
    const state = (turnLiveRates.current[turnId] ??= {
      samples: [],
      charsSinceUsage: 0,
      // Measured against real usage on captured streams (all delta kinds
      // counted): ~0.31 tokens/char; per-request calibration refines it live.
      tokensPerChar: 0.31,
      lastEmit: 0,
    })
    state.samples.push({ at: now, chars: text.length })
    state.charsSinceUsage += text.length
    const cutoff = now - 4000
    while (state.samples.length > 0 && state.samples[0].at < cutoff) state.samples.shift()

    // Throttle renders; the meter does not need more than ~3 updates/second.
    if (now - state.lastEmit < 320 || state.samples.length < 2) return
    state.lastEmit = now
    const windowChars = state.samples.reduce((sum, sample) => sum + sample.chars, 0)
    const windowSeconds = Math.max(0.4, (now - state.samples[0].at) / 1000)
    const tokensPerSecond = (windowChars * state.tokensPerChar) / windowSeconds
    setTokenRate(previous => ({
      outputTokens: previous?.outputTokens ?? 0,
      totalTokens: previous?.totalTokens ?? 0,
      tokensPerSecond,
      requestsPerMinute: previous?.requestsPerMinute,
      source: 'cli-usage',
      updatedAt: now,
    }))
  }

  function updateTokenRateFromPayload(turnId: string, payload: unknown) {
    const usage = extractTokenUsage(payload)
    if (!usage) return

    // Calibrate the live chars→tokens estimate with the request's real count.
    const liveState = turnLiveRates.current[turnId]
    if (liveState && liveState.charsSinceUsage > 80 && usage.output_tokens) {
      const measured = usage.output_tokens / liveState.charsSinceUsage
      if (Number.isFinite(measured)) {
        liveState.tokensPerChar = Math.min(0.6, Math.max(0.1, measured))
      }
      liveState.charsSinceUsage = 0
    }

    const inputTokens = usage.input_tokens ?? 0
    const outputTokens = usage.output_tokens ?? 0
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0
    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
    if (totalTokens <= 0) return

    const now = Date.now()
    const sample = turnTokenRates.current[turnId] ?? {
      firstAt: turnStartedAt.current[turnId] ?? now,
      lastAt: turnStartedAt.current[turnId] ?? now,
      lastOutputTokens: 0,
      requestCount: 0,
    }
    const resetSample = outputTokens < sample.lastOutputTokens
    const nextRequestCount = resetSample ? sample.requestCount + 1 : Math.max(0, sample.requestCount)
    const requestWindowStart = sample.firstAt
    const elapsedMinutes = Math.max((now - requestWindowStart) / 60000, 1 / 60)
    const requestsPerMinute = nextRequestCount / elapsedMinutes
    const deltaTokens = resetSample ? 0 : outputTokens - sample.lastOutputTokens
    const elapsedSeconds = Math.max(0, (now - sample.lastAt) / 1000)
    const shouldUpdateRate = deltaTokens > 0 && elapsedSeconds >= 0.15
    let tokensPerSecond = resetSample ? undefined : sample.smoothedRate

    if (shouldUpdateRate) {
      const instantRate = deltaTokens / elapsedSeconds
      tokensPerSecond = sample.smoothedRate === undefined
        ? instantRate
        : (sample.smoothedRate * 0.68) + (instantRate * 0.32)
    }

    turnTokenRates.current[turnId] = {
      firstAt: requestWindowStart,
      lastAt: shouldUpdateRate || resetSample ? now : sample.lastAt,
      lastOutputTokens: shouldUpdateRate || resetSample ? outputTokens : sample.lastOutputTokens,
      smoothedRate: tokensPerSecond,
      requestCount: nextRequestCount,
      requestsPerMinute,
    }

    setTokenRate({
      outputTokens,
      totalTokens,
      tokensPerSecond,
      requestsPerMinute,
      source: 'cli-usage',
      updatedAt: now,
    })
  }

  async function handleAgentEvent(event: AgentEvent) {
    if (event.type === 'subagent-progress') {
      updateResearchSubagentProgress(event.progress)
      return
    }

    if (event.type === 'started') {
      const conversationId = turnConversationIds.current[event.turnId] ?? pendingConversationId.current
      if (conversationId) turnConversationIds.current[event.turnId] = conversationId
      turnStartedAt.current[event.turnId] = Date.now()
      beginTokenRateTracking(event.turnId)
      subagentPanelDismissed.current = false
      turnActivityKeys.current[event.turnId] ??= new Set()
      turnActivityCounts.current[event.turnId] ??= {}
      turnTerminalErrors.current[event.turnId] = []
      turnCommands.current[event.turnId] = []
      turnReferences.current[event.turnId] = []
      const hasResearchSubagents = Object.keys(activeSubagentsRef.current).some(id => id.startsWith('research:'))
      if (pendingResearchSubagentsRef.current.length > 0) {
        attachPendingResearchSubagents(event.turnId)
      } else if (!hasResearchSubagents && !Object.keys(activeSubagentsRef.current).some(id => id.startsWith(`${event.turnId}:`))) {
        activeSubagentsRef.current = {}
        setActiveSubagents([])
      }
      setRunningTurnId(event.turnId)
      setThinkingTurnId(event.turnId)
      if (conversationId) {
        setRunningConversations(prev => new Set(prev).add(conversationId))
        appendAssistantPlaceholder(conversationId, event.turnId)
      }
      return
    }

    if (event.type === 'stdout') {
      const conversationId = turnConversationIds.current[event.turnId]
      setThinkingTurnId(current => (current === event.turnId ? undefined : current))
      setThinkingSnippets([])
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
      // Always signal image-reading UI when a kind=image activity arrives,
      // regardless of whether conversationId is already known (Geralt emits
      // started → turnConversationIds populated → then kind=image).
      if (event.runtimeActivity?.kind === 'image') {
        setImageReadingTurnId(event.turnId)
      }
      if (!conversationId && event.runtimeActivity?.kind === 'image') {
        const pendingId = pendingConversationId.current
        if (pendingId) {
          conversationId = pendingId
          turnConversationIds.current[event.turnId] = conversationId
          turnStartedAt.current[event.turnId] = Date.now()
          beginTokenRateTracking(event.turnId)
          setRunningTurnId(event.turnId)
          setThinkingTurnId(event.turnId)
        }
      }
      trackLiveTokenRate(event.turnId, event.payload)
      updateTokenRateFromPayload(event.turnId, event.payload)
      // Capture thinking_delta text for real-time rotating snippet display
      collectThinkingText(event.turnId, event.payload)
      routeSubagentChildEvent(event.turnId, event.payload)
      collectModelQuestions(event.turnId, event.payload)
      const reportedWindows = extractReportedContextWindows(event.payload)
      if (reportedWindows) {
        setReportedContextWindows(current => {
          const changed = Object.entries(reportedWindows).some(([model, win]) => current[model] !== win)
          if (!changed) return current
          const next = { ...current, ...reportedWindows }
          persistReportedContextWindows(next)
          return next
        })
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
      if (activity && activity.kind !== 'thinking' && activity.kind !== 'compacting') {
        setPetActivity({ kind: activity.kind, label: `${activity.label} ${activity.detail ?? ''}` })
      }
      if (activity?.kind === 'compacting') {
        // detail==='done' signals compaction completed (Geralt's event).
        if (activity.detail === 'done') {
          setCompactingTurnId(current => (current === event.turnId ? undefined : current))
          setCompactedTurnIds(prev => { const next = new Set(prev); next.add(event.turnId); return next })
        } else {
          setCompactingTurnId(event.turnId)
        }
        return
      }
      // Do NOT clear compactingTurnId here — it stays until the turn
      // completes (done/error handler), ensuring the user sees the
      // compaction marker long enough even if follow-up activities race in.
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
          const commandItemId = turnCommandItemIds.current[event.turnId]?.[result.toolUseId]
          if (commandItemId) {
            updateActivityCommand(conversationId, commandItemId, result.output, result.isError ? 'failure' : 'success')
          } else {
            // Non-command activity (Read/Edit/Search/etc): attach the real
            // tool_result output so the collapsible ActionRow can show it.
            const toolItemId = turnToolUseItemIds.current[event.turnId]?.[result.toolUseId]
            if (toolItemId) {
              updateActivityToolOutput(conversationId, toolItemId, result.output, result.isError)
            }
          }
          updateSubagentResult(event.turnId, result)
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
      // Stable sidebar ordering: bump lastTurnEndedAt when the turn result
      // arrives (streaming tokens alone no longer reshuffle the sidebar).
      if (conversationId) {
        updateConversation(conversationId, c => ({ ...c, lastTurnEndedAt: Date.now() }))
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
      const failure = event.payload
      if (conversationId && failure?.sessionId) {
        goalSessionId.current = failure.sessionId
        updateConversationSession(conversationId, failure.sessionId)
      }

      const lowerMessage = event.message.toLowerCase()
      const isContextOverflow =
        failure?.category === 'context_overflow'
        || lowerMessage.includes('too many tokens')
        || lowerMessage.includes('max_tokens')
        || lowerMessage.includes('prompt is too long')
        || lowerMessage.includes('token limit')
        || lowerMessage.includes('max length')
        || (lowerMessage.includes('context')
          && (lowerMessage.includes('exceed')
            || lowerMessage.includes('too long')
            || lowerMessage.includes('maximum')
            || lowerMessage.includes('window')
            || lowerMessage.includes('limit exceeded')
            || lowerMessage.includes('overflow')
            || lowerMessage.includes('too large')))
        || /rate limit.*token/i.test(lowerMessage)
        || /token.*rate.*limit/i.test(lowerMessage)
      const authFailure = isAuthenticationFailure(failure, event.message)
      const willRecoverAuth = Boolean(
        conversationId
        && shouldAutoRecoverAuthentication(
          failure,
          authRecovering.current.has(conversationId),
        ),
      )
      const willRecoverContext = Boolean(
        conversationId
        && !authFailure
        && isContextOverflow
        && !overflowRecovering.current.has(conversationId),
      )
      const retryMeta = turnRetryPayload.current[event.turnId]
      const sessionGone = /no conversation found with session/i.test(event.message)
        || (/session id[:\s]/i.test(event.message) && /not found|não encontrad/i.test(event.message))
      const willRetrySession = Boolean(
        conversationId
        && !willRecoverAuth
        && !willRecoverContext
        && sessionGone
        && retryMeta
        && !retryMeta.alreadyRetriedWithoutSession
        && retryMeta.message.trim(),
      )
      const willContinueAutomatically = willRecoverAuth || willRecoverContext || willRetrySession

      // Bump lastTurnEndedAt on error too — a turn concluded even when it
      // errored, and the sidebar should reflect the updated order.
      if (conversationId) {
        updateConversation(conversationId, c => ({ ...c, lastTurnEndedAt: Date.now() }))
      }
      setRunningTurnId(undefined)
      setRunningConversations(prev => { const next = new Set(prev); next.delete(conversationId); return next })
      setTokenRate(undefined)
      // Force the tray to idle so a lagging 'thinking' event can never
      // resurrect the timer after the turn has errored out.
      void window.verboo.forceIdleMenuBar()
      setThinkingTurnId(current => (current === event.turnId ? undefined : current))
      setThinkingSnippets([])
      setCompactingTurnId(current => (current === event.turnId ? undefined : current))
      setImageReadingTurnId(current => (current === event.turnId ? undefined : current))
      clearActiveSubagentsForTurn(event.turnId)
      if (!willContinueAutomatically) flashPet('error')
      // A transparently recovered failure is not a completed error from the
      // user's perspective, so only notify when it will actually surface.
      if (conversationId && !willContinueAutomatically) {
        const isActive = conversationId === activeConversationIdRef.current
        void window.verboo.fireCompletionNotification(
          1,
          conversationId,
          isActive,
        )
      }
      // Persist accumulated thinking text BEFORE cleanup so it survives
      // the turn end and is available to groupTurnBlocks. The live ref
      // is intentionally NOT cleared (data contract).
      if (conversationId) commitTurnThinking(conversationId, event.turnId)

      const completionDeferred = turnCompletionDeferred.current?.turnId === event.turnId
        ? turnCompletionDeferred.current
        : undefined
      // Keep a goal turn pending across transparent recovery; the replacement
      // turn will take ownership of the same deferred below.
      if (completionDeferred && !willContinueAutomatically) {
        completionDeferred.reject(new Error(event.message))
        turnCompletionDeferred.current = undefined
      }
      if (interjectDeferred.current?.turnId === event.turnId) {
        interjectDeferred.current.resolve()
        interjectDeferred.current = undefined
      }

      if (conversationId) {
        if (willRecoverAuth) {
          authRecovering.current.add(conversationId)
          appendActivityItem(conversationId, event.turnId, {
            key: `auth-recovery:${event.turnId}`,
            label: t('auth.recoveryActivity'),
            detail: t('auth.recoveryDetail'),
            kind: 'terminal',
          })
        } else if (authFailure) {
          authRecovering.current.delete(conversationId)
        }

        if (willRecoverContext) {
          overflowRecovering.current.add(conversationId)
          // Show the compacting spinner under the interrupted turn briefly;
          // we flip to the "Conversation compacted" separator when resume starts.
          setCompactingTurnId(event.turnId)
        } else if (isContextOverflow) {
          overflowRecovering.current.delete(conversationId)
        }

        if (!willContinueAutomatically) {
          appendConversationItem(conversationId, {
            id: `${event.turnId}:error`,
            role: 'system',
            text: isContextOverflow
              ? `${t('context.overflowDetected')}\n\n${event.message}`
              : event.message,
            timestamp: Date.now(),
          })
        }
      }
      // Capture partial assistant text BEFORE cleanup, so it can be appended
      // to the resume prompt as anchor context for the model.
      const partialText = turnAssistantText.current[event.turnId] ?? ''
      delete turnAssistantText.current[event.turnId]
      delete turnRetryPayload.current[event.turnId]
      if (conversationId) finishAssistantMessage(conversationId, event.turnId)
      cleanupTurnState(event.turnId)

      if (willRetrySession && conversationId && retryMeta) {
        clearConversationSession(conversationId)
        removeTurnTranscriptItems(conversationId, event.turnId)
        const retry = createQueuedFollowUp(conversationId, retryMeta.message)
        retry.request.turnId = crypto.randomUUID()
        if (completionDeferred) completionDeferred.turnId = retry.request.turnId
        void runTurn(retry, { skipResume: true }).catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          appendConversationItem(conversationId, {
            id: `${retry.request.turnId}:error`,
            role: 'system',
            text: message,
            timestamp: Date.now(),
          })
          if (turnCompletionDeferred.current === completionDeferred) {
            completionDeferred?.reject(error)
            turnCompletionDeferred.current = undefined
          }
        })
        return
      }

      // Auto-resume with a structured hidden prompt. The original user message
      // is never replayed, preventing completed tool calls from being repeated.
      if ((willRecoverAuth || willRecoverContext) && conversationId) {
        const suffix = partialText.length > 50
          ? `\n\nLast partial assistant output (may be truncated):\n"""\n${partialText.slice(-800)}\n"""`
          : ''
        const resumeMessage = t(willRecoverAuth ? 'auth.resumePrompt' : 'context.resumePrompt') + suffix
        const resume = createQueuedFollowUp(conversationId, resumeMessage)
        resume.request.turnId = crypto.randomUUID()
        if (completionDeferred) completionDeferred.turnId = resume.request.turnId

        if (willRecoverContext) {
          setCompactedTurnIds(prev => {
            const next = new Set(prev)
            next.add(event.turnId)
            return next
          })
          setCompactingTurnId(current => (current === event.turnId ? undefined : current))
          skipContextEstimateUntil.current = Date.now() + 15_000
        }

        void runTurn(resume).catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          authRecovering.current.delete(conversationId)
          overflowRecovering.current.delete(conversationId)
          appendConversationItem(conversationId, {
            id: `${resume.request.turnId}:error`,
            role: 'system',
            text: t(willRecoverAuth ? 'auth.recoveryFailed' : 'context.recoveryFailed', { message }),
            timestamp: Date.now(),
          })
          flashPet('error')
          if (turnCompletionDeferred.current === completionDeferred) {
            completionDeferred?.reject(error)
            turnCompletionDeferred.current = undefined
          }
        })
      }
      return
    }

    if (event.type === 'done') {
      const conversationId = turnConversationIds.current[event.turnId]
      // A turn finished cleanly → clear any overflow-recovery guard so a future
      // overflow in this conversation can auto-recover again.
      if (conversationId) {
        overflowRecovering.current.delete(conversationId)
        authRecovering.current.delete(conversationId)
      }
      setRunningTurnId(undefined)
      setRunningConversations(prev => { const next = new Set(prev); next.delete(conversationId); return next })
      setTokenRate(undefined)
      // Force the tray to idle so a lagging 'thinking' event can never
      // resurrect the timer after the turn has completed.
      void window.verboo.forceIdleMenuBar()
      setThinkingTurnId(current => (current === event.turnId ? undefined : current))
      setThinkingSnippets([])
      setCompactingTurnId(current => (current === event.turnId ? undefined : current))
      setImageReadingTurnId(current => (current === event.turnId ? undefined : current))
      clearActiveSubagentsForTurn(event.turnId)
      flashPet(event.exitCode === 0 ? 'success' : 'error')
      // Fire OS notification when the turn completed in a background
      // conversation (not the active one) or the window is not focused.
      // The backend checks the user's completion_notifications setting.
      if (conversationId) {
        const isActive = conversationId === activeConversationIdRef.current
        void window.verboo.fireCompletionNotification(
          event.exitCode ?? 0,
          conversationId,
          isActive,
        )
      }
      // Persist accumulated thinking text BEFORE the assistant message is
      // finalized so the block lands in chronological order in the
      // transcript. The live ref is intentionally NOT cleared (data contract).
      if (conversationId) commitTurnThinking(conversationId, event.turnId)
      presentTurnQuestions(event.turnId, conversationId)
      // Stale CLI session: clear stored id and retry once without --resume.
      // Do this BEFORE appending failure text / finishing the message so the
      // user never sees a flash of "No conversation found with session ID".
      const retryMeta = turnRetryPayload.current[event.turnId]
      const assistantBlob = `${turnAssistantText.current[event.turnId] ?? ''}\n${(turnTerminalErrors.current[event.turnId] ?? []).join('\n')}`
      const sessionGone = /no conversation found with session/i.test(assistantBlob)
        || (/session id[:\s]/i.test(assistantBlob) && /not found|não encontrad/i.test(assistantBlob))
      const shouldRetrySession = Boolean(
        conversationId
        && event.exitCode !== 0
        && sessionGone
        && retryMeta
        && !retryMeta.alreadyRetriedWithoutSession
        && retryMeta.message.trim(),
      )
      if (shouldRetrySession && conversationId && retryMeta) {
        clearConversationSession(conversationId)
        const message = retryMeta.message
        // Drop the failed turn's transcript items (error banner + empty shell)
        // so only the successful retry remains visible.
        removeTurnTranscriptItems(conversationId, event.turnId)
        delete turnRetryPayload.current[event.turnId]
        if (turnCompletionDeferred.current?.turnId === event.turnId) {
          turnCompletionDeferred.current.resolve()
          turnCompletionDeferred.current = undefined
        }
        if (interjectDeferred.current?.turnId === event.turnId) {
          interjectDeferred.current.resolve()
          interjectDeferred.current = undefined
        }
        // presentTurnQuestions (above) may have staged a question wizard for
        // the dead turnId; clear it so the retry doesn't inherit stale state.
        if (questionPromptRef.current?.turnId === event.turnId) {
          questionPromptRef.current = undefined
          setQuestionPrompt(undefined)
          setQuestionWizardOpen(false)
        }
        cleanupTurnState(event.turnId)
        void runTurn(createQueuedFollowUp(conversationId, message), { skipResume: true })
        return
      }
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
      delete turnRetryPayload.current[event.turnId]

      // Resolve goal turn completion promise if this turn was started by the goal scheduler
      if (turnCompletionDeferred.current?.turnId === event.turnId) {
        turnCompletionDeferred.current.resolve()
        turnCompletionDeferred.current = undefined
      }
      // Resolve interject promise if one is pending for this turn
      if (interjectDeferred.current?.turnId === event.turnId) {
        interjectDeferred.current.resolve()
        interjectDeferred.current = undefined
      }

    }
  }

  // Guard against re-entrant sendMessage (double-click, keyboard race with
  // attachment flow). Checked AND set in the same synchronous section so
  // concurrent awaits see the lock before the first call's first await.
  // The ref resets in the `finally` block at the end of the function.
  const sendMessageLock = useRef(false)
  async function sendMessage(message: string) {
    const trimmed = message.trim()
    if (!trimmed) return
    if (sendMessageLock.current) return // already in flight
    sendMessageLock.current = true
    try {
    const conversationId = ensureActiveConversation()

    // ── Vision fallback consent check ──
    const hasImages = attachedFiles.some(f => f.kind === 'image')
    const modelNeedsFallback = hasImages && !selectedModelInfo?.supportsVision
    if (modelNeedsFallback) {
      const consent = userSettings.visionFallbackConsent
      if (consent === 'never') {
        // Strip images silently — the user opted out.
        setAttachedFiles(current => current.filter(f => f.kind !== 'image'))
      } else if (consent === 'ask') {
        // Show consent modal — wait for user choice.
        const fbState: VisionFallbackState = await window.verboo.getVisionFallbackState()
        const choice = await new Promise<{ allowOnce: boolean } | { persist: VisionFallbackConsent }>(resolve => {
          visionFallbackResolveRef.current = resolve
          setVisionFallbackState(fbState)
        })
        setVisionFallbackState(undefined)
        visionFallbackResolveRef.current = undefined

        if ('persist' in choice) {
          // Persist the user's choice and apply it immediately.
          setUserSettings(current => {
            const next = { ...current, visionFallbackConsent: choice.persist }
            void window.verboo.updateUserSettings(next).catch(() => {})
            return next
          })
          toast(t('vision.consentUpdated'))
          if (choice.persist === 'never') {
            setAttachedFiles(current => current.filter(f => f.kind !== 'image'))
          }
        }
        // 'allowOnce' → proceed with images attached (existing behavior).
      }
    }

    // ── OCR race gate ────────────────────────────────────────
    // Wait for pending OCR to finish (up to 15s) so images already in
    // the process don't go unread. Non-blocking for attachments that
    // haven't started OCR yet.
    const pendingOcr = attachedFiles
      .filter(f => f.kind === 'image' && !f.extractedText)
      .map(f => ocrCompletionsRef.current[f.path]?.promise)
      .filter(Boolean) as Promise<void>[]
    if (pendingOcr.length) {
      await Promise.race([
        Promise.allSettled(pendingOcr),
        new Promise<void>(resolve => setTimeout(resolve, 15_000)),
      ])
    }

    // ── Skill approval gate ───────────────────────────────────
    if (selectedSkillsUnion.length) {
      const unapproved = await window.verboo.checkSkillApproval(selectedSkillsUnion)
      if (unapproved.length) {
        const choice = await new Promise<{ allowOnce: boolean } | { trust: string } | { cancel: true }>(resolve => {
          skillApprovalResolveRef.current = resolve
          setPendingSkillApproval(unapproved)
        })
        setPendingSkillApproval(undefined)
        skillApprovalResolveRef.current = undefined

        if ('cancel' in choice) {
          // Remove the unapproved skills from the selection and warn the user.
          const unapprovedIds = new Set(unapproved.map(s => s.id))
          setTokenSkills(current => current.filter(s => !unapprovedIds.has(s.id)))
          toast(t('skillApproval.skippedWarning'))
        } else if ('trust' in choice) {
          // Persist trust and keep the skill for this turn.
          void window.verboo.approveSkill(choice.trust).catch(() => {})
          // Keep all selected skills — the backend already approved this one.
        }
        // 'allowOnce' → keep all selected skills, no persistence needed.
      }
    }

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
      skills: selectedSkillsUnion,
      // Persist a slim version of attachments — just path/name/kind — so the
      // transcript can render chips/thumbnails on reload without base64 bloat.
      attachments: attachedFiles.length ? attachedFiles.map(slimMeta) : undefined,
    }, titleFromMessage(trimmed))

    if (isConversationRunning(conversationId)) {
      enqueueFollowUp(queued)
      setAttachedFiles([])
      return
    }

    appendDowngradeActivity(conversationId)
    await runTurn(queued)
    setAttachedFiles([])
    } finally {
      sendMessageLock.current = false
    }
  }

  function isConversationRunning(conversationId: string): boolean {
    return Object.values(turnConversationIds.current).includes(conversationId)
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
        conversationId,
        message,
        model: selectedModel,
        modelSupportsVision: Boolean(selectedModelInfo?.supportsVision),
        contextWindow: selectedContextWindow,
        effort: validEffortOverride,
        reasoning: selectedModelReasoning,
        responseLanguage,
        accessMode: accessMode === 'full' && !userSettings.fullAccessEnabled ? 'approval' : accessMode,
        workingDirectory: workingDirectoryForConversation(conversationId),
        skills: selectedSkillsUnion,
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
  }

  async function flushQueuedFollowUps() {
    if (runningTurnId || queuedFollowUpsRef.current.length === 0) return
    const [next, ...rest] = queuedFollowUpsRef.current
    if (!next) return
    setQueuedFollowUpsList(() => rest)
    await runTurn(next)
  }

  // Interject a queued message: interrupt the current turn, wait for it to
  // end, then send the message with the conversation's sessionId so the model
  // resumes with the new input as context. The model sees the interjection
  // in its history and can pivot or continue as it sees fit.
  async function interjectMessage(conversationId: string, queueItemId: string) {
    if (interjectDeferred.current) return // already interjecting
    const item = queuedFollowUpsRef.current.find(q => q.id === queueItemId)
    if (!item) return

    // Find the active turnId for this conversation
    const activeTurnEntry = Object.entries(turnConversationIds.current).find(([, convId]) => convId === conversationId)
    const currentTurnId = activeTurnEntry?.[0]

    // Remove from queue
    setQueuedFollowUpsList(current => current.filter(q => q.id !== queueItemId))
    updateConversation(conversationId, conversation => ({
      ...conversation,
      updatedAt: Date.now(),
    }))

    if (!currentTurnId) {
      // No active turn for this conversation — just send normally
      appendDowngradeActivity(conversationId)
      await runTurn(item)
      return
    }

    // Wait for the current turn to end (interrupt triggers done/error event)
    await new Promise<void>(resolve => {
      interjectDeferred.current = { turnId: currentTurnId, resolve }
      window.verboo.interrupt(conversationId)
    })

    // Now send the interjected message with the conversation's sessionId
    appendDowngradeActivity(conversationId)
    await runTurn(item)
  }

  function removeQueuedItem(queueItemId: string) {
    const item = queuedFollowUpsRef.current.find(q => q.id === queueItemId)
    if (!item) return
    setQueuedFollowUpsList(current => current.filter(q => q.id !== queueItemId))
  }

  function moveQueuedItem(queueItemId: string, direction: -1 | 1) {
    setQueuedFollowUpsList(current => {
      const idx = current.findIndex(q => q.id === queueItemId)
      if (idx === -1) return current
      const target = idx + direction
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      // Swap elements in the queue array.
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  function editQueuedItem(queueItemId: string, newText: string) {
    setQueuedFollowUpsList(current => current.map(q => q.id === queueItemId ? { ...q, message: newText } : q))
  }

  // Edit a user's sent message: update the transcript text, remove all
  // assistant-turn items that followed it, and queue a new turn with the
  // edited text so the model re-responds.
  function editSentMessage(conversationId: string, itemId: string, newText: string) {
    updateConversation(conversationId, conversation => {
      const idx = conversation.items.findIndex(i => i.id === itemId)
      if (idx === -1) return conversation
      // Update the user message text.
      const items = conversation.items.map(i =>
        i.id === itemId ? { ...i, text: newText } : i
      )
      // Remove assistant-turn items that follow (until the next user message).
      const nextUserIdx = items.findIndex((i, ii) => ii > idx && i.role === 'user')
      const removeEnd = nextUserIdx === -1 ? items.length : nextUserIdx
      const kept = [...items.slice(0, idx + 1), ...items.slice(removeEnd)]
      return { ...conversation, items: kept, updatedAt: Date.now() }
    })
    // Queue a new turn with the edited text.
    const queued = createQueuedFollowUp(conversationId, newText)
    enqueueFollowUp(queued)
  }

  // "Direcionar agora": move item to front of queue. If no turn is running,
  // remove from queue and send now. If a turn IS running, the item becomes
  // first in queue — next flush (after the turn) picks it up.
  function sendNow(conversationId: string, queueItemId: string) {
    const current = queuedFollowUpsRef.current
    const idx = current.findIndex(q => q.id === queueItemId)
    if (idx === -1) return
    const item = current[idx]
    if (!runningTurnId) {
      // Nothing running — send now.
      queuedFollowUpsRef.current = current.filter(q => q.id !== queueItemId)
      setQueuedFollowUpsList(() => queuedFollowUpsRef.current)
      runTurn(item)
    } else {
      // Turn active — move to front.
      const next = current.filter(q => q.id !== queueItemId)
      next.unshift(item)
      queuedFollowUpsRef.current = next
      setQueuedFollowUpsList(() => next)
    }
  }

  async function runTurn(item: QueuedFollowUp, options?: { skipResume?: boolean }) {
    pendingConversationId.current = item.conversationId
    setContextUsage(undefined)
    setTokenRate(undefined)

    const request = await prepareRequestWithResearchSubagents(item)
    const resumeId = options?.skipResume ? undefined : conversationCliSessionId(item.conversationId)
    const turnId = await sendTrackedTurn(request, resumeId)
    turnConversationIds.current[turnId] = item.conversationId
    turnModels.current[turnId] = item.turnModel
    // Track last user text for one-shot session-resume recovery.
    turnRetryPayload.current[turnId] = {
      conversationId: item.conversationId,
      message: item.message,
      alreadyRetriedWithoutSession: Boolean(options?.skipResume),
    }
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
    autoSelectSubagent(agents[0]?.id)

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
      activeSubagentsRef.current = Object.fromEntries(finishedAgents.map(agent => [agent.id, agent]))
      pendingResearchSubagentsRef.current = finishedAgents
      setActiveSubagents(finishedAgents)
      autoSelectSubagent(finishedAgents[0]?.id)
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
      const now = Date.now()
      const detail = error instanceof Error ? error.message : String(error)
      const failedAgents = agents.map((agent, index) => ({
        ...agent,
        status: 'failed',
        detail,
        updatedAt: now + index,
        history: appendSubagentHistory(agent.history, {
          id: `failed:${index + 1}:${now}`,
          label: t('subagent.failed'),
          text: detail,
          timestamp: now + index,
        }),
      } satisfies ActiveSubagent))
      activeSubagentsRef.current = Object.fromEntries(failedAgents.map(agent => [agent.id, agent]))
      pendingResearchSubagentsRef.current = failedAgents
      setActiveSubagents(failedAgents)
      autoSelectSubagent(failedAgents[0]?.id)
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

    if (isConversationRunning(prompt.conversationId)) {
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
        conversationId,
        message,
        model: selectedModel,
        modelSupportsVision: Boolean(selectedModelInfo?.supportsVision),
        contextWindow: selectedContextWindow,
        effort: validEffortOverride,
        reasoning: selectedModelReasoning,
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

  // Model questions can arrive through the structured AskUserQuestion tool
  // (headless CLI fails it with "Answer questions?", so the model never gets
  // answers on its own) or as a high-confidence question pattern in the final
  // text. The wizard turns both into an answerable step-by-step flow whose
  // answers go back as a follow-up message — same mechanism the permission
  // panel uses.
  function collectModelQuestions(turnId: string, payload: unknown) {
    const questions = extractModelQuestionsFromPayload(payload)
    if (questions.length === 0) return
    const existing = turnQuestions.current[turnId] ?? []
    const merged = mergeModelQuestions(existing, questions)
    if (merged.length === existing.length) return
    turnQuestions.current[turnId] = merged
    if (existing.length === 0) {
      // The headless CLI fails AskUserQuestion instantly, and the model tends
      // to retry it in a loop. Present the captured questions once, then stop
      // only this conversation's turn; answers return as the next message.
      const conversationId = turnConversationIds.current[turnId]
      presentTurnQuestions(turnId, conversationId)
      void window.verboo.interrupt(conversationId)
    }
  }

  function presentTurnQuestions(turnId: string, conversationId: string | undefined) {
    if (!conversationId) return
    // Already presented for this turn (wizard opened mid-turn on tool capture).
    if (questionPromptRef.current?.turnId === turnId) return
    let questions: ModelQuestion[] | undefined = turnQuestions.current[turnId]
    let autoOpen = true
    if (!questions || questions.length === 0) {
      const detected = detectTextQuestionPrompt(turnAssistantText.current[turnId] ?? '')
      questions = detected?.questions
      autoOpen = detected?.autoOpen ?? false
    }
    if (!questions || questions.length === 0) return
    delete turnQuestions.current[turnId]
    const nextPrompt: QuestionPromptState = {
      conversationId,
      turnId,
      questions,
      answers: questions.map(() => ({ selected: [], custom: '' })),
    }
    questionPromptRef.current = nextPrompt
    setQuestionPrompt(nextPrompt)
    setQuestionWizardOpen(autoOpen)
  }

  async function submitQuestionAnswers() {
    // Read through the ref: the wizard auto-advances 170ms after the last
    // click, and the state captured by its render closure can miss that
    // final answer (it shipped "(no answer)" for the last question).
    const prompt = questionPromptRef.current
    if (!prompt) return
    questionPromptRef.current = undefined
    setQuestionPrompt(undefined)
    setQuestionWizardOpen(false)

    const lines = prompt.questions.map((question, index) => {
      const answer = prompt.answers[index]
      const parts = [
        ...(answer?.selected ?? []),
        ...(answer?.custom.trim() ? [answer.custom.trim()] : []),
      ]
      const label = question.header ? `${question.header} — ${question.question}` : question.question
      return `${index + 1}. ${label}\n→ ${parts.length > 0 ? parts.join('; ') : t('questions.noAnswer')}`
    })
    const message = `${t('questions.answersIntro')}\n\n${lines.join('\n\n')}`
    const responseLanguage = conversationLanguageFallback(prompt.conversationId)
    const followUp = createPermissionFollowUp(prompt.conversationId, message, responseLanguage)
    stickToBottomRef.current = true
    if (isConversationRunning(prompt.conversationId)) {
      enqueueFollowUp(followUp)
      return
    }
    appendDowngradeActivity(prompt.conversationId)
    await runTurn(followUp)
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

  /**
   * /compact — reserved system command (like /goal and /pet).
   * Forwards to the CLI's native `/compact` slash command with session resume
   * so the CLI summarizes history and frees context. Optional free-text
   * instructions are appended: `/compact keep API design decisions`.
   * No user bubble is shown (same as other reserved commands).
   */
  function handleCompactCommand(command: Extract<ReservedSlashCommand, { kind: 'compact' }>) {
    const conversationId = ensureActiveConversation()
    const sessionId = conversationCliSessionId(conversationId)
    if (!sessionId) {
      toast(t('composer.compactNoSession'), 'info')
      return
    }

    // Forward to the CLI's native /compact (supportsNonInteractive: true).
    // Marker UI is driven by Geralt's runtimeActivity compacting events —
    // no placeholder turnId (that would fight the real turnId from sendTurn).
    const message = command.instructions?.trim()
      ? `/compact ${command.instructions.trim()}`
      : '/compact'

    skipContextEstimateUntil.current = Date.now() + 15_000
    toast(t('composer.compactStarted'), 'info')

    const queued = createQueuedFollowUp(conversationId, message)
    if (isConversationRunning(conversationId)) {
      enqueueFollowUp(queued)
      return
    }
    void runTurn(queued)
  }

  function updatePetSize(size: number) {
    const clamped = Math.round(Math.max(PET_MIN_SIZE, Math.min(PET_MAX_SIZE, size)))
    setPetSize(clamped)
    window.localStorage.setItem('verboo:pet-size', String(clamped))
  }

  useEffect(() => {
    function handlePaletteShortcut(event: KeyboardEvent) {
      // ⌘K (mac) / Ctrl+K (win/linux) toggles the palette. ⌘P is an alias —
      // common in editors (VS Code "Quick Open") and feels natural for search.
      if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 'k' || event.key.toLowerCase() === 'p')) {
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
    { key: 'plugins', label: t('palette.openPlugins'), icon: paletteIcons.plugins, run: () => setActiveView('plugins') },
    { key: 'settings', label: t('palette.openSettings'), icon: paletteIcons.settings, run: () => setActiveView('settings') },
    { key: 'theme', label: t('palette.toggleTheme'), icon: paletteIcons.theme, run: () => cycleTheme() },
    { key: 'terminal', label: t('palette.toggleTerminal'), icon: paletteIcons.terminal, run: () => handleToggleTerminal(currentWorkspaceDirectory) },
    { key: 'review', label: t('palette.toggleReview'), icon: paletteIcons.review, run: () => { void handleToggleReview() } },
    { key: 'sidebar', label: t('palette.toggleSidebar'), icon: paletteIcons.sidebar, run: toggleSidebarVisibility },
    { key: 'pet', label: t('palette.togglePet'), icon: paletteIcons.pet, run: togglePet },
    {
      key: 'compact',
      label: t('palette.compactContext'),
      icon: paletteIcons.compact,
      run: () => handleCompactCommand({ kind: 'compact', raw: '/compact' }),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, currentWorkspaceDirectory])

  function handleEditObjective(newObjective: string) {
    const conversationId = activeConversation?.id
    if (!conversationId) return
    const current = goalRef.current
    if (!current) return

    const oldObjective = current.objective
    const updated: GoalState = {
      ...current,
      objective: newObjective,
      updatedAt: Date.now(),
    }
    setGoal(updated)
    goalRef.current = updated
    updateConversationGoal(updated)

    // System message: show old→new when the user can see both, otherwise just the new.
    const systemMessage = oldObjective.trim() && oldObjective !== newObjective
      ? t('goal.objectiveUpdatedBody', { old: oldObjective, new: newObjective })
      : t('goal.objectiveUpdatedSingle', { new: newObjective })
    appendConversationItem(conversationId, goalSystemMessage(systemMessage))

    // If a turn is in progress, interject the updated objective so the
    // model pivots immediately. Otherwise, the next buildContinuePrompt
    // cycle will pick up the new objective from goal state automatically.
    const turnInProgress = runningConversations.has(conversationId)
    if (turnInProgress) {
      const prompt = buildObjectiveUpdatedPrompt(newObjective)
      // interjectMessage expects a queue item ID (not raw text), so we
      // create a queued follow-up first, then interject with its ID.
      const queued = createQueuedFollowUp(conversationId, prompt)
      enqueueFollowUp(queued)
      void interjectMessage(conversationId, queued.id).catch(err => {
        console.error('[goal] failed to interject objective update:', err)
      })
    }
  }

  function handleGoalCommand(command: Extract<ReservedSlashCommand, { kind: 'goal' }>) {
    if (command.action === 'show' || command.action === 'status') {
      const conversationId = ensureActiveConversation()
      const current = goalRef.current
      if (!current) {
        appendConversationItem(conversationId, goalSystemMessage(t('goal.noneActive')))
        return
      }
      const statusKey =
        current.status === 'active' || current.status === 'evaluating' || current.status === 'continuing' ? 'goal.statusActive' :
        current.status === 'paused' ? 'goal.statusPaused' :
        current.status === 'completed' ? 'goal.statusCompleted' :
        'goal.statusBlocked'
      appendConversationItem(conversationId, goalSystemMessage(
        t(statusKey, { objective: current.objective, turn: current.turnsRun }),
      ))
      return
    }

    if (command.action === 'help') {
      const conversationId = ensureActiveConversation()
      appendConversationItem(conversationId, goalSystemMessage(
        `${t('goal.helpTitle')}\n\n${t('goal.helpBody')}`,
      ))
      return
    }

    if (command.action === 'pause') {
      const conversationId = ensureActiveConversation()
      setGoal(current => current ? {
        ...current,
        status: 'paused' as const,
        pausedAt: Date.now(),
        pauseReason: 'userPaused',
      } : current)
      setGoalBarStatus({ kind: 'stopped', objective: goalRef.current?.objective ?? '', reason: 'userPaused' })
      goalAbortRef.current?.abort()
      appendConversationItem(conversationId, goalSystemMessage(t('goal.userPausedBody')))
      return
    }

    if (command.action === 'resume') {
      setGoal(current => {
        if (!current || (current.status !== 'paused' && current.status !== 'blocked')) return current
        const resumed: GoalState = { ...current, status: 'active', noProgressCount: 0, errorCount: 0 }
        setGoalBarStatus({ kind: 'active', objective: resumed.objective, turn: resumed.turnsRun })
        void startGoalScheduler(resumed)
        return resumed
      })
      return
    }

    if (command.action === 'clear') {
      const conversationId = ensureActiveConversation()
      goalAbortRef.current?.abort()
      setGoal(undefined)
      setGoalBarStatus({ kind: 'idle' })
      goalSessionId.current = undefined
      appendConversationItem(conversationId, goalSystemMessage(t('goal.userCancelledBody')))
      return
    }

    if (command.action === 'start' && command.objective) {
      goalAbortRef.current?.abort()

      const conversationId = ensureActiveConversation()
      const wd = workingDirectoryForConversation(conversationId)

      setGoal(undefined)
      setGoalBarStatus({ kind: 'idle' })
      goalSessionId.current = undefined

      // Prefer settings when auto-access is on: use 'auto' for the goal loop so
      // continuations don't stop on every shell/file permission prompt.
      const goalAccessMode = userSettings.goalMode.allowAutoAccess
        ? (accessMode === 'full' && userSettings.fullAccessEnabled ? 'full' as const : 'auto' as const)
        : accessMode

      const goalState = createGoalState({
        objective: command.objective,
        accessMode: goalAccessMode, // continueGoal downgrades 'full' unless full access is enabled
        modelId: selectedModel,
        modelDisplayName: selectedModelInfo?.displayName,
        workingDirectory: wd,
        skills: selectedSkillsUnion,
      })

      appendConversationItem(conversationId, goalSystemMessage(t('goal.systemStarted', { objective: command.objective })))

      const message = buildGoalStartMessage(command.objective, wd)
      appendConversationItem(conversationId, {
        id: `user:goal:${Date.now()}`,
        role: 'user',
        text: message,
        timestamp: Date.now(),
        skills: selectedSkillsUnion,
      }, t('goal.systemObjective', { objective: command.objective }))

      setGoal(goalState)
      setGoalBarStatus({ kind: 'active', objective: goalState.objective, turn: 0 })

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
        if (!conversationId || controller.signal.aborted) {
          throw new Error('Goal evaluation aborted: no active conversation')
        }

        const input: GoalEvaluationInput = {
          goal: currentGoal,
          conversationItems: [...conversationItems],
        }

        // Errors propagate to the scheduler, which counts consecutive
        // failures and pauses the goal after MAX_EVALUATION_ERRORS. We
        // do NOT swallow errors into a fake "continue" decision — that
        // would burn budget silently on a broken evaluator.
        const result = await window.verboo.evaluateGoal(input)
        if (controller.signal.aborted) {
          throw new Error('Goal evaluation aborted by user')
        }

        setGoal(current => current ? {
          ...current,
          lastEvaluation: result.evaluation,
          updatedAt: Date.now(),
        } : current)

        return result.evaluation
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
        // Continuations honor goal.accessMode (set from allowAutoAccess at start)
        // and still refuse full access when the user has not unlocked it.
        const continueAccess =
          currentGoal.accessMode === 'full' && !userSettings.fullAccessEnabled
            ? 'approval'
            : currentGoal.accessMode
        const turnId = await sendTrackedTurn({
          conversationId,
          message: nextMessage,
          model: selectedModel,
          modelSupportsVision: Boolean(selectedModelInfo?.supportsVision),
          contextWindow: selectedContextWindow,
          effort: validEffortOverride,
          reasoning: selectedModelReasoning,
          responseLanguage: inferResponseLanguage(nextMessage, goalLanguage),
          accessMode: continueAccess,
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
        // Force the tray to idle immediately — don't wait for the CLI to
        // acknowledge the interrupt (it may be stuck reading stdout and
        // never emit the 'done' event). Prevents the timer from counting
        // forever after the user clicks abort.
        void window.verboo.forceIdleMenuBar()
      },
      onStatusChange: setGoalBarStatus,
      onLog: (message) => {
        console.log('[goal]', message)
      },
      t,
    }

    await runGoalCycle(delegate)
  }

  function buildGoalStartMessage(objective: string, workingDirectory: string): string {
    return [
      `## Goal: ${objective}`,
      '',
      'You are now working autonomously toward this objective.',
      'Complete the objective step by step. Do NOT ask for confirmation for each step.',
      'When you believe the objective is complete, summarize what was done.',
      '',
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

  // Paste handler: same pipeline as attachDroppedFiles, but also handles raw
  // image blobs (screenshots) that have no filesystem path. Those are read as
  // base64 and sent to the backend via pasteImageBlob for temp-file creation.
  async function attachPastedFiles(paths: string[], files: File[]) {
    if (!paths.length && !files.length) return
    let attachments: AttachmentMeta[] = []
    if (paths.length) {
      attachments = await window.verboo.inspectFiles(paths)
    } else {
      // Separate image blobs (no path) from regular files.
      const blobs = files.filter(f => !(f as File & { path?: string }).path && f.type.startsWith('image/'))
      const withPath = files.filter(f => (f as File & { path?: string }).path)
      if (withPath.length) {
        const p = withPath.map(f => (f as File & { path: string }).path)
        attachments = await window.verboo.inspectFiles(p)
      }
      for (const blob of blobs) {
        const reader = new FileReader()
        const base64 = await new Promise<string>(resolve => {
          reader.onload = () => resolve((reader.result as string).split(',')[1])
          reader.readAsDataURL(blob)
        })
        const name = `pasted-${Date.now()}.${blob.type.split('/')[1] || 'png'}`
        const meta = await window.verboo.pasteImageBlob(base64, name)
        attachments.push(...meta)
      }
    }
    if (!attachments.length) return
    appendAttachments(attachments)
  }

  function appendAttachments(attachments: AttachmentMeta[]) {
    setAttachedFiles(current => {
      const byPath = new Map(current.map(attachment => [attachment.path, attachment]))
      for (const attachment of attachments) byPath.set(attachment.path, attachment)
      return Array.from(byPath.values())
    })
    // Local OCR is a LAST RESORT — only runs when the selected model doesn't
    // support vision AND no vision-capable model exists in the catalog. If the
    // user switches to a vision model, the backend's vision_fallback handles
    // image description instead. This avoids the "OCR running" label blocking
    // send while a vision model could describe the image directly.
    const selectedVision = selectedModelInfo?.supportsVision ?? false
    const anyVisionAvailable = modelResult.models.some(m => m.supportsVision)
    const neverConsent = userSettings.visionFallbackConsent === 'never'
    const shouldOcr = !selectedVision && !anyVisionAvailable && !neverConsent
    if (shouldOcr) runOcrForAttachments(attachments)
  }

  function runOcrForAttachments(attachments: AttachmentMeta[]) {
    const toProcess = attachments.filter(att => att.kind === 'image' && !att.extractedText)
    if (!toProcess.length) return
    setOcrProcessingPaths(current => [...current, ...toProcess.map(a => a.path)])
    for (const att of toProcess) {
      const imageUrl = window.verboo?.fileUrl?.(att.path)
      if (!imageUrl) {
        setOcrProcessingPaths(current => current.filter(p => p !== att.path))
        continue
      }
      // Create a deferred promise so sendMessage can await OCR completion.
      let _resolve: () => void
      const promise = new Promise<void>(resolve => { _resolve = resolve })
      ocrCompletionsRef.current[att.path] = { resolve: _resolve!, promise }

      recognizeImage(imageUrl)
        .then(result => {
          ocrCompletionsRef.current[att.path]?.resolve()
          delete ocrCompletionsRef.current[att.path]
          setOcrProcessingPaths(current => current.filter(p => p !== att.path))
          if (!result) {
            // Worker failed (missing traineddata / CSP block) — mark warning.
            setAttachedFiles(current =>
              current.map(a => a.path === att.path
                ? { ...a, extractionStatus: 'warning' as ExtractionStatus }
                : a
              )
            )
            return
          }
          const status: ExtractionStatus = result.isEmpty ? 'warning' : 'extracted'
          setAttachedFiles(current =>
            current.map(a => a.path === att.path
              ? { ...a, extractedText: result.text, extractionStatus: status }
              : a
            )
          )
        })
        .catch(() => {
          // Unhandled rejection — worker crashed.
          ocrCompletionsRef.current[att.path]?.resolve()
          delete ocrCompletionsRef.current[att.path]
          setOcrProcessingPaths(current => current.filter(p => p !== att.path))
          setAttachedFiles(current =>
            current.map(a => a.path === att.path
              ? { ...a, extractionStatus: 'warning' as ExtractionStatus }
              : a
            )
          )
        })
    }
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
    } else {
      // No project on this new chat — reset the working directory to the host
      // default so the badge doesn't keep showing the previous project's path.
      setConfig(current => ({ ...current, workingDirectory: defaultWorkingDirectoryRef.current }))
    }
    setActiveConversationId(undefined)
    setSelectedProjectId(project?.id)
    setTokenSkills([])
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
    // Reset the working directory to the host default so the workspace badge
    // and terminal don't keep showing the previous project's path after the
    // user clears the selection. Without this, `config.workingDirectory` stays
    // pinned to the last project and the badge reads "northstar-commerce" even
    // though no project is active.
    setConfig(current => ({ ...current, workingDirectory: defaultWorkingDirectoryRef.current }))
    setActiveView('chat')
  }

  function selectConversation(conversationId: string) {
    const conversation = chatStore.conversations.find(item => item.id === conversationId)
    if (!conversation || conversation.archivedAt) return
    const project = conversation.projectId
      ? chatStore.projects.find(item => item.id === conversation.projectId)
      : undefined
    setActiveConversationId(conversation.id)
    setSelectedProjectId(conversation.projectId ?? undefined)
    if (project?.path) {
      setConfig(current => ({ ...current, workingDirectory: project.path ?? current.workingDirectory }))
    } else {
      // Conversation has no project — reset the working directory to the host
      // default so the badge and terminal don't keep showing the previous
      // project's path. This is the root cause of the "badge still says
      // northstar-commerce after switching to a loose chat" bug.
      setConfig(current => ({ ...current, workingDirectory: defaultWorkingDirectoryRef.current }))
    }
    setActiveView('chat')

    // Hydrate goal state from the stored conversation. Only active/paused
    // goals are restored — completed/blocked/cancelled goals are historical
    // and don't drive the status bar on reopen. The scheduler is NOT
    // auto-resumed here; the user clicks Resume on the status bar to
    // restart the cycle (avoids surprise autonomous execution on chat switch).
    const storedGoal = conversation.goal
    if (storedGoal && (storedGoal.status === 'active' || storedGoal.status === 'paused' || storedGoal.status === 'evaluating' || storedGoal.status === 'continuing')) {
      const restored: GoalState = storedGoal.status === 'active' || storedGoal.status === 'evaluating' || storedGoal.status === 'continuing'
        ? { ...storedGoal, status: 'paused', pausedAt: storedGoal.pausedAt ?? Date.now() }
        : storedGoal
      setGoal(restored)
      goalRef.current = restored
      setGoalBarStatus({
        kind: 'stopped',
        objective: restored.objective,
        reason: restored.pauseReason ?? 'paused',
      })
    } else {
      // No live goal on this conversation — clear any stale state.
      setGoal(undefined)
      goalRef.current = undefined
      setGoalBarStatus({ kind: 'idle' })
    }
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

  function renameConversation(conversationId: string, title: string) {
    const trimmed = title.trim()
    if (!trimmed) return
    updateChatStore(store => ({
      ...store,
      conversations: store.conversations.map(conversation =>
        conversation.id === conversationId ? { ...conversation, title: trimmed, updatedAt: Date.now() } : conversation,
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

  function clearConversationSession(conversationId: string) {
    updateConversation(conversationId, conversation => {
      if (!conversation.cliSessionId) return conversation
      return {
        ...conversation,
        cliSessionId: undefined,
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

  /** Remove all transcript rows belonging to a turn (text segments, thinking, etc.). */
  function removeTurnTranscriptItems(conversationId: string, turnId: string) {
    updateConversation(conversationId, conversation => ({
      ...conversation,
      items: conversation.items.filter(item =>
        item.id !== turnId
        && !item.id.startsWith(`${turnId}:`),
      ),
      updatedAt: Date.now(),
    }))
    delete turnAssistantText.current[turnId]
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
    // Dedupe: skip regular "Leu imagem" activities when a vision-relay
    // activity already exists for this turn (avoids double image row).
    if (activity.kind === 'image' && !activity.key.endsWith(':vision-relay')) {
      const hasRelay = Array.from(keys).some(k => k.endsWith(':vision-relay'))
      if (hasRelay) return
    }
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
    // Track the tool_use_id on every activity kind — not just commands — so a
    // later tool_result (Read/Edit/Search/etc) can attach its real output here.
    if (!command && activity.toolUseId) {
      const map = turnToolUseItemIds.current[turnId] ?? {}
      map[activity.toolUseId] = itemId
      turnToolUseItemIds.current[turnId] = map
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
          activityAdditions: activity.additions,
          activityDeletions: activity.deletions,
          activityDiffPreview: activity.diffPreview,
          command,
          text: activityDisplayLabel(activity, t),
          timestamp: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    }))
  }

  // Commits the accumulated thinking text for a turn into a PERSISTENT
  // TranscriptItem so it survives re-renders and reloads and is available
  // to groupTurnBlocks (which emits the { kind: 'thinking' } block). Called
  // at end-of-turn (done / error). Idempotent — safe to call from both
  // handlers. Per the data contract, the live ref
  // (turnThinkingText.current[turnId]) is intentionally NOT cleared so the
  // text remains available to the pipeline; persistence is carried by the
  // TranscriptItem itself (chatStore serializes the whole conversation).
  function commitTurnThinking(conversationId: string, turnId: string) {
    const fullText = turnThinkingText.current[turnId]?.trim()
    if (!fullText) return
    const thinkingItemId = `${turnId}:thinking`
    updateConversation(conversationId, conversation => {
      if (conversation.items.some(item => item.id === thinkingItemId)) return conversation
      const thinkingItem: TranscriptItem = {
        id: thinkingItemId,
        role: 'tool',
        kind: 'activity',
        activityKind: 'thinking',
        text: fullText,
        timestamp: Date.now(),
      }
      // Insert before the first turn-scoped item (placeholder / activity /
      // text segment) so the block reflects chronological order:
      // user msg → thinking → assistant text → actions → summary.
      // If no turn-scoped item exists yet, append at the end.
      const firstTurnIndex = conversation.items.findIndex(item => item.id.startsWith(`${turnId}:`))
      if (firstTurnIndex === -1) {
        return {
          ...conversation,
          items: [...conversation.items, thinkingItem],
          updatedAt: Date.now(),
        }
      }
      const nextItems = [...conversation.items]
      nextItems.splice(firstTurnIndex, 0, thinkingItem)
      return {
        ...conversation,
        items: nextItems,
        updatedAt: Date.now(),
      }
    })
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

  // Attach a tool_result's output to a non-command activity item (Read/Edit/
  // Search/etc) so the user can expand the row and see what came back. The
  // output is truncated at capture time so the persisted store stays small
  // (long file dumps, big grep results, etc).
  function updateActivityToolOutput(conversationId: string, itemId: string, output: string, isError: boolean) {
    const truncated = truncateToolOutput(output, isError)
    updateConversation(conversationId, conversation => ({
      ...conversation,
      items: conversation.items.map(item => item.id === itemId
        ? { ...item, toolOutput: truncated }
        : item),
      updatedAt: Date.now(),
    }))
  }

  function autoSelectSubagent(id: string | undefined) {
    if (!id || subagentPanelDismissed.current) return
    autoSelectSubagent(id)
  }

  // Child events of a running subagent arrive tagged with parent_tool_use_id.
  // They carry the whole exchange: the orchestrator's prompt (user message),
  // the agent's own text and tool calls (assistant messages). Routing them
  // into the subagent history turns the side panel into a real conversation —
  // model asks, agent works, agent answers.
  function routeSubagentChildEvent(turnId: string, payload: unknown) {
    if (!isRecord(payload) || typeof payload.parent_tool_use_id !== 'string') return
    const subagentId = turnSubagentToolIds.current[turnId]?.[payload.parent_tool_use_id]
    if (!subagentId) return
    const previous = activeSubagentsRef.current[subagentId]
    if (!previous) return
    const message = isRecord(payload.message) ? payload.message : undefined
    if (!message || !Array.isArray(message.content)) return

    const now = Date.now()
    let next = previous
    for (const block of message.content) {
      if (!isRecord(block)) continue
      const text = typeof block.text === 'string' ? block.text.trim() : ''
      if (payload.type === 'user' && block.type === 'text' && text) {
        next = {
          ...next,
          mission: text,
          updatedAt: now,
          history: appendSubagentHistory(next.history, {
            id: `${subagentId}:prompt:${now}`,
            label: t('subagent.missionReceived'),
            text,
            timestamp: now,
          }),
        }
      } else if (payload.type === 'assistant' && block.type === 'text' && text) {
        next = {
          ...next,
          detail: snippet(text),
          updatedAt: now,
          history: appendSubagentHistory(next.history, {
            id: `${subagentId}:say:${now}:${next.history?.length ?? 0}`,
            label: next.label,
            text,
            timestamp: now,
          }),
        }
      } else if (payload.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string') {
        const input = isRecord(block.input) ? block.input : undefined
        const inputDetail = typeof input?.command === 'string'
          ? input.command
          : typeof input?.file_path === 'string'
            ? input.file_path
            : typeof input?.query === 'string' ? input.query : ''
        next = {
          ...next,
          detail: snippet(`${block.name} ${inputDetail}`.trim()),
          updatedAt: now,
          history: appendSubagentHistory(next.history, {
            id: `${subagentId}:tool:${now}:${next.history?.length ?? 0}`,
            label: block.name,
            text: snippet(inputDetail) || block.name,
            timestamp: now,
          }),
        }
      }
    }

    if (next === previous) return
    activeSubagentsRef.current = { ...activeSubagentsRef.current, [subagentId]: next }
    setActiveSubagents(Object.values(activeSubagentsRef.current).sort((a, b) => a.updatedAt - b.updatedAt))
  }

  function updateSubagentResult(turnId: string, result: { toolUseId: string; output: string; isError: boolean }) {
    const subagentId = turnSubagentToolIds.current[turnId]?.[result.toolUseId]
    if (!subagentId) return
    const previous = activeSubagentsRef.current[subagentId]
    if (!previous) return

    const now = Date.now()
    const text = snippet(result.output) || (result.isError ? t('subagent.failed') : t('subagent.completed'))
    const status: ActiveSubagent['status'] = result.isError ? 'failed' : 'done'
    const next: ActiveSubagent = {
      ...previous,
      status,
      detail: text,
      updatedAt: now,
      history: appendSubagentHistory(previous.history, {
        id: `${subagentId}:result:${now}`,
        label: result.isError ? t('subagent.failed') : t('subagent.completed'),
        text,
        timestamp: now,
      }),
    }

    activeSubagentsRef.current = {
      ...activeSubagentsRef.current,
      [subagentId]: next,
    }
    setActiveSubagents(Object.values(activeSubagentsRef.current).sort((a, b) => a.updatedAt - b.updatedAt))
    autoSelectSubagent(subagentId)
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

    if (activity.toolUseId) {
      const map = turnSubagentToolIds.current[turnId] ?? {}
      map[activity.toolUseId] = id
      turnSubagentToolIds.current[turnId] = map
    }

    const now = Date.now()
    const mission = previous?.mission ?? activity.detail ?? t('subagent.readOnlyBeforeTurn')
    const history = appendSubagentHistory(
      previous?.history ?? (activity.detail ? [{
        id: `${id}:mission:${now}`,
        label: t('subagent.missionReceived'),
        text: activity.detail,
        timestamp: now,
      }] : undefined),
      {
        id: `${id}:activity:${now}`,
        label: activityDisplayLabel(activity, t),
        text: activity.detail || compactSubagentDetail(activity, t),
        timestamp: now,
      },
    )

    const next = {
      id,
      label: previous?.label ?? subagentNameFor(identity, Object.keys(activeSubagentsRef.current).length),
      detail: compactSubagentDetail(activity, t),
      mission,
      history,
      status: subagentStatusForActivity(activity),
      updatedAt: now,
    }
    activeSubagentsRef.current = {
      ...activeSubagentsRef.current,
      [id]: next,
    }
    setActiveSubagents(Object.values(activeSubagentsRef.current).sort((a, b) => a.updatedAt - b.updatedAt))
    autoSelectSubagent(id)
  }

  function updateResearchSubagentProgress(progress: ResearchSubagentProgress) {
    const previous = activeSubagentsRef.current[progress.id]
    const now = Date.now()
    const status = subagentStatusForResearchProgress(progress)
    const label = progress.label
      ?? previous?.label
      ?? subagentNameFor(`${progress.runId ?? progress.id}:${progress.index}`, progress.index - 1)
    const mission = progress.mission ?? previous?.mission ?? progress.summary ?? t('subagent.defaultMission')
    const detail = progress.detail ?? progress.activity ?? progress.summary ?? previous?.detail
    const next: ActiveSubagent = {
      ...(previous ?? {}),
      id: progress.id,
      runId: progress.runId ?? previous?.runId,
      label,
      mission,
      detail,
      status,
      updatedAt: now,
      history: appendSubagentHistory(previous?.history, {
        id: `${progress.id}:${progress.status}:${now}`,
        label: subagentStatusLabel(status, t),
        text: detail || mission,
        timestamp: now,
      }),
    }

    activeSubagentsRef.current = {
      ...activeSubagentsRef.current,
      [progress.id]: next,
    }
    pendingResearchSubagentsRef.current = pendingResearchSubagentsRef.current.map(agent =>
      agent.id === progress.id ? next : agent,
    )
    setActiveSubagents(Object.values(activeSubagentsRef.current).sort((a, b) => a.updatedAt - b.updatedAt))
    autoSelectSubagent(progress.id)
  }

  function attachPendingResearchSubagents(turnId: string) {
    if (pendingResearchSubagentsRef.current.length === 0) return
    const pending = pendingResearchSubagentsRef.current
    const selectedIndex = selectedSubagentId
      ? Math.max(0, pending.findIndex(agent => agent.id === selectedSubagentId))
      : 0
    const attached = pending.map((agent, index) => ({
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
    setSelectedSubagentId(attached[selectedIndex]?.id)
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
    delete turnTokenRates.current[turnId]
    delete turnLiveRates.current[turnId]
    delete turnQuestions.current[turnId]
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
    delete turnToolUseItemIds.current[turnId]
    delete turnSubagentToolIds.current[turnId]
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

  function workingDirectoryForConversation(conversationId: string): string {
    const conversation = chatStore.conversations.find(item => item.id === conversationId)
    const conversationProject = conversation?.projectId
      ? chatStore.projects.find(item => item.id === conversation.projectId)
      : undefined
    const selectedProject = selectedProjectId
      ? chatStore.projects.find(item => item.id === selectedProjectId && !item.archivedAt)
      : undefined
    const wd = firstUsableWorkspaceDirectory(
      conversationProject?.path,
      selectedProject?.path,
      activeProject?.path,
      config.workingDirectory,
    )
    // When no project is open, fall back to the host's default working
    // directory (e.g. $HOME) instead of sending an empty string.
    return wd || defaultWorkingDirectoryRef.current || ''
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
    contextUsage: effectiveContextUsage,
    authMethod: cliAuth.authMethod,
    cliLoggedIn: cliAuth.loggedIn,
    hasApiKey: credentials.hasApiKey,
  }), [
    accessMode,
    activeView,
    cliAuth.authMethod,
    cliAuth.loggedIn,
    effectiveContextUsage,
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
      contextUsage: effectiveContextUsage?.percentage,
      workingDirectory: currentWorkspaceDirectory,
      loggedIn: cliAuth.loggedIn || credentials.hasApiKey,
      email: cliAuth.email ?? profile.user?.email,
    }
    menuBarStateRef.current = state
    void window.verboo.updateMenuBar(state)
  }, [
    currentWorkspaceDirectory,
    workingSubagents.length,
    cliAuth.email,
    cliAuth.loggedIn,
    effectiveContextUsage?.percentage,
    credentials.hasApiKey,
    profile.user?.email,
    runningTurnId,
    selectedContextWindow,
    selectedModel,
    selectedModelInfo?.displayName,
  ])

  // Heartbeat: query the Rust tray state every 2.5s so the tray self-corrects
  // if an async updateMenuBar landed out of order (the stuck counter bug — a
  // lagging 'thinking' arriving after 'idle' froze the tray). We do NOT re-push
  // menuBarStateRef here anymore — re-pushing a stale ref was the root cause of
  // the "timer never stops" bug (a completed turn's ref could still hold
  // execution:'thinking' and the heartbeat would resurrect it). Rust is the
  // source of truth; if the state has been active for >5min without a renderer
  // push, Rust auto-resets to idle.
  useEffect(() => {
    const id = window.setInterval(() => {
      void window.verboo.heartbeatMenuBar()
    }, 2500)
    return () => window.clearInterval(id)
  }, [])

  // Reserve exactly the composer's real height at the bottom of the scroll
  // lane so the last message never slides under the fixed composer dock. The
  // dock height varies (multi-line input, attachments, queued-message banner),
  // so a static `--composer-clearance` left content hidden underneath. Measure
  // it live and drive the CSS var. (dock sits at bottom:16 + a ~24px gap.)
  useEffect(() => {
    if (shouldShowLogin) return
    const dock = document.querySelector<HTMLElement>('.bottom-dock')
    if (!dock) return
    const apply = () => {
      document.documentElement.style.setProperty(
        '--composer-clearance',
        `${dock.offsetHeight + 40}px`,
      )
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(dock)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--composer-clearance')
    }
  }, [shouldShowLogin, activeView, hasConversation])

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
        onToggleSidebar={toggleSidebarVisibility}
        terminalOpen={terminal.terminalOpen}
        terminalUnavailableReason={terminal.terminalUnavailableReason}
        onToggleTerminal={() => handleToggleTerminal(workspaceDirectory || '')}
        reviewOpen={review.reviewOpen}
        reviewUnavailableReason={reviewUnavailableReason}
        onToggleReview={handleToggleReview}
      />

      <div
        className={`app-layout sidebar-${sidebarMode} ${sidebarPeek ? 'sidebar-peek' : ''} ${activeView === 'settings' ? 'settings-open' : ''} ${activeView === 'settings' || activeView === 'profile' ? 'view-fullscreen' : ''} ${terminal.terminalOpen ? 'terminal-open' : ''} ${review.reviewOpen ? 'review-open' : ''}`}
      >
        {activeView !== 'settings' && activeView !== 'profile' && sidebarMode === 'hidden' && !sidebarPeek && !sidebarPeekLeaving && (
          // Rail: thin hit-area on the left edge. Hover/focus expands the
          // sidebar transiently (peek) without persisting. Tab-focusable so
          // keyboard users can open it without a pointer. Hidden while the
          // peek leave fade plays so the rail doesn't pop in mid-animation.
          <button
            type="button"
            className="sidebar-rail"
            aria-label={t('topbar.showSidebar')}
            aria-expanded={false}
            onMouseEnter={showSidebarPeek}
            onFocus={showSidebarPeek}
            onMouseLeave={() => {
              // Clear suppress only after the pointer actually leaves the rail
              // area. This is the gate that re-enables peek: the suppress flag
              // was armed when the leave fade finished (shell unmounted under
              // cursor). Without this, the sidebar would never re-open on a
              // subsequent hover because suppress would stay true forever.
              peekSuppressUntilPointerLeft.current = false
              scheduleHideSidebarPeek()
            }}
            onClick={pinSidebar}
          />
        )}

        {activeView !== 'settings' && activeView !== 'profile' && (sidebarMode !== 'hidden' || sidebarPeek || sidebarPeekLeaving) && (
          <div
            className={`sidebar-shell ${sidebarPeek && !sidebarPeekLeaving ? 'is-peek' : ''} ${sidebarPeekLeaving && !sidebarPeek ? 'is-peek-leaving' : ''}`}
            onMouseEnter={sidebarPeek || sidebarPeekLeaving ? showSidebarPeek : undefined}
            onMouseLeave={sidebarPeek || sidebarPeekLeaving ? scheduleHideSidebarPeek : undefined}
          >
            <AppSidebar
              activeView={activeView}
              projects={shownProjects}
              conversations={shownConversations}
              activeConversationId={activeConversationId}
              selectedProjectId={selectedProjectId}
              runningConversationIds={runningConversations}
              profile={profile}
              cliAuth={cliAuth}
              avatarSettings={userSettings.avatar}
              compact={sidebarMode === 'compact'}
              peek={sidebarPeek || sidebarPeekLeaving}
              onSelectView={setActiveView}
              onOpenSettings={() => {
                setSettingsTab('permissions')
                setActiveView('settings')
              }}
              onOpenSearch={() => setPaletteOpen(true)}
              onOpenFeedback={() => setFeedbackOpen(true)}
              onLogout={logout}
              onNewChat={newChat}
              onToggleSidebar={toggleSidebarVisibility}
              onPinSidebar={pinSidebar}
              onOpenProject={openProjectFolder}
              onSelectConversation={selectConversation}
              onToggleProject={toggleProject}
              onRenameProject={renameProject}
              onArchiveProject={archiveProject}
              onDeleteProject={deleteProject}
              onArchiveConversation={archiveConversation}
              onDeleteConversation={deleteConversation}
              onRenameConversation={renameConversation}
            />
            {sidebarMode !== 'compact' && !sidebarPeek && (
              <div
                className="sidebar-resizer"
                role="separator"
                aria-orientation="vertical"
                title={t('workspace.resizeSidebar')}
                onPointerDown={startSidebarResize}
                onDoubleClick={toggleSidebarCompact}
              />
            )}
          </div>
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
              avatarSettings={userSettings.avatar}
              onRefresh={refreshProfile}
              onManagePlan={() => window.verboo.openSubscriptions()}
              onUpdateAvatar={avatar => updateUserSettings({ avatar })}
              onClose={() => setActiveView('chat')}
            />
          ) : activeView === 'plugins' ? (
            <PluginsView
              onClose={() => setActiveView('chat')}
              loadIcons={userSettings.loadWebIcons}
              onUsePlugin={(payload) => {
                setActiveView('chat')
                const { pluginId, pluginName, suggestion } = payload

                // ITEM B: sempre insere @token do payload (sem async).
                const token = `@${pluginName}`
                const extra = suggestion ? ` ${suggestion}` : ''
                if (!composerValue?.trim()) {
                  setComposerValue(`${token}${extra}`.trim())
                } else {
                  setComposerValue(`${token} ${composerValue}`)
                }

                // Optimistic mention entry — paint highlight instantly.
                setPluginSkillSummaries(current => {
                  if (current.some(s => s.id === `plugin-mention:${pluginId}`)) return current
                  return [...current, {
                    id: `plugin-mention:${pluginId}`,
                    name: pluginName,
                    description: '',
                    path: '',
                    source: 'managed',
                    trusted: true,
                    pluginId,
                    pluginName,
                    isPluginMention: true,
                  } satisfies SkillSummary]
                })

                requestAnimationFrame(() => {
                  window.dispatchEvent(new CustomEvent('verboo:focus-composer'))
                })
              }}
              onSeedComposer={(text: string) => {
                setComposerValue(text)
                setActiveView('chat')
                // Focus the composer after the view switch commits. rAF
                // ensures the textarea is mounted before we dispatch.
                requestAnimationFrame(() => {
                  window.dispatchEvent(new CustomEvent('verboo:focus-composer'))
                })
              }}
            />
          ) : activeView === 'settings' ? (
            <SettingsView
              credentials={credentials}
              modelResult={modelResult}
              selectedModel={selectedModelInfo}
              theme={theme}
              activeTab={settingsTab}
              userSettings={userSettings}
              petEnabled={petEnabled}
              petSize={petSize}
              workingDirectory={currentWorkspaceDirectory}
              onPetToggle={togglePet}
              onPetSizeChange={updatePetSize}
              archivedConversations={archivedChats}
              onOpenDashboard={() => window.verboo.openDashboard()}
              onSaveApiKey={async apiKey => {
                await saveApiKey(apiKey)
              }}
              onThemeChange={setTheme}
              onActiveTabChange={setSettingsTab}
              onUserSettingsChange={updateUserSettings}
              onResetUserSettings={resetUserSettings}
              onRestoreConversation={restoreConversation}
              onDeleteConversation={deleteConversation}
              updateSnapshot={updateSnapshot}
              onCheckForUpdates={onCheckForUpdates}
              onDownloadUpdate={onDownloadUpdate}
              onInstallUpdate={onInstallUpdate}
              onClose={() => setActiveView('chat')}
            />
          ) : hasConversation ? (
            <>
              <Transcript
                // Filter out queued activity items — they live in the composer panel now.
                items={items.filter(i => i.activityKind !== 'queued')}
                conversationId={activeConversationId}
                onOpenReview={handleOpenReview}
                reviewMetadata={reviewMetadata}
                thinkingTurnId={thinkingTurnId}
                thinkingSnippets={thinkingSnippets}
                compactingTurnId={compactingTurnId}
                compactedTurnIds={compactedTurnIds}
                imageReadingTurnId={imageReadingTurnId}
                onEditSent={editSentMessage}
                onUserExpand={handleUserExpand}
              />
              <div ref={transcriptEndRef} className="transcript-end" />
            </>
          ) : (
            <EmptyChat hasProject={Boolean(activeProject?.name)} projectName={projectName} line={emptyLine} />
          )}
        </section>
        {showSubagentThreadPanel && selectedSubagent && (
          <ResearchSubagentPanel
            agent={selectedSubagent}
            onClose={() => {
              subagentPanelDismissed.current = true
              setSelectedSubagentId(undefined)
            }}
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
          metadata={reviewMetadata}
          branchInfo={branchInfo}
          includeVerbooCoAuthor={userSettings.includeVerbooCoAuthor}
        />
      </div>
      {(() => {
        // GoalStatusBar only renders when GoalActivePanel is NOT visible.
        // Panel covers: active | evaluating | continuing | paused.
        // StatusBar covers: completed (toast) + cancelled/cleared (brief feedback).
        // This prevents duplicate UI when goal is paused (panel shows paused+reason,
        // status bar would show stopped+reason — only panel should show).
        const panelVisible = !!goal && goal.status !== 'completed' && goal.status !== 'blocked' && goal.status !== 'cancelled'
        if (panelVisible) return null
        return (
          <GoalStatusBar
            status={goalBarStatus}
            onPause={() => handleGoalCommand({ kind: 'goal', action: 'pause', raw: '/goal pause' })}
            onResume={() => handleGoalCommand({ kind: 'goal', action: 'resume', raw: '/goal resume' })}
            onCancel={() => handleGoalCommand({ kind: 'goal', action: 'clear', raw: '/goal clear' })}
            onClear={() => handleGoalCommand({ kind: 'goal', action: 'clear', raw: '/goal clear' })}
          />
        )
      })()}

      {activeView === 'chat' && (
        <div className={`bottom-dock ${hasConversation ? '' : 'empty-mode'}`}>
          {runningConversations.size >= 2 && !performanceWarningDismissed && (
            <div className="performance-warning-banner">
              <span>{t('performance.multiChatWarning')}</span>
              <button
                type="button"
                className="performance-warning-dismiss"
                onClick={() => setPerformanceWarningDismissed(true)}
                aria-label={t('common.close')}
              >
                ×
              </button>
            </div>
          )}
          {showSubagentSummary && (
            <SubagentSummaryCard
              agents={workingSubagents}
              expanded={subagentSummaryExpanded}
              selectedAgentId={selectedSubagentId}
              onToggleExpanded={() => setSubagentSummaryExpanded(current => !current)}
              onSelectAgent={agentId => {
                subagentPanelDismissed.current = false
                setSelectedSubagentId(current => (current === agentId ? undefined : agentId))
              }}
            />
          )}
          {showJumpToLatest && hasConversation && (
            <button className="jump-to-latest" type="button" onClick={() => scrollToLatest('smooth')} title={t('workspace.jumpToLatest')}>
              <ArrowDown size={17} />
            </button>
          )}
          {(goal && goal.status !== 'completed' && goal.status !== 'blocked' && goal.status !== 'cancelled') || (questionPrompt && questionPrompt.conversationId === activeConversationId) ? (
            <div className="composer-aux-stack" role="region" aria-label={t('goal.auxStackLabel')}>
              {goal && goal.status !== 'completed' && goal.status !== 'blocked' && goal.status !== 'cancelled' && (
                <GoalActivePanel
                  goal={goal}
                  turnInProgress={activeConversationId ? runningConversations.has(activeConversationId) : false}
                  compact={!!(questionPrompt && questionPrompt.conversationId === activeConversationId && questionWizardOpen)}
                  onEditObjective={handleEditObjective}
                  onPause={() => handleGoalCommand({ kind: 'goal', action: 'pause', raw: '/goal pause' })}
                  onResume={() => handleGoalCommand({ kind: 'goal', action: 'resume', raw: '/goal resume' })}
                  onCancel={() => handleGoalCommand({ kind: 'goal', action: 'clear', raw: '/goal clear' })}
                />
              )}
              {questionPrompt && questionPrompt.conversationId === activeConversationId && (
                questionWizardOpen ? (
                  <QuestionWizard
                    prompt={questionPrompt}
                    onAnswersChange={answers => {
                      if (questionPromptRef.current) {
                        questionPromptRef.current = { ...questionPromptRef.current, answers }
                      }
                      setQuestionPrompt(current => current ? { ...current, answers } : current)
                    }}
                    onSubmit={() => { void submitQuestionAnswers() }}
                    onDismiss={() => setQuestionWizardOpen(false)}
                  />
                ) : (
                  <div className="question-chip-container">
                    <button type="button" className="question-chip" onClick={() => setQuestionWizardOpen(true)}>
                      <MessageCircleQuestion size={15} aria-hidden="true" />
                      {questionPrompt.questions.length === 1
                        ? t('questions.chipOne')
                        : t('questions.chip', { count: questionPrompt.questions.length })}
                    </button>
                    <button
                      type="button"
                      className="question-chip-close"
                      onClick={() => {
                        questionPromptRef.current = undefined
                        setQuestionPrompt(undefined)
                        setQuestionWizardOpen(false)
                      }}
                      aria-label={t('questions.dismiss')}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )
              )}
            </div>
          ) : null}
          {visiblePermissionPrompt && (
            <PermissionApprovalPanel
              prompt={visiblePermissionPrompt}
              onAllow={() => respondToPermissionPrompt(visiblePermissionPrompt, 'allow')}
              onDeny={() => respondToPermissionPrompt(visiblePermissionPrompt, 'deny')}
              onAlwaysAllow={() => respondToPermissionPrompt(visiblePermissionPrompt, 'always')}
            />
          )}
          {visionFallbackState && visionFallbackResolveRef.current && (
            <VisionFallbackModal
              state={visionFallbackState}
              onRespond={choice => {
                visionFallbackResolveRef.current?.(choice)
              }}
            />
          )}
          {pendingSkillApproval && skillApprovalResolveRef.current && (
            <SkillApprovalPanel
              skills={pendingSkillApproval}
              onRespond={choice => {
                skillApprovalResolveRef.current?.(choice)
              }}
            />
          )}
          <Composer
            disabled={false}
            workingDirectory={config.workingDirectory}
            skills={mentionableSkills}
            customSlashCommands={userSettings.customSlashCommands}
            tokenSkills={tokenSkills}
            onTokenSkillsChange={setTokenSkills}
            attachments={attachedFiles}
            ocrProcessingPaths={ocrProcessingPaths}
            onAttachFiles={attachFiles}
            onDropFiles={attachDroppedFiles}
            onPasteFiles={attachPastedFiles}
            onRemoveAttachment={path => {
              setAttachedFiles(current => current.filter(item => item.path !== path))
              setOcrProcessingPaths(current => current.filter(p => p !== path))
            }}
            onSubmit={sendMessage}
            onGoalCommand={handleGoalCommand}
            queue={queuedFollowUpsRef.current}
            onQueueSendNow={queueItemId => sendNow(activeConversationId ?? '', queueItemId)}
            onQueueEdit={editQueuedItem}
            onQueueRemove={removeQueuedItem}
            onPetCommand={togglePet}
            onCompactCommand={handleCompactCommand}
            value={composerValue}
            onValueChange={setComposerValue}
            busy={activeConversationId ? runningConversations.has(activeConversationId) : false}
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
                <TokenRateMeter rate={tokenRate} active={Boolean(runningTurnId)} />
                <ModelSelector
                  models={modelResult.models}
                  selectedModel={selectedModel}
                  hasConversationHistory={hasConversation}
                  modelResult={modelResult}
                  onSelect={handleModelSelect}
                  onRefresh={() => refreshModels(true)}
                  effortByModel={effortByModel}
                  selectedEffortLevels={selectedEffortLevels}
                  selectedEffort={displayEffortValue}
                  onSelectEffort={handleEffortSelect}
                  onClearEffortOverride={handleClearEffortOverride}
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

      {updateSnapshot && updateSnapshot.status === 'available'
        && updateSnapshot.availableVersion
        && updateSnapshot.availableVersion !== dismissedVersion
        && (
          <UpdateBanner
            snapshot={updateSnapshot}
            onDownload={() => { void onDownloadUpdate() }}
            onDismiss={() => setDismissedVersion(updateSnapshot.availableVersion)}
          />
        )}
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

/** Extract ModelReasoning from the promoted field or raw router payload.
 *  When Geralt eventually promotes reasoning on the Rust VerbooModel,
 *  the `model.reasoning` branch fires first; meanwhile raw fallback works. */
function getModelReasoning(model: VerbooModel): ModelReasoning | undefined {
  if (model.reasoning) return model.reasoning
  const r = model.raw
  if (r && typeof r === 'object' && 'reasoning' in r) {
    const reas = (r as Record<string, unknown>).reasoning
    if (reas && typeof reas === 'object') return reas as ModelReasoning
  }
  return undefined
}

function readEffortByModel(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(EFFORT_BY_MODEL_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function readReportedContextWindows(): Record<string, number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REPORTED_CONTEXT_WINDOWS_KEY) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0),
    ) as Record<string, number>
  } catch {
    return {}
  }
}

function persistReportedContextWindows(windows: Record<string, number>): void {
  try {
    window.localStorage.setItem(REPORTED_CONTEXT_WINDOWS_KEY, JSON.stringify(windows))
  } catch {
    // best-effort cache; the next result event repopulates it
  }
}

/// Pulls per-model `contextWindow` out of a result payload's `modelUsage`
/// map — the only place the Verboo Router reveals the window size (model
/// discovery omits it and usage objects arrive all-zero).
function extractReportedContextWindows(payload: unknown): Record<string, number> | undefined {
  if (!isRecord(payload) || payload.type !== 'result' || !isRecord(payload.modelUsage)) return undefined
  const windows: Record<string, number> = {}
  for (const [model, value] of Object.entries(payload.modelUsage)) {
    if (!isRecord(value)) continue
    const win = numberValueOptional(value.contextWindow)
    if (win !== undefined && win > 0) windows[model] = win
  }
  return Object.keys(windows).length > 0 ? windows : undefined
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

function subagentStatusForResearchProgress(progress: ResearchSubagentProgress): ActiveSubagent['status'] {
  if (progress.status === 'complete') return 'done'
  if (progress.status === 'failed') return 'failed'
  if (progress.status === 'reading') return 'reading'
  if (progress.status === 'searching') return 'searching'

  const text = `${progress.summary} ${progress.activity ?? ''} ${progress.detail ?? ''}`.toLowerCase()
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

function extractContextUsage(payload: unknown, maxTokens?: number): ContextUsageSnapshot | undefined {
  // Prefer the CLI's pre-calculated context_window object when available.
  // This is the authoritative source — the CLI accounts for its own context
  // management (system prompt, output reservation, compaction) which the
  // raw API usage tokens don't reflect. Using the CLI's numbers ensures the
  // meter matches what the CLI itself displays.
  const ctxWindow = extractContextWindowObject(payload)
  if (ctxWindow) {
    const cliUsedPercentage = numberValueOptional(ctxWindow.used_percentage)
    const cliWindowSize = numberValueOptional(ctxWindow.context_window_size)
    const cliTotalInput = numberValueOptional(ctxWindow.total_input_tokens)
    const cliTotalOutput = numberValueOptional(ctxWindow.total_output_tokens)
    const effectiveMax = cliWindowSize ?? maxTokens
    // If the CLI gives us a used_percentage (0-100), use it directly.
    // BUT: return undefined when the CLI sends early zeros (before any tokens
    // have actually been used) so the frontend's estimate is not overwritten.
    if (cliUsedPercentage !== undefined) {
      const valid = cliUsedPercentage > 0 || (cliTotalInput !== undefined && cliTotalInput > 0)
      if (!valid) return undefined
      const percentage = Math.max(0, Math.min(1, cliUsedPercentage / 100))
      const usedTokens = effectiveMax
        ? Math.round(percentage * effectiveMax)
        : cliTotalInput ?? 0
      return {
        usedTokens,
        maxTokens: effectiveMax,
        percentage,
        inputTokens: cliTotalInput,
        outputTokens: cliTotalOutput,
        source: 'cli-usage',
        updatedAt: Date.now(),
      }
    }
    // If the CLI gives us total_input_tokens + context_window_size, compute
    // from those (more accurate than raw API usage because the CLI tracks
    // cumulative input across the whole conversation).
    if (cliTotalInput !== undefined && effectiveMax !== undefined && effectiveMax > 0) {
      const percentage = Math.max(0, Math.min(1, cliTotalInput / effectiveMax))
      return {
        usedTokens: cliTotalInput,
        maxTokens: effectiveMax,
        percentage,
        inputTokens: cliTotalInput,
        outputTokens: cliTotalOutput,
        source: 'cli-usage',
        updatedAt: Date.now(),
      }
    }
  }

  // Fallback: compute from raw API usage tokens (input + cache).
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

/// Extracts the CLI's `context_window` object from a stream-json payload.
/// The CLI emits this with pre-calculated `used_percentage`,
/// `remaining_percentage`, `context_window_size`, `total_input_tokens`,
/// and `total_output_tokens`. This is the authoritative context usage.
function extractContextWindowObject(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined
  if (isRecord(payload.context_window)) return payload.context_window
  if (payload.type === 'stream_event' && isRecord(payload.event)) {
    if (isRecord(payload.event.context_window)) return payload.event.context_window
  }
  return undefined
}

function extractTokenUsage(payload: unknown): TokenUsage | undefined {
  const usage = extractUsageObject(payload)
  if (!usage) return undefined

  const inputTokens = numberValue(usage.input_tokens)
  const outputTokens = numberValue(usage.output_tokens)
  const cacheCreationTokens = numberValue(usage.cache_creation_input_tokens)
  const cacheReadTokens = numberValue(usage.cache_read_input_tokens)

  if (
    inputTokens === undefined
    && outputTokens === undefined
    && cacheCreationTokens === undefined
    && cacheReadTokens === undefined
  ) {
    return undefined
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
  }
}

// Streamed content of a delta — assistant text, thinking, or tool-call JSON.
// All three consume output tokens: measured against real usage, counting all
// of them lands at ~0.31 tokens/char, while ignoring the tool JSON undercounts
// tool-heavy phases by 30-50%.
function streamDeltaText(payload: unknown): string | undefined {
  if (!isRecord(payload) || payload.type !== 'stream_event' || !isRecord(payload.event)) return undefined
  const delta = isRecord(payload.event.delta) ? payload.event.delta : undefined
  if (!delta) return undefined
  if (delta.type === 'text_delta' && typeof delta.text === 'string') return delta.text
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') return delta.thinking
  if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') return delta.partial_json
  return undefined
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

// Strip non-essential fields from AttachmentMeta before persisting in a
// TranscriptItem. Keeps path/name/kind (enough for chips + thumbnails) and
// drops extractedText/extractionStatus which can be re-derived on re-attach.
function slimMeta(a: AttachmentMeta): Pick<AttachmentMeta, 'path' | 'name' | 'kind' | 'size' | 'mediaType'> {
  return { path: a.path, name: a.name, kind: a.kind, size: a.size, mediaType: a.mediaType }
}

function cleanCliFailureLine(line: string): string {
  return line.replace(/\x1B\[[0-9;]*m/g, '').trim()
}

// Truncate tool_result output before persisting it on a TranscriptItem. Keeps
// the store small while preserving the most useful part (head of the output,
// where the signal is). ANSI escape sequences are stripped first (same regex
// as chatStore.stripTerminalControl) so the rendered detail is clean text.
const TOOL_OUTPUT_MAX = 2000
const TOOL_OUTPUT_MAX_ERROR = 3200
function truncateToolOutput(output: string, isError: boolean): string {
  const cleaned = output.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').replace(/\u001b/g, '')
  const trimmed = cleaned.trim()
  const max = isError ? TOOL_OUTPUT_MAX_ERROR : TOOL_OUTPUT_MAX
  if (trimmed.length <= max) return trimmed
  const head = trimmed.slice(0, max)
  const omitted = trimmed.length - max
  return `${head}\n\n[… ${omitted} more characters truncated]`
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

/// Like `numberValue` but returns `undefined` for missing/non-number fields.
/// Used in fallback chains where we need to distinguish "field present" from
/// "field absent" (e.g. context_window.used_percentage might be absent).
function numberValueOptional(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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
