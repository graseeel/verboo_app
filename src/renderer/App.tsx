import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, FolderClosed, X } from 'lucide-react'
import type {
  AccessMode,
  AgentEvent,
  AgentResultSnapshot,
  AgentTurnRequest,
  Annotation,
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
  GoalEvaluationEnvelope,
  GoalState,
  LanguageCode,
  MenuBarState,
  ModelDiscoveryResult,
  ProfileResult,
  ProviderAuthStatus,
  ResearchSubagentResult,
  RuntimeActivity,
  SettingsTab,
  SkillSummary,
  StoredConversation,
  ThemeMode,
  TokenRateSnapshot,
  TodoItem,
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
import { createGoalState, goalSystemMessage, resumeGoalSessionId, sanitizeStoredGoal, shouldResumeGoalOnUserMessage } from './features/goal/goalState'
// T3: context-usage extraction lives in features/context/contextUsage
// (moved out of this file verbatim) so the frontier signal (ii) is
// testable without importing the component tree.
import { extractContextUsage, extractUsageObject, isRecord, numberValue, numberValueOptional } from './features/context/contextUsage'
import { GoalStatusBar, type GoalStatusBarState } from './features/goal/GoalStatusBar'
import { GoalActivePanel } from './features/goal/GoalActivePanel'
import { useGoalPanelExit } from './features/goal/useGoalPanelExit'
import { buildGoalUsageLine, buildObjectiveUpdatedPrompt } from './features/goal/goalPrompt'
import { buildBatchReportLines } from './features/goal/goalReport'
import { parseBatchInput } from './features/goal/goalBatchParse'
import { AnnotationLayer } from './features/annotations/AnnotationLayer'
import { AnnotationOverlay } from './features/annotations/AnnotationOverlay'
import {
  addAnnotationDraft,
  consumeAnnotationDrafts,
  draftsForConversation,
  removeAnnotationDraft,
  updateAnnotationComment,
  type AnnotationDrafts,
} from './features/annotations/annotationDrafts'
import { SideChatSurface } from './features/sidechat/SideChatSurface'
import { findNotifiableConversationId } from './features/notifications/notificationFocus'
import {
  buildSideChatRequest,
  createSideChatState,
  resolveSideChatSessionId,
  resolveSideChatWorkingDirectory,
  shouldDiscardSideChatForNavigation,
  type SideChatState,
  updateSideChatState,
} from './features/sidechat/sideChat'
// F3: o ÚNICO ponto onde o campo annotations entra no request (nunca no texto)
// e o item N3 (o chip vira turno, autocontido). Montagem do bloco no prompt é
// Rust-side — aqui só viaja o campo estruturado.
import { applyAnnotations } from './features/annotations/annotationRequest'
import { annotationTurnItemId, buildAnnotationTurnItem, insertAnnotationTurnBeforeResponse } from './features/annotations/annotationTurnItem'
import { settleGoalTurnAfterSummary } from './features/goal/turnCompletion'
import { stampBatchProgressLine } from './features/goal/progressStamp'
import { runGoalCycle, type GoalSchedulerDelegate } from './features/goal/goalScheduler'
import { shouldAccumulateTokensForTurn, accumulateTurnUsage, accumulateEvaluatorUsage, shouldAccumulateEvaluatorUsage } from './features/goal/tokenAccumulator'
import { ChecklistPanel } from './features/checklist/ChecklistPanel'
import { useChecklistFlight } from './features/checklist/useChecklistFlight'
import { useChecklistCompletionExit } from './features/checklist/useChecklistCompletionExit'
import { applyTodoWrite, removeChecklistForConversation, resolveChecklistPlacement, type ChecklistCardPos, type ChecklistFormPreference } from './features/checklist/checklistPlacement'
import { readChecklistCardPos, readChecklistFormPreference, writeChecklistCardPos, writeChecklistFormPreference } from './features/checklist/checklistStorage'
import { registerRuntimeActivity } from './features/transcript/runtimeActivity'
import { createSoundPlayer, resolveSoundForEvent, type SoundEvent, type SoundPlayer } from './features/sound/sounds'
import { readSoundsEnabled, writeSoundsEnabled } from './features/sound/soundStorage'
import type { ReservedSlashCommand } from './features/composer/slashCommands'
import { AppSidebar, type AppView } from './components/AppSidebar'
import { CliBootstrapGate } from './components/CliBootstrapGate'
import { CommandPalette, paletteIcons, type PaletteAction } from './components/CommandPalette'
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog'
import { useToast } from './components/Toast'
import { VERBOO_PROVIDER, dedupModels, providerAccountName, providerDisplayName } from './features/models/providerCatalog'
import { VerbooPet, PET_MIN_SIZE, PET_MAX_SIZE, type PetState } from './features/pet/VerbooPet'
import { BrowserPanel } from './features/browser/BrowserPanel'
import { supportsEmbeddedBrowser } from './features/browser/browserAvailability'
import { browserLayoutWidth, browserMaxWidth, useBrowserPanel } from './features/browser/useBrowserPanel'
import { IosSimulatorPanel } from './features/simulator/IosSimulatorPanel'
import { useIosSimulatorPanel } from './features/simulator/useIosSimulatorPanel'
import { QuestionWizard, type ModelQuestion, type QuestionAnswer, type QuestionPromptState } from './features/questions/QuestionWizard'
import { detectTextQuestionPrompt, extractModelQuestionsFromPayload, mergeModelQuestions } from './features/questions/questionDetection'
import { MessageCircleQuestion } from 'lucide-react'
import { useLocalTerminal } from './features/terminal/useLocalTerminal'
import { LocalTerminalPanel } from './features/terminal/LocalTerminalPanel'
import { useWorkspacePanelSuspension, type WorkspacePanelKind } from './features/workspace/useWorkspacePanelSuspension'
import { useTheme } from './features/theme/useTheme'
import { ReviewPanel } from './features/review/ReviewPanel'
import { useReviewPanel } from './features/review/useReviewPanel'
import { EmptyChat } from './components/EmptyChat'
import { LoginScreen } from './components/LoginScreen'
import { TopBar } from './components/TopBar'
import { Transcript } from './components/Transcript'
import { AccessSelector } from './features/access/AccessSelector'
import { PermissionApprovalPanel, type PendingPermissionPrompt } from './features/permission/PermissionApprovalPanel'
import { VisionFallbackModal } from './features/vision/VisionFallbackModal'
import {
  DEFAULT_VIDEO_FALLBACK_CONSENT,
  shouldBlockVideoBeforeCli,
  VideoFallbackModal,
  type VideoFallbackResponse,
} from './features/video/VideoFallbackModal'
import { SkillApprovalPanel } from './features/skills/SkillApprovalPanel'
import type { ExtractionStatus, ModelReasoning, VideoProgress, VideoUnderstandingRoute, VisionFallbackConsent, VisionFallbackState } from '../shared/types'
import { recognizeImage } from './features/ocr/ocrService'
import { createVideoOcrCoordinator } from './features/video/VideoOcrCoordinator'
import { applyVideoProgress, clearVideoProgress } from './features/video/videoProgressState'
import { Composer } from './features/composer/Composer'
import { estimateTotalContextTokens } from './features/context/ContextPanel'
import { TokenRateMeter } from './features/context/TokenRateMeter'
import {
  isAuthenticationFailure,
  shouldAutoRecoverAuthentication,
  shouldRetryIncompleteTurn,
} from './features/transcript/cliFailureRecovery'
import { presentAgentError } from './features/transcript/agentErrorWiring'
import { quotaResetMessageFromRetry, shouldSuppressSystemErrorText } from './features/transcript/apiErrorPresentation'
import { truncateToolOutput } from './features/transcript/toolOutput'
import { applySubagentThreadUpdate, isSubagentThreadWorking, latestSubagentThread } from './features/subagents/subagentThreads'
import { SubagentIndicator } from './features/subagents/SubagentIndicator'
import { SubagentThreadPanel } from './features/subagents/SubagentThreadPanel'
import { FeedbackDialog } from './features/feedback/FeedbackDialog'
import { ProviderRiskDialog } from './features/settings/ProviderRiskDialog'
import { ModelSelector } from './features/models/ModelSelector'
import { validOverride, displayEffort, migrateEffortPrefs } from './features/models/effortOverride'
import { PluginsView } from './features/plugins/PluginsView'
import { loadPluginSkillSummaries } from './features/plugins/pluginSkillSummaries'
import { ProjectPicker } from './features/projects/ProjectPicker'
import { SettingsView } from './features/settings/SettingsView'
import { clearUpdateDraftHandoff, consumeUpdateDraftHandoff, writeUpdateDraftHandoff } from './features/updates/updateDraftHandoff'
import { useDeferredUpdateRestart } from './features/updates/useDeferredUpdateRestart'
import { useUpdateAutomation } from './features/updates/useUpdateAutomation'
import { I18nProvider, createTranslator, type Translator } from './i18n'
import { attachmentInspectionErrorKey } from './features/attachments/attachmentInspectionError'
import { OrderedAttachmentQueue } from './features/attachments/orderedAttachmentQueue'
import { uploadPastedFile } from './features/attachments/pastedFileUpload'
import { inspectPathlessFiles } from './features/attachments/pathlessAttachmentIngestion'
import {
  cleanupVisualCaptureOwners,
  deleteVisualCaptureOwner,
  deleteVisualTempFiles,
  expandVisualAttachmentSnapshots,
  isVisualAttachment,
  promoteVisualAttachments,
  visualTempPaths,
} from './features/attachments/visualAttachments'
import { findLocalBrowserUrl, postEditVerificationPrompt, shouldScheduleBrowserReload } from './features/browser/browserPostEdit'
import type { BrowserReloadRequest } from './features/browser/useBrowserPanel'
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
  updateConversation as updateConversationPure,
  visibleConversations,
} from './state/chatStore'
import { finishTurn, findNextRunnableQueueIndex, resolveEscapeConversation, startTurn } from './state/turnLifecycle'
import { promptForConversation } from './state/promptRouting'
import { installContextMenuGuard } from './features/window/contextMenuGuard'
import packageJson from '../../package.json'

const defaultModels: VerbooModel[] = []
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
    maxTurns: 4_294_967_295,
    maxElapsedMinutes: 4_294_967_295,
    allowAutoAccess: true,
  },
  updates: {
    channel: 'stable',
    autoCheck: true,
    autoDownload: false,
  },
  visionFallbackConsent: 'ask',
  videoFallbackConsent: DEFAULT_VIDEO_FALLBACK_CONSENT,
  trustedSkills: [],
  avatar: undefined,
  includeVerbooCoAuthor: false,
  browserVerificationEnabled: true,
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
  sideChat?: boolean
  turnModel: {
    modelId?: string
    modelDisplayName?: string
    provider?: string
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
  const [configLoaded, setConfigLoaded] = useState(false)
  const [credentials, setCredentials] = useState<CredentialStatus>({ hasApiKey: false })
  const [cliAuth, setCliAuth] = useState<CliAuthStatus>({ loggedIn: false })
  // F4: the login bridge universe (provider_auth_status) — one entry per
  // supported provider, connected=false included. Empty = unavailable; the
  // Integrations cards and the selector's dimmed groups degrade, nothing breaks.
  const [providerAuth, setProviderAuth] = useState<ProviderAuthStatus[]>([])
  const [connectingProvider, setConnectingProvider] = useState<string | undefined>(undefined)
  // Live stage of the active login flow, driven by provider-login:event —
  // feeds the card's progress button (field finding: the card said nothing).
  const [providerLoginStage, setProviderLoginStage] = useState<'starting' | 'awaiting_browser' | undefined>(undefined)
  // F4 risk_notice (claude): the Anthropic policy acceptance screen shown
  // before the browser flow — full notice text, owner decides.
  const [providerRiskNotice, setProviderRiskNotice] = useState<{ provider: string; message: string } | undefined>(undefined)
  const [profile, setProfile] = useState<ProfileResult>({ status: 'unauthenticated' })
  const [profileLoading, setProfileLoading] = useState(false)
  const [activeView, setActiveView] = useState<AppView>('chat')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('security')
  const [userSettings, setUserSettings] = useState<UserSettings>(DEFAULT_USER_SETTINGS)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [entryUnlocked, setEntryUnlocked] = useState(false)
  const [authChecking, setAuthChecking] = useState(true)
  const [authError, setAuthError] = useState<string | undefined>()
  // T5: raw cause of a rejected validateAccess, shown behind a
  // "Show technical details" toggle in the login warning. The friendly
  // headline lives in authError; this is the diagnostic, never bare on
  // the surface. A rejected Rust command (e.g. CLI spawn failed — no
  // Node installed, field photo M4) used to leave the promise pending
  // and "Verificando sessão local…" stuck forever.
  const [authErrorDetail, setAuthErrorDetail] = useState<string | undefined>()
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

  // T3 (field report, Windows): suppress the webview's NATIVE context menu on
  // empty chrome areas; editable elements and text selections keep it.
  useEffect(() => installContextMenuGuard(window), [])

  const [effortByModel, setEffortByModel] = useState<Record<string, string>>(
    () => readEffortByModel(),
  )
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot | undefined>(undefined)
  const [cliBootstrapSuccessVisible, setCliBootstrapSuccessVisible] = useState(false)
  const cliBootstrapInFlightRef = useRef(false)
  const cliBootstrapWasRequiredRef = useRef(false)
  const cliBootstrapSuccessTimerRef = useRef<number | undefined>(undefined)
  const [restoredUpdateDrafts] = useState(() => consumeUpdateDraftHandoff(window.localStorage))
  // Skills derived from / and @ tokens in the composer text. syncTokenSkills
  // (Composer) extracts both token types and sets this state. No parallel
  // chip state — user REJECTED chips (decided Feedback-3 ITEM 2a).
  const [tokenSkills, setTokenSkills] = useState<SkillSummary[]>([])
  const selectedSkillsUnion = tokenSkills
  const [attachedFiles, setAttachedFiles] = useState<AttachmentMeta[]>([])
  const attachmentQueueRef = useRef(new OrderedAttachmentQueue<AttachmentMeta>())
  const attachmentUploadControllersRef = useRef(new Set<AbortController>())
  const [ocrProcessingPaths, setOcrProcessingPaths] = useState<string[]>([])
  // Refs keyed by image path, resolved when OCR completes or fails.
  // Used by sendMessage to await pending OCR before sending.
  const ocrCompletionsRef = useRef<Record<string, { resolve: () => void; promise: Promise<void> }>>({})
  const [accessMode, setAccessMode] = useState<AccessMode>('approval')
  const [chatStore, setChatStore] = useState<ChatStore>(readChatStore)
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(() => {
    const restoredKey = restoredUpdateDrafts?.activeKey
    if (restoredKey === '__new__') return undefined
    if (restoredKey && visibleConversations(chatStore).some(conversation => conversation.id === restoredKey)) {
      return restoredKey
    }
    return visibleConversations(chatStore)[0]?.id
  })
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>()
  const [runningTurnByConversation, setRunningTurnByConversation] = useState<Record<string, string>>({})
  const runningTurnByConversationRef = useRef<Record<string, string>>({})
  const runningConversations = useMemo(() => new Set(Object.keys(runningTurnByConversation)), [runningTurnByConversation])
  const activeTurnId = activeConversationId ? runningTurnByConversation[activeConversationId] : undefined
  const anyRunningTurnId = Object.values(runningTurnByConversation)[0]
  const [performanceWarningDismissed, setPerformanceWarningDismissed] = useState(false)
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedFollowUp[]>([])
  // Per-conversation composer drafts (in-memory). Survives chat switches and
  // settings navigation so each chat keeps its own composer text.
  const composerDrafts = useRef<Record<string, string>>(restoredUpdateDrafts?.drafts ?? {})
  const [composerValue, setComposerValue] = useState(
    () => restoredUpdateDrafts?.drafts[activeConversationId ?? '__new__'] ?? '',
  )
  const prevConversationIdRef = useRef<string | undefined>(activeConversationId)
  // Annotation drafts (F1): per-conversation POSSE — a draft created in
  // conversation A belongs to A forever; switching chats never moves or loses
  // it. In-memory only (restart clears) — declared limit, drafts are ephemeral
  // by design. F1 scope: the chip READS this state to show the count and the
  // panel. NOTHING here touches the send path — sending annotations is F3,
  // with its own gate (official block assembly is Rust-side, per the Maestro).
  const [annotationDrafts, setAnnotationDrafts] = useState<AnnotationDrafts>({})
  // F3: sendMessage lê o retrato do clique por ESTE ref, não pelo state do
  // closure — criar a anotação e enviar podem cair no mesmo tick de render,
  // e o guarda não pode decidir com um state velho (nem deixar o envio
  // só-anotação morrer por um render de atraso).
  const annotationDraftsRef = useRef<AnnotationDrafts>({})
  const [sideChat, setSideChat] = useState<SideChatState | undefined>()
  const sideChatRef = useRef<SideChatState | undefined>(undefined)
  const focusedConversationIdRef = useRef<string | undefined>(undefined)
  const focusedConversationLaneRef = useRef<'main' | 'side' | undefined>(undefined)
  const [pendingPermissionPrompts, setPendingPermissionPrompts] = useState<Record<string, PendingPermissionPrompt>>({})
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | undefined>()
  const [questionPrompts, setQuestionPrompts] = useState<Record<string, QuestionPromptState>>({})
  const [questionWizardOpenByTurn, setQuestionWizardOpenByTurn] = useState<Record<string, boolean>>({})
  const questionPromptsRef = useRef<Record<string, QuestionPromptState>>({})

  // Vision fallback consent — deferred promise pattern like interject.
  // When set, the VisionFallbackModal is rendered as an overlay. The resolve
  // fn is called by the modal with the user's choice; awaiting code continues.
  const [visionFallbackState, setVisionFallbackState] = useState<VisionFallbackState | undefined>()
  const visionFallbackResolveRef = useRef<(value: { allowOnce: boolean } | { persist: VisionFallbackConsent }) => void>(undefined)

  const [videoFallbackRoute, setVideoFallbackRoute] = useState<VideoUnderstandingRoute | undefined>()
  const videoFallbackResolveRef = useRef<(value: VideoFallbackResponse) => void>(undefined)

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
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | undefined>()
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | undefined>()
  // Context windows the CLI itself reported via result.modelUsage — the Verboo
  // Router omits contextWindow from model discovery, so this is often the only
  // authoritative source. Persisted so the meter works from app launch.
  const [reportedContextWindows, setReportedContextWindows] = useState<Record<string, number>>(
    readReportedContextWindows,
  )
  const [goal, setGoal] = useState<GoalState | undefined>()
  // Genie exit: snapshot of the last live goal, exposed for ~280ms after
  // the goal turns terminal so the panel can sink back into the composer
  // instead of vanishing. See useGoalPanelExit for the honest limits.
  const { exitGoal } = useGoalPanelExit(goal)
  // T1-TodoWrite: the task checklist. Per-conversation TodoWrite lists
  // (POSSESSION — each entry belongs to its turn's OWNER conversation;
  // only the ACTIVE conversation's list renders). The list is NOT a
  // goal feature: it appears whenever the agent TodoWrites, goal or no
  // goal. REPLACE semantics per call — never accumulate (see
  // applyTodoWrite).
  const [todosByConversation, setTodosByConversation] = useState<Record<string, TodoItem[]>>({})
  // USER RULE 2: the form is the user's choice and persists — floating
  // card on the right, or docked above the composer (respecting the
  // goal-first hierarchy either way).
  const [checklistFormPref, setChecklistFormPref] = useState<ChecklistFormPreference>(readChecklistFormPreference)
  // Floating card's resting position; null = home corner. Persisted and
  // re-clamped into the window bounds by the panel (multiplatform rule).
  const [checklistCardPos, setChecklistCardPos] = useState<ChecklistCardPos | null>(readChecklistCardPos)
  /* TWO SOUNDS, EXACTLY TWO (user order, 2026-08-01 — "APENAS ISSO,
   * NADA MAIS"): a notification sound (permission/question waiting) and
   * a conclusion sound (turn or goal/batch completed). Synthesized with
   * Web Audio (autocontained, all three WebViews) — see features/sound.
   * The master switch persists renderer-side (localStorage: the bridge
   * settings contract is PERISCOPIO's) and the per-type notification prefs
   * gate each event — integrated with Settings → Notifications, not a
   * parallel system. */
  const [soundsEnabled, setSoundsEnabled] = useState(readSoundsEnabled)
  const soundsEnabledRef = useRef(soundsEnabled)
  const soundPlayerRef = useRef<SoundPlayer | null>(null)
  const playAppSound = (event: SoundEvent, conversationId: string | undefined) => {
    const settings = userSettingsRef.current
    const kind = resolveSoundForEvent(
      event,
      {
        soundsEnabled: soundsEnabledRef.current,
        completionNotifications: settings.completionNotifications,
        permissionNotifications: settings.permissionNotifications,
        questionNotifications: settings.questionNotifications,
      },
      {
        background:
          (conversationId !== undefined && conversationId !== activeConversationIdRef.current)
          || !document.hasFocus(),
      },
    )
    if (!kind) return
    soundPlayerRef.current ??= createSoundPlayer()
    soundPlayerRef.current.play(kind)
  }
  const [imageReadingTurnId, setImageReadingTurnId] = useState<string | undefined>()
  // Live video-analysis progress per turn. Explicit upsert keyed by turnId
  // (never routed through appendActivityItem, whose dedup is not an upsert
  // contract). Entries are deleted on done/error/cancel so the row vanishes.
  const [videoProgressByTurn, setVideoProgressByTurn] = useState<Record<string, VideoProgress>>({})
  // Dismissed state for the floating subagent chip: closing hides it for the
  // current conversation until a new thread arrives (key changes).
  const [dismissedSubagentKey, setDismissedSubagentKey] = useState<string | undefined>()
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
  const browser = useBrowserPanel()
  const simulator = useIosSimulatorPanel()
  const consumedSimulatorOpenRequestRef = useRef(0)
  const browserAvailable = configLoaded && supportsEmbeddedBrowser(config.platform)
  const simulatorAvailable = configLoaded && config.platform === 'darwin'
  const t = useMemo(() => createTranslator(userSettings.language), [userSettings.language])
  const [tokenRate, setTokenRate] = useState<TokenRateSnapshot | undefined>()
  const goalRef = useRef(goal)
  // G-C17: identity key for the evaluator-usage dedupe gate. Holds the
  // last GoalEvaluationEnvelope whose evaluatorUsage was accumulated
  // into the goal. evaluate_goal is a single invoke → single response,
  // so each envelope is presented once; the gate (tokenAccumulator.ts)
  // skips only a re-presentation of the SAME object. Reset per goal in
  // startGoalScheduler.
  const lastEvaluatorEnvelopeRef = useRef<GoalEvaluationEnvelope | undefined>(undefined)
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
  const turnModels = useRef<Record<string, { modelId?: string; modelDisplayName?: string; provider?: string }>>({})
  const pendingConversationId = useRef<string | undefined>(undefined)
  // Ref mirror of activeConversationId so the agent event handler (which has
  // a stale closure via useEffect []) can read the current value when a
  // turn completes — used to decide whether to fire a background notification.
  const activeConversationIdRef = useRef<string | undefined>(activeConversationId)
  const persistUpdateDrafts = useCallback(() => {
    const activeKey = activeConversationIdRef.current ?? '__new__'
    writeUpdateDraftHandoff(
      window.localStorage,
      { ...composerDrafts.current, [activeKey]: composerValue },
      activeKey,
    )
  }, [composerValue])
  const clearPersistedUpdateDrafts = useCallback(() => {
    clearUpdateDraftHandoff(window.localStorage)
  }, [])
  const goalSessionId = useRef<string | undefined>(undefined)
  const goalAbortRef = useRef<AbortController | undefined>(undefined)
  const queuedFollowUpsRef = useRef<QueuedFollowUp[]>([])
  const lastEscapeAt = useRef(0)
  const userInterruptedTurnsRef = useRef<Set<string>>(new Set())
  const quotaResetTurnsRef = useRef<Set<string>>(new Set())
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
  // T3: resolves when the frontier COMPACTION turn ends. The goal
  // scheduler's compactOnTaskBoundary awaits this before any frontier
  // state is reset (the reset NEVER happens before the compact
  // concludes). Resolved with `exitCode === 0` on done, `false` on
  // error/abort — a failed compaction never blocks the batch, but is
  // declared (compactionFailures). Separate from the deferreds above:
  // the compaction turn goes through runTurn, NOT continueGoal, and
  // must not touch the goal turn's completion deferred.
  const compactCompletionDeferred = useRef<{ turnId: string; resolve: (ok: boolean) => void } | undefined>(undefined)
  const turnThinkingText = useRef<Record<string, string>>({})
  const turnThinkingSnippets = useRef<Record<string, string[]>>({})
  const [thinkingSnippets, setThinkingSnippets] = useState<string[]>([])
  const turnAssistantText = useRef<Record<string, string>>({})
  // T17: when the CLI emits an assistant event flagged isApiErrorMessage, the
  // raw error text is also forwarded as stdout (turn_service.rs extract_text) —
  // the same bytes twice. The error event's handler (below) surfaces a readable
  // headline in the system row with the raw blob in the collapsed technical
  // detail toggle. If we also let the raw error land in the assistant body,
  // the user sees the same diagnostic twice. This ref holds the flagged text
  // for one-shot suppression in the stdout handler; it is consumed the moment
  // the matching stdout arrives and never blocks an unrelated delta.
  const turnApiErrorTextRef = useRef<Record<string, string>>({})
  // Result-event text announced via json payloads (see extractResultText) —
  // gates the stdout dedupe so only the exact re-emission is skipped, never
  // a repeated streaming delta.
  const turnResultEmittedText = useRef<Record<string, string>>({})
  const turnLastCommand = useRef<Record<string, string>>({})
  const turnCommands = useRef<Record<string, string[]>>({})
  const turnReferences = useRef<Record<string, string[]>>({})
  const turnChangeBaselines = useRef<Record<string, WorkspaceChangeSummary | undefined>>({})
  const turnWorkingDirectories = useRef<Record<string, string>>({})
  const turnTouchedFiles = useRef<Record<string, Set<string>>>({})
  const turnBrowserAnnotations = useRef<Record<string, AttachmentMeta[]>>({})
  const turnBrowserTempFiles = useRef<Record<string, string[]>>({})
  const pendingBrowserSnapshots = useRef<Record<string, AttachmentMeta[]>>({})
  /** One-shot recovery when CLI rejects a stale --resume session id. */
  const turnRetryPayload = useRef<Record<string, {
    conversationId: string
    message: string
    alreadyRetriedWithoutSession: boolean
    sideChat?: boolean
    // F3 (QA a-i): the retry must replay the SAME payload — annotations
    // included — or the retried turn silently loses the excerpts the user
    // attached on purpose (the worst class: invisible data loss).
    annotations?: Annotation[]
  }>>({})
  const autoApprovalSent = useRef<Set<string>>(new Set())
  const turnOpenTextSegment = useRef<Record<string, string | undefined>>({})
  const turnTextSegmentCount = useRef<Record<string, number>>({})
  const turnCommandItemIds = useRef<Record<string, Record<string, string>>>({})
  // tool_use_id → activity itemId, for ALL activity kinds (read/edit/search/etc).
  // Commands go into turnCommandItemIds (legacy); this map covers the rest so
  // extractToolResults can attach real output to their activity rows.
  const turnToolUseItemIds = useRef<Record<string, Record<string, string>>>({})
  const [thinkingTurnId, setThinkingTurnId] = useState<string | undefined>(undefined)
  // Live provider rate-limit retries per turn (system/api_retry payloads) —
  // the transcript says "retrying (N of M)" instead of a mute "Thinking…".
  const [apiRetryByTurn, setApiRetryByTurn] = useState<Record<string, { attempt: number; maxRetries: number }>>({})
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
  const visiblePermissionPrompt = promptForConversation(
    Object.values(pendingPermissionPrompts).filter(prompt => !prompt.autoApprove),
    activeConversationId,
  )
  const sidePermissionPrompt = promptForConversation(
    Object.values(pendingPermissionPrompts).filter(prompt => !prompt.autoApprove),
    sideChat?.conversation.id,
  )
  const mainQuestionPrompt = promptForConversation(Object.values(questionPrompts), activeConversationId)
  const sideQuestionPrompt = promptForConversation(Object.values(questionPrompts), sideChat?.conversation.id)
  const shouldShowLogin = !entryUnlocked
  // When peeking (hidden + hover), the sidebar column expands visually to
  // the user's last expanded width — but the persisted mode stays 'hidden'.
  // During the leave fade (sidebarPeekLeaving), the column collapses to 0
  // immediately (grid transition) while the shell floats (position:absolute)
  // to fade out on top. Expanding the grid ONLY when peek && !leaving avoids
  // the "ghost column" — an empty full-width column that appeared because the
  // grid stayed expanded while the shell had already faded.
  const sidebarVisualMode = sidebarMode === 'hidden' && sidebarPeek && !sidebarPeekLeaving ? 'expanded' : sidebarMode
  // The settings view does not render the sidebar —
  // collapse the column to 0 so the workspace takes the full grid width.
  const isFullscreenView = activeView === 'settings'
  const closeWorkspacePanels = useCallback(() => {
    terminal.close()
    review.close()
    browser.close()
    simulator.close()
  }, [browser.close, review.close, simulator.close, terminal.close])
  const restoreWorkspacePanel = useCallback((panel: WorkspacePanelKind) => {
    if (panel === 'terminal') {
      void terminal.open(currentWorkspaceDirectory)
      return
    }
    if (panel === 'review') {
      const target = review.target
      if (target) review.open(target.workingDirectory, target.files, target.index)
      return
    }
    if (panel === 'browser' && browserAvailable) {
      browser.open()
      return
    }
    if (panel === 'simulator' && simulatorAvailable) simulator.open()
  }, [browser.open, browserAvailable, currentWorkspaceDirectory, review.open, review.target, simulator.open, simulatorAvailable, terminal.open])
  const { workspacePanelsEnabled } = useWorkspacePanelSuspension({
    isFullscreenView,
    isChatView: activeView === 'chat',
    terminalOpen: terminal.terminalOpen,
    reviewOpen: review.reviewOpen,
    browserOpen: browser.browserOpen,
    simulatorOpen: simulator.simulatorOpen,
    closeAll: closeWorkspacePanels,
    restorePanel: restoreWorkspacePanel,
  })

  useEffect(() => {
    const request = simulator.agentOpenRequest
    if (!simulatorAvailable || request <= consumedSimulatorOpenRequestRef.current) return
    consumedSimulatorOpenRequestRef.current = request
    setActiveView('chat')
    terminal.close()
    review.close()
    browser.close()
    setSelectedSubagentId(undefined)
    simulator.open()
  }, [
    browser.close,
    review.close,
    simulator.agentOpenRequest,
    simulator.open,
    simulatorAvailable,
    terminal.close,
  ])
  const visibleTerminalOpen = workspacePanelsEnabled && terminal.terminalOpen
  const visibleReviewOpen = workspacePanelsEnabled && review.reviewOpen
  const visibleBrowserOpen = browserAvailable && workspacePanelsEnabled && browser.browserOpen
  const visibleSimulatorOpen = simulatorAvailable && workspacePanelsEnabled && simulator.simulatorOpen
  const visibleVisualPanelOpen = visibleBrowserOpen || visibleSimulatorOpen
  const effectiveSidebarWidth = isFullscreenView
    ? 0
    : sidebarVisualMode === 'hidden'
      ? 0
      : sidebarVisualMode === 'compact'
        ? SIDEBAR_COMPACT_WIDTH
        : sidebarWidth
  const browserWidthLimit = browserMaxWidth(effectiveSidebarWidth)
  const effectiveBrowserWidth = browserLayoutWidth(browser.browserWidth, effectiveSidebarWidth)
  const setBrowserWidth = useCallback((width: number) => {
    browser.setWidth(width, effectiveSidebarWidth)
  }, [browser.setWidth, effectiveSidebarWidth])

  useEffect(() => {
    if (!browserAvailable) browser.close()
    if (!simulatorAvailable) simulator.close()
  }, [browser.close, browserAvailable, simulator.close, simulatorAvailable])

  useEffect(() => {
    if ((!browser.browserOpen && !simulator.simulatorOpen) || browser.browserWidth <= browserWidthLimit) return
    browser.setWidth(browserWidthLimit, effectiveSidebarWidth)
  }, [browser.browserOpen, browser.browserWidth, browser.setWidth, browserWidthLimit, effectiveSidebarWidth, simulator.simulatorOpen])
  const subagentThreads = activeConversation?.subagents ?? []
  const subagentIndicatorKey = `${activeConversationId ?? 'none'}:${subagentThreads.length}`
  const workingSubagentCount = subagentThreads.filter(isSubagentThreadWorking).length
  const selectedSubagent = selectedSubagentId
    ? subagentThreads.find(agent => agent.id === selectedSubagentId)
    : undefined
  const showSubagentThreadPanel = activeView === 'chat' && Boolean(selectedSubagent) && !terminal.terminalOpen && !review.reviewOpen

  /* ── T1-TodoWrite: checklist placement (PURE decision + flight) ──
   * The checklist is a CHAT-LANE citizen: hidden outside the chat
   * view and in fullscreen, like the workspace panels (hasList folds
   * those gates in). goalDocked counts ANY goal element occupying the
   * aux-stack — live panel, genie exit ghost, or terminal status bar —
   * which is what serializes the checklist migration AFTER the 280ms
   * genie window instead of fighting it (single choreography owner —
   * see useChecklistFlight). otherRightLaneOpen extends "right side
   * physically occupied" to the subagent thread panel and the side-chat
   * column, same spirit as the terminal/review/web rule. A floating card
   * anchored to the viewport's right edge would otherwise sit underneath
   * the side-chat lane. */
  const activeChecklistTodos = activeConversationId ? todosByConversation[activeConversationId] : undefined
  const checklistPlacement = resolveChecklistPlacement({
    hasList: activeView === 'chat' && !isFullscreenView && !!activeChecklistTodos && activeChecklistTodos.length > 0,
    goalDocked: Boolean(goal) || Boolean(exitGoal),
    terminalOpen: visibleTerminalOpen,
    reviewOpen: visibleReviewOpen,
    webOpen: visibleVisualPanelOpen,
    sidebarOpen: sidebarVisualMode !== 'hidden',
    preference: checklistFormPref,
    otherRightLaneOpen: showSubagentThreadPanel || Boolean(sideChat),
  })
  const checklistFlight = useChecklistFlight(checklistPlacement)
  /* The completed list LEAVES (user order, 2026-08-01): after the dwell
   * the exit animation plays and ONLY THEN the conversation entry is
   * removed — hasList folds to false and the panel unmounts. Timers are
   * keyed to the list reference, so a new list can never be deleted by
   * a stale exit (see useChecklistCompletionExit). */
  const checklistCompletionExit = useChecklistCompletionExit(
    activeConversationId,
    activeChecklistTodos,
    id => setTodosByConversation(prev => removeChecklistForConversation(prev, id)),
  )

  useEffect(() => {
    writeChecklistFormPreference(checklistFormPref)
  }, [checklistFormPref])
  useEffect(() => {
    writeChecklistCardPos(checklistCardPos)
  }, [checklistCardPos])
  // Mirror + persist the sound master switch (event handlers read the
  // ref — they have stale closures by construction).
  useEffect(() => {
    soundsEnabledRef.current = soundsEnabled
    writeSoundsEnabled(soundsEnabled)
  }, [soundsEnabled])
  const appLayoutStyle = {
    '--sidebar-width': `${effectiveSidebarWidth}px`,
    // Peek width is frozen at the user's sidebarWidth and used by the shell
    // during both enter and leave. This is critical for leave: when peek
    // flips false, --sidebar-width goes to 0 (grid collapses), but the shell
    // (position:absolute) must keep its own width or .app-sidebar grows to
    // content width → ghost expand with untruncated project names.
    '--sidebar-peek-width': `${sidebarMode === 'hidden' && (sidebarPeek || sidebarPeekLeaving) ? sidebarWidth : 0}px`,
    '--sidechat-width': sideChat ? 'clamp(300px, 32vw, 420px)' : '0px',
    '--subagents-panel-width': showSubagentThreadPanel ? '320px' : '0px',
    '--terminal-width': visibleTerminalOpen ? `${terminal.terminalWidth}px` : '0px',
    '--review-width': visibleReviewOpen ? `${review.reviewWidth}px` : '0px',
    '--browser-width': visibleBrowserOpen ? `${effectiveBrowserWidth}px` : '0px',
  } as CSSProperties
  // Browser and simulator share the same right lane. Keep the browser branch
  // explicit because the existing layout contract keys that lane by this
  // variable, then hand the same measured width to the simulator when it owns
  // the lane.
  if (visibleSimulatorOpen) {
    Object.assign(appLayoutStyle, { '--browser-width': `${effectiveBrowserWidth}px` })
  }

  useEffect(() => {
    if (!selectedSubagentId) return
    if (subagentThreads.some(agent => agent.id === selectedSubagentId)) return
    setSelectedSubagentId(undefined)
  }, [subagentThreads, selectedSubagentId])

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 899px)')
    const closeOnNarrow = () => {
      if (narrow.matches) setSelectedSubagentId(undefined)
    }
    closeOnNarrow()
    narrow.addEventListener('change', closeOnNarrow)
    return () => narrow.removeEventListener('change', closeOnNarrow)
  }, [])

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
        browserVerificationEnabled: settings.browserVerificationEnabled ?? true,
        loadWebIcons: settings.loadWebIcons ?? true,
      })
      setSettingsLoaded(true)
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
      setConfigLoaded(true)
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

  // Notification click → focus a persisted conversation. The desktop
  // backend may emit this event immediately when it shows a notification;
  // ephemeral side-chat IDs must never become the main conversation.
  useEffect(() => {
    const unlisten = (window.verboo as any).listenForNotificationClick?.((conversationId: string) => {
      const target = findNotifiableConversationId(chatStoreRef.current.conversations, conversationId)
      if (!target) return
      setActiveConversationId(target)
      setActiveView('chat')
    })
    return () => { unlisten?.then((fn: () => void) => fn()) }
  }, [])

  // F4: provider login progress (provider-login:event, shape verified in
  // provider_login_pty.rs:45-58). The CLI owns the browser flow; the renderer
  // reflects outcomes — connected refreshes the catalog + bridge universe,
  // error surfaces the message (D1 rule: every failure visible).
  useEffect(() => {
    const unlisten = window.verboo.onProviderLoginEvent?.(event => {
      if (event.state === 'awaiting_browser') {
        toast(t('settings.provider.awaitingBrowser'), 'info')
        setProviderLoginStage('awaiting_browser')
        return
      }
      if (event.state === 'risk_notice') {
        // Policy acceptance screen (claude): open the dialog with the FULL
        // notice. The flow stays alive — connectingProvider is NOT cleared.
        setProviderRiskNotice({ provider: event.provider, message: event.message ?? '' })
        return
      }
      setConnectingProvider(undefined)
      setProviderLoginStage(undefined)
      setProviderRiskNotice(undefined)
      if (event.state === 'connected') {
        void refreshModels(true)
        void reloadProviderAuth()
        toast(t('settings.provider.connectedToast', { provider: providerDisplayName(event.provider, t) }))
      } else if (event.state === 'error') {
        toast(event.message ?? t('settings.provider.connectError', { message: '' }), 'error')
      }
    })
    // The bridge returns a cleanup fn; anything else (incomplete test mock)
    // degrades to a no-op destroy.
    return () => { if (typeof unlisten === 'function') unlisten() }
    // `t` is per-locale (createTranslator) — without it in deps the handler
    // toasts in the INITIAL locale forever (field bug: pt-BR user, en toast).
  }, [t])

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
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'b') return
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

  // This subscription is intentionally installed only once. Keep its callback
  // current so automatic recovery rebuilds a turn with the active project's
  // directory instead of the state from the app's initial render.
  const agentEventHandlerRef = useRef(handleAgentEvent)
  agentEventHandlerRef.current = handleAgentEvent

  useEffect(() => {
    return window.verboo.onAgentEvent(event => {
      void agentEventHandlerRef.current(event)
    })
  }, [])

  // Video OCR bridge: backend frame batches run serially through the
  // existing Tesseract worker and return exactly one completion per job.
  useEffect(() => {
    const coordinator = createVideoOcrCoordinator({
      // Frames arrive as raw bytes over IPC (the asset protocol does not
      // reach worker or fetch requests reliably) and go to Tesseract as a
      // Blob.
      recognize: async path => {
        const bytes = await window.verboo.readVideoFrame(path)
        return recognizeImage(new Blob([bytes], { type: 'image/png' }))
      },
      complete: (jobId, results) => window.verboo.completeVideoOcrBatch(jobId, results),
    })
    return window.verboo.onVideoOcrRequest(request => {
      void coordinator.handleRequest(request)
    })
  }, [])

  const runCliBootstrap = useCallback(async () => {
    if (cliBootstrapInFlightRef.current) return
    cliBootstrapInFlightRef.current = true
    try {
      setUpdateSnapshot(await window.verboo.bootstrapCli())
    } catch (error) {
      setUpdateSnapshot(current => current ? {
        ...current,
        status: 'error',
        target: 'cli',
        cliBootstrapRequired: true,
        error: error instanceof Error ? error.message : String(error),
      } : current)
    } finally {
      cliBootstrapInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    let mounted = true
    void window.verboo.getUpdateStatus().then(snapshot => {
      if (!mounted || !snapshot) return
      setUpdateSnapshot(snapshot)
      if (snapshot.cliBootstrapRequired && snapshot.status !== 'error') {
        void runCliBootstrap()
      }
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
  }, [runCliBootstrap, t, toast])

  const cliBootstrapRequired = updateSnapshot?.cliBootstrapRequired === true

  useEffect(() => {
    if (cliBootstrapRequired) {
      cliBootstrapWasRequiredRef.current = true
      setCliBootstrapSuccessVisible(false)
      if (cliBootstrapSuccessTimerRef.current !== undefined) {
        window.clearTimeout(cliBootstrapSuccessTimerRef.current)
        cliBootstrapSuccessTimerRef.current = undefined
      }
      return
    }
    if (!cliBootstrapWasRequiredRef.current) return

    cliBootstrapWasRequiredRef.current = false
    setCliBootstrapSuccessVisible(true)
    cliBootstrapSuccessTimerRef.current = window.setTimeout(() => {
      cliBootstrapSuccessTimerRef.current = undefined
      setCliBootstrapSuccessVisible(false)
    }, 1_400)
  }, [cliBootstrapRequired])

  useEffect(() => () => {
    if (cliBootstrapSuccessTimerRef.current !== undefined) {
      window.clearTimeout(cliBootstrapSuccessTimerRef.current)
    }
  }, [])

  const cliAgentActionsBlocked = cliBootstrapRequired || cliBootstrapSuccessVisible

  const updateRestart = useDeferredUpdateRestart({
    snapshot: updateSnapshot,
    runningCount: runningConversations.size,
    check: window.verboo.checkForUpdates,
    download: window.verboo.downloadUpdate,
    install: window.verboo.installUpdate,
    persistDrafts: persistUpdateDrafts,
    clearDrafts: clearPersistedUpdateDrafts,
  })

  useUpdateAutomation({
    autoCheck: settingsLoaded && updateSnapshot !== undefined && !cliBootstrapRequired && userSettings.updates.autoCheck,
    autoDownload: settingsLoaded && userSettings.updates.autoDownload,
    channel: userSettings.updates.channel,
    snapshot: updateSnapshot,
    check: window.verboo.checkForUpdates,
    download: window.verboo.downloadUpdate,
  })

  useEffect(() => {
    return () => {
      if (scrollSettleTimer.current) window.clearTimeout(scrollSettleTimer.current)
    }
  }, [])

  useEffect(() => {
    goalRef.current = goal
  }, [goal])

  // Espelho do state no ref (mesmo padrão de goalRef acima): mantém o
  // retrato fresco para o sendMessage sem re-criar a função a cada rascunho.
  useEffect(() => {
    annotationDraftsRef.current = annotationDrafts
  }, [annotationDrafts])

  useEffect(() => {
    sideChatRef.current = sideChat
  }, [sideChat])

  // Escape may only act on a conversation that is still rendered in the lane
  // that last received focus. Navigation can leave a previous conversation
  // running in the background, so keeping its focus ref would make Esc stop
  // work the user can no longer see.
  useEffect(() => {
    const focusedConversationId = focusedConversationIdRef.current
    if (!focusedConversationId) return

    const focusedConversationIsVisible = focusedConversationLaneRef.current === 'main'
      ? activeView === 'chat' && focusedConversationId === activeConversationId
      : focusedConversationLaneRef.current === 'side'
        ? focusedConversationId === sideChat?.conversation.id
        : false

    if (!focusedConversationIsVisible) {
      focusedConversationIdRef.current = undefined
      focusedConversationLaneRef.current = undefined
    }
  }, [activeConversationId, activeView, sideChat])

  // The excerpt belongs to the main conversation and workspace that opened
  // it. Any main-lane navigation invalidates that relationship, including
  // routes that do not go through the explicit sidebar handlers (notification
  // clicks and the command palette). Close the ephemeral lane before it can
  // send against a different project.
  useEffect(() => {
    if (!sideChat) return
    if (shouldDiscardSideChatForNavigation(sideChat, activeConversationId, currentWorkspaceDirectory)) {
      discardSideChatForNavigation()
    }
  }, [activeConversationId, currentWorkspaceDirectory, sideChat])

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

  useEffect(() => {
    void cleanupVisualCaptureOwners(chatStoreRef.current.conversations.map(conversation => conversation.id)).catch(() => {})
  }, [])

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
    for (const prompt of Object.values(pendingPermissionPrompts)) {
      if (!prompt.autoApprove || autoApprovalSent.current.has(prompt.id)) continue
      autoApprovalSent.current.add(prompt.id)
      void respondToPermissionPrompt(prompt, 'allow', true)
    }
  }, [pendingPermissionPrompts])

  /* NOTIFICATION SOUND (the app's first sound): the app needs the user.
   * Effect-driven — one fire per staged prompt, never a setState-
   * updater side effect (double-invoke would double-play). The VISIBLE
   * prompt gate already excludes auto-approved prompts (no attention
   * needed there). Each event is additionally gated by its existing
   * notification preference inside playAppSound. */
  const visiblePermissionPromptId = [visiblePermissionPrompt?.id, sidePermissionPrompt?.id].filter(Boolean).join('|')
  useEffect(() => {
    for (const prompt of [visiblePermissionPrompt, sidePermissionPrompt]) {
      if (prompt) playAppSound('permissionNeeded', prompt.conversationId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePermissionPromptId])
  const questionPromptTurnId = Object.keys(questionPrompts).sort().join('|')
  useEffect(() => {
    for (const prompt of Object.values(questionPrompts)) {
      playAppSound('questionNeeded', prompt.conversationId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionPromptTurnId])

  useEffect(() => {
    return window.verboo.onRefreshDataRequest(() => {
      void refreshModels(true)
      void refreshProfile()
      void validateAccess(true)
    })
  }, [])

  useEffect(() => {
    // ESC closes settings and plugins. Earlier this only handled settings, so
    // the plugins view had no keyboard escape — users had to click back.
    if (activeView !== 'settings' && activeView !== 'plugins') return undefined

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
    if (queuedFollowUps.length === 0) return
    void flushQueuedFollowUps()
  }, [queuedFollowUps, runningTurnByConversation])

  useEffect(() => {
    function handleEscapeInterrupt(event: KeyboardEvent) {
      const targetConversationId = resolveEscapeConversation({
        activeConversationId: activeConversationIdRef.current,
        sideChatConversationId: sideChatRef.current?.conversation.id,
        focusedConversationId: focusedConversationIdRef.current,
        focusedLane: focusedConversationLaneRef.current,
        lifecycle: { runningTurnByConversation: runningTurnByConversationRef.current },
      })
      if (event.key !== 'Escape' || !targetConversationId) return
      event.preventDefault()
      event.stopPropagation()
      const now = Date.now()
      if (now - lastEscapeAt.current <= 1300) {
        lastEscapeAt.current = 0
        if (targetConversationId === activeConversationIdRef.current) goalAbortRef.current?.abort()
        void interruptForUser(targetConversationId)
        // User ESC×2 is deliberate: dismiss the question wizard entirely
        // (not just minimize). The auto-interrupt from presentTurnQuestions
        // (line ~2251) does NOT go through this handler — that path must
        // keep the wizard open for AskUserQuestion flow.
        clearQuestionPromptsForConversation(targetConversationId)
        return
      }
      lastEscapeAt.current = now
      toast(t('composer.escapeAgainToStop'), 'info')
    }

    window.addEventListener('keydown', handleEscapeInterrupt, { capture: true })
    return () => window.removeEventListener('keydown', handleEscapeInterrupt, { capture: true })
  }, [runningTurnByConversation])

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
      // SideChatSurface is parallel to this composer. Its turn lifecycle must
      // never close the side panel just because the main conversation changes;
      // only closeSideChat (the user's close action) destroys it.
      composerDrafts.current[previousKey] = composerValue
      setComposerValue(composerDrafts.current[nextKey] ?? '')
      setTokenSkills([])
    }
    prevConversationIdRef.current = activeConversationId
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    if (!activeConversationId) return
    const pending = pendingBrowserSnapshots.current[activeConversationId]
    if (!pending?.length) return
    delete pendingBrowserSnapshots.current[activeConversationId]
    const batch = attachmentQueueRef.current.reserve()
    completeAttachmentBatch(batch, pending)
  }, [activeConversationId])

  useEffect(() => {
    setContextUsage(undefined)
  }, [activeConversationId, selectedContextWindow, selectedModel])

  // Hydrate goal state when the active conversation changes (covers initial
  // load, sidebar selection, and notification-click focus). Mirrors the
  // hydration in selectConversation but lives in an effect so it fires on
  // every activeConversationId transition, including the initial mount.
  //
  // G-C5: dependency is [activeConversationId] ONLY. Reading via
  // chatStoreRef (not chatStore.conversations) avoids re-firing when the
  // scheduler itself persists progress — that persistence changes the
  // store reference, which previously re-triggered this effect and
  // forced the running goal back to 'paused', causing an infinite
  // feedback loop (visible as the goal panel flickering AVALIANDO /
  // paused every ~1-3 s with no error ever shown).
  //
  // Guard: while a scheduler is alive for the active conversation
  // (goalAbortRef not aborted), the scheduler owns the goal state —
  // this effect must NOT overwrite it. Only hydrate from storage when
  // there is no live cycle (initial mount, conversation switch, app
  // relaunch).
  useEffect(() => {
    if (!activeConversationId) {
      setGoal(undefined)
      goalRef.current = undefined
      setGoalBarStatus({ kind: 'idle' })
      return
    }
    // If a scheduler is alive for the current goal, do not hydrate from
    // storage — the running cycle is the source of truth.
    if (goalAbortRef.current && !goalAbortRef.current.signal.aborted) {
      return
    }
    const conversation = chatStoreRef.current.conversations.find(item => item.id === activeConversationId)
    const storedGoal = conversation?.goal
    if (storedGoal && (storedGoal.status === 'active' || storedGoal.status === 'paused' || storedGoal.status === 'evaluating' || storedGoal.status === 'continuing')) {
      // Active goals are restored as paused — the user must explicitly
      // resume to restart the autonomous cycle. Prevents surprise execution
      // on app launch or conversation switch.
      //
      // G-C7-TS-MIGRACAO: sanitize before re-hydrating. Goals persisted
      // before G-C7-TS-FIX wrote maxTurns=9.0e15 on disk; running them
      // verbatim would re-trip the Rust u32 serde rejection that this
      // whole cycle fixed. The normalizer is idempotent for safe values.
      const sanitized = sanitizeStoredGoal(storedGoal)
      const restored: GoalState = sanitized.status === 'paused'
        ? sanitized
        : { ...sanitized, status: 'paused', pausedAt: sanitized.pausedAt ?? Date.now() }
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
  }, [activeConversationId])

  // G-C5: dedicated persist effect. Watches `goal` and mirrors it into
  // the active conversation's stored goal. Runs OUTSIDE the setGoal
  // updater, so it does not re-enter React state from inside a state
  // updater (reentrancy risk). With P1's hydration dependency
  // reduced to [activeConversationId], this effect's resulting store
  // churn does NOT trigger the hydration cycle.
  //
  // G-C5-FIX: only persist when the goal's ownerConversationId matches
  // the active conversation. Without this guard, switching from
  // conversation A (with active goal) to B fires this effect with
  // goal=A + activeConversationId=B, corrupting B's stored goal. The
  // next flush would correct it, but a crash between the two leaves B
  // with a stale goal.
  useEffect(() => {
    const conversationId = activeConversationId
    if (!conversationId) return
    if (goal === undefined) {
      // Goal was cleared (cancel/clear). Clear it from storage too,
      // but only if the conversation currently has a goal — otherwise
      // we would create a new store reference for no reason.
      updateConversation(conversationId, conversation =>
        conversation.goal === undefined
          ? conversation
          : { ...conversation, goal: undefined, updatedAt: Date.now() },
      )
      return
    }
    // G-C5-FIX: do NOT cross-write into a conversation that does not
    // own this goal. The owner is stamped at creation/resume time.
    if (goal.ownerConversationId !== conversationId) return
    updateConversation(conversationId, conversation => ({
      ...conversation,
      goal,
      updatedAt: Date.now(),
    }))
  }, [goal, activeConversationId])

  async function refreshModels(forceRefresh: boolean): Promise<ModelDiscoveryResult> {
    const result = await window.verboo.listModels(forceRefresh)
    const deduped = { ...result, models: dedupModels(result.models) }
    setModelResult(deduped)
    setSelectedModel(current => {
      return resolveSelectedModel(deduped.models, current, userSettingsRef.current.lastSelectedModelId)
    })
    return deduped
  }

  // F4: provider auth is a Vec of PER-PROVIDER entries (the login bridge
  // universe). Failure → empty: the cards/groups degrade.
  async function reloadProviderAuth(): Promise<void> {
    try {
      const states = await window.verboo.providerAuthStatus()
      // Tolerates a malformed/empty payload (or an incomplete test mock) —
      // anything that is not an array degrades to "unknown".
      setProviderAuth(Array.isArray(states) ? states : [])
    } catch {
      setProviderAuth([])
    }
  }

  // F4: Conectar starts the bridge login (provider_login_start) — the CLI
  // takes over in the browser; progress arrives on provider-login:event.
  // Every failure must be VISIBLE (D1 rule): invoke rejections toast.
  async function handleProviderConnect(providerId: string): Promise<void> {
    setConnectingProvider(providerId)
    setProviderLoginStage('starting')
    try {
      await window.verboo.providerLoginStart(providerId)
    } catch (error) {
      toast(t('settings.provider.connectError', { message: error instanceof Error ? error.message : String(error) }), 'error')
      setConnectingProvider(undefined)
      setProviderLoginStage(undefined)
    }
  }

  // F4 risk_notice dialog: accept continues the bridge login
  // (provider_login_confirm_risk); cancel aborts it (provider_login_cancel).
  // Invoke rejections toast — every failure visible (D1 rule).
  async function handleProviderRiskAccept(): Promise<void> {
    const notice = providerRiskNotice
    if (!notice) return
    setProviderRiskNotice(undefined)
    try {
      await window.verboo.providerLoginConfirmRisk(notice.provider)
    } catch (error) {
      toast(t('settings.provider.connectError', { message: error instanceof Error ? error.message : String(error) }), 'error')
      setConnectingProvider(undefined)
      setProviderLoginStage(undefined)
    }
  }

  // Aborts the active login flow — the SAME action whether it comes from the
  // card's Cancelar button or the risk_notice dialog.
  async function handleProviderLoginCancel(): Promise<void> {
    setProviderRiskNotice(undefined)
    setConnectingProvider(undefined)
    setProviderLoginStage(undefined)
    try {
      await window.verboo.providerLoginCancel()
    } catch {
      // Best-effort abort: the login may already be gone on the CLI side.
    }
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
    // A1: non-blocking — the Rust command spawns the CLI and returns in
    // <1s (suite Rust A1: 30s fake CLI, command returns immediately).
    // result.ok now means "spawned", NOT "authenticated", and
    // result.status is always absent at this point. Do NOT call
    // validateAccess here: it would re-check auth BEFORE the user had
    // any chance to authenticate in the browser, surface a spurious
    // failure, and never unlock. Progress arrives via the login:event
    // channel (LoginScreen), and completion triggers the real
    // re-validation via onLoginComplete below.
    return window.verboo.startCliLogin()
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
    setAuthErrorDetail(undefined)

    try {
      const [credentialStatus, cliStatus, modelDiscovery] = await Promise.all([
        window.verboo.getCredentialStatus(),
        window.verboo.getCliAuthStatus(),
        window.verboo.listModels(forceRefresh),
      ])
      const dedupedDiscovery = { ...modelDiscovery, models: dedupModels(modelDiscovery.models) }
      setCredentials(credentialStatus)
      setCliAuth(cliStatus)
      setModelResult(dedupedDiscovery)
      // F4: provider auth is non-critical — fire-and-forget, never gates entry.
      void reloadProviderAuth()
      setSelectedModel(current => {
        return resolveSelectedModel(dedupedDiscovery.models, current, userSettingsRef.current.lastSelectedModelId)
      })

      const unlocked = isVerifiedModelDiscovery(dedupedDiscovery)
      setEntryUnlocked(unlocked)
      if (unlocked) {
        writeRememberedAuthSession(allowRememberedSession, credentialStatus, cliStatus, dedupedDiscovery)
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
    } catch (error) {
      // T5: a rejected Rust command (Result<_, String> → Tauri invoke
      // rejects) used to bypass both setAuthError setters above — the
      // try body aborted before them — leaving the login surface mute
      // and "Verificando sessão local…" stuck forever (field photo M4).
      // Surface a friendly headline and stash the raw cause behind a
      // details toggle. Never re-throw: the caller (checkExistingAuth)
      // owns the status-message lifecycle.
      setAuthError(t('login.sessionCheckFailed'))
      setAuthErrorDetail(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setAuthChecking(false)
    }
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
    if (liveState && liveState.charsSinceUsage > 80 && usage.outputTokens) {
      const measured = usage.outputTokens / liveState.charsSinceUsage
      if (Number.isFinite(measured)) {
        liveState.tokensPerChar = Math.min(0.6, Math.max(0.1, measured))
      }
      liveState.charsSinceUsage = 0
    }

    // G-C12: usage is a TokenUsage (camelCase, see shared/types.ts).
    // The CLI sends snake_case in its raw payload, but extractTokenUsage
    // renames to camelCase on the way out so this consumer reads the
    // same shape the Rust-side event.result.usage uses.
    const inputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    const cacheCreationTokens = usage.cacheCreationInputTokens ?? 0
    const cacheReadTokens = usage.cacheReadInputTokens ?? 0
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
    if (event.type === 'subagent-thread') {
      const conversationId = event.conversationId ?? turnConversationIds.current[event.turnId]
      if (conversationId) {
        updateConversation(conversationId, conversation =>
          applySubagentThreadUpdate(conversation, event.turnId, event.subagentThread),
        )
      }
      return
    }

    if (event.type === 'started') {
      const conversationId = turnConversationIds.current[event.turnId] ?? pendingConversationId.current
      if (conversationId) turnConversationIds.current[event.turnId] = conversationId
      turnStartedAt.current[event.turnId] = Date.now()
      beginTokenRateTracking(event.turnId)
      turnActivityKeys.current[event.turnId] ??= new Set()
      turnActivityCounts.current[event.turnId] ??= {}
      turnTerminalErrors.current[event.turnId] = []
      turnCommands.current[event.turnId] = []
      turnReferences.current[event.turnId] = []
      setThinkingTurnId(event.turnId)
      if (conversationId) {
        markTurnStarted(conversationId, event.turnId)
        appendAssistantPlaceholder(conversationId, event.turnId)
      }
      return
    }

    if (event.type === 'stdout') {
      const conversationId = turnConversationIds.current[event.turnId]
      // The result event's `result` string is forwarded as stdout AFTER the
      // same text already arrived from the assistant event (turn_service.rs
      // extract_text). Skip the exact re-emission — gated by the announced
      // result text so a repeated streaming delta is never eaten.
      const announcedResult = turnResultEmittedText.current[event.turnId]
      const accumulated = (turnAssistantText.current[event.turnId] ?? '').trim()
      if (
        announcedResult !== undefined
        && event.text.trim() === announcedResult.trim()
        && accumulated === event.text.trim()
      ) {
        return
      }
      // T17: the CLI also forwards an isApiErrorMessage-flagged assistant
      // event as stdout — the same raw diagnostic twice (once from the
      // assistant event, once from the result event's extract_text). The
      // error handler (below) already surfaces a readable headline in the
      // system row with the raw blob in the collapsed technical-detail
      // toggle, so letting the raw error also land in the assistant body
      // is pure duplication. The ref persists for the turn (cleared on
      // cleanup) so BOTH stdout re-emissions are skipped — the one-shot
      // variant left the second copy alive because the announcedResult
      // dedupe requires the first to have landed.
      const apiErrorText = turnApiErrorTextRef.current[event.turnId]
      if (apiErrorText !== undefined && event.text.trim() === apiErrorText.trim()) {
        return
      }
      setApiRetryByTurn(prev => clearApiRetryNotice(prev, event.turnId))
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

    if (event.type === 'video-progress') {
      const incoming = event.videoProgress
      setVideoProgressByTurn(prev => applyVideoProgress(prev, event.turnId, incoming))
      return
    }

    if (event.type === 'json') {
      // Provider rate-limit retry in flight → live retry notice on the
      // thinking row. Purely informational: no other extractor needs it.
      const apiRetry = extractApiRetry(event.payload)
      if (apiRetry) {
        const conversationId = turnConversationIds.current[event.turnId]
        const turnProvider = turnModels.current[event.turnId]?.provider ?? VERBOO_PROVIDER
        const quotaMessage = quotaResetMessageFromRetry(apiRetry.retryDelayMs, providerAccountName(turnProvider, t), t)
        if (quotaMessage && conversationId) {
          // T13: the CLI declared an hour-scale wait before retrying — that's
          // not a retry, it's a quota reset. End the turn and surface the
          // readable headline immediately instead of sitting on a mute
          // "Thinking…" for 43h. A terminal error may arrive after the
          // interrupt; quotaResetTurnsRef suppresses its duplicate item (the
          // quota message already told the user).
          quotaResetTurnsRef.current.add(event.turnId)
          // T23: the quota message is the model's natural response, not a
          // "Sistema" badge. appendAssistantText puts it in the turn body
          // (same segment the model's own text would use); the turn header
          // + "Trabalhou" sit above it as a normal response. No second block,
          // no colored band. finishAssistantMessage closes the segment when
          // the interrupt's error/done event lands (:2574 / :2771).
          appendAssistantText(conversationId, event.turnId, quotaMessage)
          void interruptForUser(conversationId)
          setApiRetryByTurn(prev => clearApiRetryNotice(prev, event.turnId))
          return
        }
        setApiRetryByTurn(prev => ({ ...prev, [event.turnId]: apiRetry }))
        return
      }
      const announcedResult = extractResultText(event.payload)
      if (announcedResult !== undefined) {
        turnResultEmittedText.current[event.turnId] = announcedResult
      }
      // T17: capture assistant events flagged as API errors so the stdout
      // re-emission of the same text is skipped (see turnApiErrorTextRef).
      if (event.payload && typeof event.payload === 'object'
        && (event.payload as { type?: unknown }).type === 'assistant'
        && (event.payload as { isApiErrorMessage?: unknown }).isApiErrorMessage === true) {
        const content = (event.payload as { message?: { content?: unknown[] } }).message?.content
        const textBlock = Array.isArray(content) ? content.find((b): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') : undefined
        if (textBlock) {
          turnApiErrorTextRef.current[event.turnId] = textBlock.text
        }
      }
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
          markTurnStarted(conversationId, event.turnId)
          setThinkingTurnId(event.turnId)
        }
      }
      trackLiveTokenRate(event.turnId, event.payload)
      updateTokenRateFromPayload(event.turnId, event.payload)
      // Capture thinking_delta text for real-time rotating snippet display
      collectThinkingText(event.turnId, event.payload)
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
      // T1-TodoWrite: the structured checklist rides the todowrite
      // activity (kind 'planning'). REPLACE semantics per OWNER
      // conversation (possession); absence (undefined —
      // skip_serializing_if) is NOT a clear. ChecklistPanel is the
      // presentation for this activity, so appendActivityItem deliberately
      // skips its duplicate transcript row below.
      if (conversationId && activity?.todos) {
        setTodosByConversation(prev => applyTodoWrite(prev, conversationId, activity.todos))
      }
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
        }
      }
      return
    }

    if (event.type === 'result') {
      // G-C14: dedupe token accumulation by turnId. The Rust side
      // emits the result event TWICE for a single turn — the second
      // emission carries the exit_code. Both events have the same
      // turnId and the same usage payload, so accumulating on every
      // event double-counts tokens (measured: 1-turn goal showed
      // 79.695 on screen but 159.390 in the store). Fix: check if we
      // already have a snapshot for this turnId BEFORE overwriting.
      // If we do, this is the second emission — skip the token sum
      // but still update the snapshot (the second event carries the
      // exit_code and may carry a richer result). The QA was
      // explicit: do NOT suppress the second event — other consumers
      // (exit_code readers) depend on it. Dedupe in the consumer is
      // sufficient and safer than touching the Rust emitter.
      const hadSnapshot = turnResultSnapshots.current[event.turnId] !== undefined
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
      if (event.result.usage && shouldAccumulateTokensForTurn(hadSnapshot)) {
        setGoal(current => {
          if (!current) return current
          // T3: the accumulation moved to the pure accumulateTurnUsage
          // (tokenAccumulator.ts) — byte-identical semantics (G-C12
          // camelCase reads), extracted so the dedupe sequence is
          // testable as EFFECT, not form.
          const updated = accumulateTurnUsage(current, event.result.usage)
          // G-C10 item 3: synchronize goalRef.current so the scheduler
          // (which reads via delegate.getGoal() → goalRef.current) sees
          // the accumulated tokens. Without this, the scheduler's
          // updateGoal((prev) => ...) sees a stale prev (tokens=0) and
          // the completion write preserves the zeros — same ref/state
          // desync class as G-C5 and G-C8.
          goalRef.current = updated
          return updated
        })
      }
      return
    }

    if (event.type === 'error') {
      const conversationId = turnConversationIds.current[event.turnId]
      setApiRetryByTurn(prev => clearApiRetryNotice(prev, event.turnId))
      // The provider behind THIS turn (stamped at send time) names the
      // account in a readable quota message — the live catalog is NOT
      // consulted here: it may have degraded during the failure itself.
      const turnProvider = turnModels.current[event.turnId]?.provider ?? VERBOO_PROVIDER
      const errorPresentation = presentAgentError(
        event,
        userInterruptedTurnsRef.current,
        t,
        providerAccountName(turnProvider, t),
      )
      setVideoProgressByTurn(prev => clearVideoProgress(prev, event.turnId))
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
      const willRetryIncomplete = Boolean(
        conversationId
        && !willRecoverAuth
        && !willRecoverContext
        && retryMeta
        && retryMeta.message.trim()
        && shouldRetryIncompleteTurn(failure, retryMeta.alreadyRetriedWithoutSession),
      )
      const willRestartSession = willRetrySession || willRetryIncomplete
      const willContinueAutomatically = willRecoverAuth || willRecoverContext || willRestartSession

      // Bump lastTurnEndedAt on error too — a turn concluded even when it
      // errored, and the sidebar should reflect the updated order.
      if (conversationId) {
        updateConversation(conversationId, c => ({ ...c, lastTurnEndedAt: Date.now() }))
      }
      if (conversationId) markTurnFinished(conversationId, event.turnId)
      clearPermissionPromptForTurn(event.turnId)
      setTokenRate(undefined)
      // Force the tray to idle so a lagging 'thinking' event can never
      // resurrect the timer after the turn has errored out.
      void window.verboo.forceIdleMenuBar()
      setThinkingTurnId(current => (current === event.turnId ? undefined : current))
      setThinkingSnippets([])
      setCompactingTurnId(current => (current === event.turnId ? undefined : current))
      setImageReadingTurnId(current => (current === event.turnId ? undefined : current))
      if (!willContinueAutomatically) flashPet('error')
      // A transparently recovered failure is not a completed error from the
      // user's perspective, so only notify when it will actually surface.
      const notificationConversationId = conversationId
        ? findNotifiableConversationId(chatStoreRef.current.conversations, conversationId)
        : undefined
      if (notificationConversationId && !willContinueAutomatically) {
        const isActive = notificationConversationId === activeConversationIdRef.current
        void window.verboo.fireCompletionNotification(
          1,
          notificationConversationId,
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
      // T3: a compaction-turn error resolves the frontier deferred with
      // false — UNCONDITIONALLY, even when willContinueAutomatically:
      // the batch NEVER waits on a failed compact (it proceeds without
      // compacting and declares the failure). If the reactive recovery
      // compacts anyway, that is the pre-existing reactive path doing
      // its own job, outside the frontier's control.
      if (compactCompletionDeferred.current?.turnId === event.turnId) {
        compactCompletionDeferred.current.resolve(false)
        compactCompletionDeferred.current = undefined
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

        // G.7: suppress only the interrupt duplicate (presentation === 'interruption')
        // from a quota-reset turn. A real error (context overflow, crash, etc.) must
        // always surface — even if it arrives first (e.g. when the interrupt failed
        // and userInterruptedTurnsRef was rolled back). The ref is consumed only
        // when the interrupt duplicate actually arrives, not on the first error of
        // any kind (one-shot by position was the defect; this is by identity).
        const isQuotaResetInterrupt = errorPresentation.presentation === 'interruption'
          && quotaResetTurnsRef.current.delete(event.turnId)
        // T19: shouldSuppressSystemErrorText is the unified guard applied at
        // all 4 error-headline role:system insertion points (grep `role: 'system'`
        // finds 5 — the 5th at the turn-summary is kind:'summary', not an error).
        // See the helper for why this checks parseApiErrorText (would
        // ApiErrorAwareText render a parsed headline?) rather than raw-text
        // containment.
        if (!willContinueAutomatically && !isQuotaResetInterrupt) {
          if (errorPresentation.presentation === 'interruption') {
            // User-requested interruption: already renders as assistant (no
            // "Sistema" label, no badge — Transcript.tsx visualRole override).
            // Keep the system row; the T19 guard still suppresses its text
            // when the body already carries a parseable API error.
            appendConversationItem(conversationId, {
              id: `${event.turnId}:error`,
              role: 'system',
              text: shouldSuppressSystemErrorText(turnAssistantText.current[event.turnId] ?? '')
                ? ''
                : errorPresentation.text,
              errorDetail: errorPresentation.technicalDetail,
              presentation: 'interruption',
              timestamp: Date.now(),
            })
          } else {
            // T23: the error message is the model's natural response, not a
            // "Sistema" badge. Two sub-paths:
            //  - bodyHasRawError: the CLI already sent the raw API error line
            //    as assistant text (isApiErrorMessage flag); ApiErrorAwareText
            //    in the turn-recap parses it into the readable headline (+ the
            //    "Começar nova conversa" button for thinking-400). Just attach
            //    errorDetail so the technical-detail toggle rides on the turn.
            //  - !bodyHasRawError: no assistant text arrived. Put the message
            //    as assistant text. For thinking-400 / quota 429 the raw API
            //    Error line (technicalDetail) is what ApiErrorAwareText parses;
            //    for other errors the readable headline is the response.
            const bodyHasRawError = shouldSuppressSystemErrorText(turnAssistantText.current[event.turnId] ?? '')
            const headline = isContextOverflow
              ? `${t('context.overflowDetected')}\n\n${errorPresentation.text}`
              : errorPresentation.text
            if (!bodyHasRawError) {
              // If the technicalDetail is itself a parseable API error line
              // (e.g. thinking-400 arriving as a single-line error event),
              // put it raw so ApiErrorAwareText in the turn-recap parses it
              // into the readable headline (+ the "Começar nova conversa"
              // button for thinking-400). Otherwise the technicalDetail is a
              // multi-line blob (or undefined) — put the readable headline so
              // the user sees the message, not the raw blob.
              const rawDetail = errorPresentation.technicalDetail
              const text = rawDetail && shouldSuppressSystemErrorText(rawDetail) ? rawDetail : headline
              appendAssistantText(conversationId, event.turnId, text)
            }
            stampErrorDetailOnAssistantText(conversationId, event.turnId, errorPresentation.technicalDetail)
          }
        }
      }
      // Capture partial assistant text BEFORE cleanup, so it can be appended
      // to the resume prompt as anchor context for the model.
      const partialText = turnAssistantText.current[event.turnId] ?? ''
      delete turnAssistantText.current[event.turnId]
      delete turnResultEmittedText.current[event.turnId]
      delete turnApiErrorTextRef.current[event.turnId]
      delete turnRetryPayload.current[event.turnId]
      if (conversationId) finishAssistantMessage(conversationId, event.turnId)
      cleanupTurnState(event.turnId)

      if (willRestartSession && conversationId && retryMeta) {
        clearConversationSession(conversationId)
        removeTurnTranscriptItems(conversationId, event.turnId)
        // QA a-i: the retry replays the SAME send — annotations included
        // (frozen at the click, carried by the retry payload). Without this
        // the retried turn silently lost the user's excerpts.
        const retry = createQueuedFollowUp(
          conversationId,
          retryMeta.message,
          undefined,
          retryMeta.annotations ?? [],
          retryMeta.sideChat ?? false,
        )
        retry.request.turnId = crypto.randomUUID()
        if (completionDeferred) completionDeferred.turnId = retry.request.turnId
        void runTurn(retry, { skipResume: true }).catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          const retryTurnId = retry.request.turnId ?? ''
          // T23: the retry error is the model's natural response, not a
          // "Sistema" badge. runTurn rejected before any stdout (T19 proved
          // the body is always empty), so appendAssistantText creates a fresh
          // segment; finishAssistantMessage closes it.
          appendAssistantText(conversationId, retryTurnId, message)
          finishAssistantMessage(conversationId, retryTurnId)
          if (turnCompletionDeferred.current === completionDeferred) {
            completionDeferred?.reject(error)
            turnCompletionDeferred.current = undefined
          }
        })
        return
      }

      // Auto-resume with a structured hidden prompt. The original user message
      // is never replayed, preventing completed tool calls from being repeated.
      // ANNOTATIONS ARE DELIBERATELY ABSENT HERE (QA a-i trap): unlike the
      // dead-session retry above, this is a CONTINUATION — the original turn
      // was already delivered and the model already saw the annotation block;
      // replaying it would double the content. Do not "fix" this by symmetry.
      if ((willRecoverAuth || willRecoverContext) && conversationId) {
        const suffix = partialText.length > 50
          ? `\n\nLast partial assistant output (may be truncated):\n"""\n${partialText.slice(-800)}\n"""`
          : ''
        const resumeMessage = t(willRecoverAuth ? 'auth.resumePrompt' : 'context.resumePrompt') + suffix
        const resume = createQueuedFollowUp(conversationId, resumeMessage, undefined, [], retryMeta?.sideChat ?? false)
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
          const recoveryHeadline = t(willRecoverAuth ? 'auth.recoveryFailed' : 'context.recoveryFailed', { message })
          const resumeTurnId = resume.request.turnId ?? ''
          // T23: the recovery error is the model's natural response, not a
          // "Sistema" badge. runTurn rejected before any stdout (T19 proved
          // the body is always empty), so appendAssistantText creates a fresh
          // segment; finishAssistantMessage closes it. The headline already
          // carries the raw message (interpolated by the i18n key), so no
          // separate errorDetail toggle is needed.
          appendAssistantText(conversationId, resumeTurnId, recoveryHeadline)
          finishAssistantMessage(conversationId, resumeTurnId)
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
      setApiRetryByTurn(prev => clearApiRetryNotice(prev, event.turnId))
      userInterruptedTurnsRef.current.delete(event.turnId)
      // A turn finished cleanly → clear any overflow-recovery guard so a future
      // overflow in this conversation can auto-recover again.
      if (conversationId) {
        overflowRecovering.current.delete(conversationId)
        authRecovering.current.delete(conversationId)
      }
      if (conversationId) markTurnFinished(conversationId, event.turnId)
      clearPermissionPromptForTurn(event.turnId)
      setTokenRate(undefined)
      // Force the tray to idle so a lagging 'thinking' event can never
      // resurrect the timer after the turn has completed.
      void window.verboo.forceIdleMenuBar()
      setThinkingTurnId(current => (current === event.turnId ? undefined : current))
      setThinkingSnippets([])
      setCompactingTurnId(current => (current === event.turnId ? undefined : current))
      setImageReadingTurnId(current => (current === event.turnId ? undefined : current))
      setVideoProgressByTurn(prev => clearVideoProgress(prev, event.turnId))
      flashPet(event.exitCode === 0 ? 'success' : 'error')
      // Fire OS notification when the turn completed in a background
      // conversation (not the active one) or the window is not focused.
      // The backend checks the user's completion_notifications setting.
      const notificationConversationId = conversationId
        ? findNotifiableConversationId(chatStoreRef.current.conversations, conversationId)
        : undefined
      if (notificationConversationId) {
        const isActive = notificationConversationId === activeConversationIdRef.current
        void window.verboo.fireCompletionNotification(
          event.exitCode ?? 0,
          notificationConversationId,
          isActive,
        )
      }
      // CONCLUSION SOUND (the app's second sound): a PLAIN turn ending
      // successfully. Goal turns are silent HERE — their completion
      // sound belongs to the goal's onComplete, so a batch sounds ONCE
      // at the end instead of at every turn (the sleeping-batch user
      // hears exactly one chime). Frontier /compact turns are plumbing,
      // not conclusions — also silent. Failed turns get NO sound: the
      // user's limit is two sounds and no error sound was asked for.
      if (
        conversationId
        && event.exitCode === 0
        && turnCompletionDeferred.current?.turnId !== event.turnId
        && compactCompletionDeferred.current?.turnId !== event.turnId
      ) {
        playAppSound('turnCompleted', conversationId)
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
        clearQuestionPromptForTurn(event.turnId)
        cleanupTurnState(event.turnId)
        // QA a-i: same replay rule as the error path — the retry carries the
        // click-time annotations from the payload, never a stripped copy.
        void runTurn(
          createQueuedFollowUp(
            conversationId,
            message,
            undefined,
            retryMeta.annotations ?? [],
            retryMeta.sideChat ?? false,
          ),
          { skipResume: true },
        )
        return
      }
      if (conversationId && event.exitCode !== 0) {
        const failureMessage = buildCliFailureMessage(turnTerminalErrors.current[event.turnId], t)
        if (failureMessage) appendAssistantText(conversationId, event.turnId, failureMessage)
      }
      if (conversationId) finishAssistantMessage(conversationId, event.turnId)
      if (conversationId) {
        const summaryPromise = appendTurnSummary(conversationId, event.turnId, event.exitCode)
        void summaryPromise
          .then(changeSummary => {
            if (event.exitCode === 0) {
              scheduleBrowserPostEditReload(event.turnId, conversationId, changeSummary?.totalFiles ?? 0)
            }
          })
          .catch(() => undefined)
        // D-C: the goal turn deferred resolves ONLY AFTER the summary
        // item exists (or the append failed — the loop must never hang
        // on it). Before this fix the resolve ran SYNCHRONOUSLY below,
        // the scheduler continued in a microtask, and the batch progress
        // stamp found no `${turnId}:summary` item — returning SILENTLY
        // and never retrying for that turnId (the field-test defect:
        // "Tarefa k de N" never reached the screen). The ordering
        // contract is owned by settleGoalTurnAfterSummary and tested in
        // turnCompletion.test.ts.
        settleGoalTurnAfterSummary(summaryPromise, {
          cleanup: () => cleanupTurnState(event.turnId),
          resolveGoalTurn: () => {
            if (turnCompletionDeferred.current?.turnId === event.turnId) {
              turnCompletionDeferred.current.resolve()
              turnCompletionDeferred.current = undefined
            }
          },
        })
      } else {
        cleanupTurnState(event.turnId)
        // No summary append in flight — resolve immediately.
        if (turnCompletionDeferred.current?.turnId === event.turnId) {
          turnCompletionDeferred.current.resolve()
          turnCompletionDeferred.current = undefined
        }
      }
      delete turnRetryPayload.current[event.turnId]

      // Resolve interject promise if one is pending for this turn
      if (interjectDeferred.current?.turnId === event.turnId) {
        interjectDeferred.current.resolve()
        interjectDeferred.current = undefined
      }
      // T3: resolve the frontier compaction deferred with the REAL exit
      // code — true only when the compact concluded cleanly (exit 0).
      if (compactCompletionDeferred.current?.turnId === event.turnId) {
        compactCompletionDeferred.current.resolve(event.exitCode === 0)
        compactCompletionDeferred.current = undefined
      }

    }
  }

  // Guard against re-entrant sendMessage (double-click, keyboard race with
  // attachment flow). Checked AND set in the same synchronous section so
  // concurrent awaits see the lock before the first call's first await.
  // The ref resets in the `finally` block at the end of the function.
  const sendMessageLock = useRef(false)
  async function sendMessage(message: string) {
    if (cliAgentActionsBlocked) return
    const trimmed = message.trim()
    // F3 — guarda do vazio ALARGADA: enviar SÓ a anotação é comportamento
    // exigido pelo usuário ("posso apenas enviar a anotação"). O retrato vem
    // do ref (criar a anotação e clicar enviar podem cair no mesmo tick; o
    // state do closure estaria um render atrás e mataria o envio).
    const pendingAnnotations = activeConversationId
      ? draftsForConversation(annotationDraftsRef.current, activeConversationId)
      : []
    if (!trimmed && pendingAnnotations.length === 0) return
    if (sendMessageLock.current) return // already in flight
    sendMessageLock.current = true
    try {
    const conversationId = ensureActiveConversation()
    let turnAttachments = attachedFiles

    // ── Vision fallback consent check ──
    const hasImages = turnAttachments.some(isVisualAttachment)
    const modelNeedsFallback = hasImages && !selectedModelInfo?.supportsVision
    if (modelNeedsFallback) {
      const consent = userSettings.visionFallbackConsent
      if (consent === 'never') {
        // Strip images silently — the user opted out.
        turnAttachments = turnAttachments.filter(file => !isVisualAttachment(file))
        filterAttachments(file => !isVisualAttachment(file))
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
            turnAttachments = turnAttachments.filter(file => !isVisualAttachment(file))
            filterAttachments(file => !isVisualAttachment(file))
          }
        }
        // 'allowOnce' → proceed with images attached (existing behavior).
      }
    }

    // ── Video fallback consent check ──────────────────────────
    // The current truthful route sends sampled frames and a transcript made
    // locally from the audio. It never sends the original video file.
    const route: VideoUnderstandingRoute = 'sampledFramesWithTranscript'
    const videoSendBlocked = await shouldBlockVideoBeforeCli(turnAttachments, {
      consent: userSettings.videoFallbackConsent,
      requestChoice: async () => {
        const choice = await new Promise<VideoFallbackResponse>(resolve => {
          videoFallbackResolveRef.current = resolve
          setVideoFallbackRoute(route)
        })
        setVideoFallbackRoute(undefined)
        videoFallbackResolveRef.current = undefined
        return choice
      },
      persistConsent: async videoFallbackConsent => {
        await updateUserSettings({ videoFallbackConsent })
      },
      onConsentUpdated: () => toast(t('videoConsent.updated')),
      onDenied: () => toast(t('videoConsent.denied'), 'error'),
    })
    if (videoSendBlocked) return

    // ── OCR race gate ────────────────────────────────────────
    // Wait for pending OCR to finish (up to 15s) so images already in
    // the process don't go unread. Non-blocking for attachments that
    // haven't started OCR yet.
    const pendingOcr = turnAttachments
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

    turnAttachments = await promoteVisualAttachments(turnAttachments, conversationId)
    // F3: pendingAnnotations foi lido do ref ANTES dos awaits acima — é o
    // retrato do clique, e é ele que viaja (congelado) no request da fila.
    const queued = createQueuedFollowUp(conversationId, trimmed, turnAttachments, pendingAnnotations)
    setActiveView('chat')
    stickToBottomRef.current = true
    setShowJumpToLatest(false)
    setPendingPermissionPrompts(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([, prompt]) => prompt.conversationId !== conversationId))
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })

    // F3: envio SÓ-anotação não cria bolha de usuário vazia — o registro do
    // envio é o item N3 (kind 'annotation') que o runTurn anexa após a
    // confirmação; bolha vazia seria ruído sem conteúdo (o veto de produto a
    // mensagem redundante segue valendo). Com texto, a bolha é a de sempre.
    if (trimmed) {
      appendConversationItem(conversationId, {
        id: `user:${Date.now()}`,
        role: 'user',
        text: trimmed,
        timestamp: Date.now(),
        skills: selectedSkillsUnion,
        // Persist a slim version of attachments — just path/name/kind — so the
        // transcript can render chips/thumbnails on reload without base64 bloat.
        attachments: turnAttachments.length ? turnAttachments.map(slimMeta) : undefined,
      }, titleFromMessage(trimmed))
    }

    if (isConversationRunning(conversationId)) {
      enqueueFollowUp(queued)
      clearAttachments(true)
      return
    }

    appendDowngradeActivity(conversationId)
    await runTurn(queued)
    // D-D item 2: reply-to-resume. The reply already landed in the
    // goal's session and transcript as a normal turn (above). If the
    // goal is paused by taskImpossible on THIS (owner) conversation,
    // answering IS the unblock — resume THIS SAME task with context
    // intact, via the SAME resume path the slash command uses (no
    // synthetic command: a `/goal` literal here would be misread by
    // the reservedSlashCommands contract as a CLI dispatch). Only on
    // the direct-send path: when a turn was already in flight the
    // reply QUEUES (early return above) and resuming would race the
    // scheduler against the live turn — resume manually then.
    if (shouldResumeGoalOnUserMessage(goalRef.current, conversationId)) {
      resumePausedGoal()
    }
    clearAttachments(true)
    } finally {
      sendMessageLock.current = false
    }
  }

  function markTurnStarted(conversationId: string, turnId: string) {
    const next = startTurn(
      { runningTurnByConversation: runningTurnByConversationRef.current },
      conversationId,
      turnId,
    )
    runningTurnByConversationRef.current = next.runningTurnByConversation
    setRunningTurnByConversation(next.runningTurnByConversation)
  }

  function markTurnFinished(conversationId: string, turnId: string) {
    if (runningTurnByConversationRef.current[conversationId] !== turnId) return
    const next = finishTurn(
      { runningTurnByConversation: runningTurnByConversationRef.current },
      conversationId,
      turnId,
    )
    runningTurnByConversationRef.current = next.runningTurnByConversation
    setRunningTurnByConversation(next.runningTurnByConversation)
  }

  async function interruptForUser(conversationId?: string): Promise<boolean> {
    const targetConversationId = conversationId ?? activeConversationIdRef.current
    const turnId = targetConversationId
      ? runningTurnByConversationRef.current[targetConversationId]
      : undefined
    if (turnId) userInterruptedTurnsRef.current.add(turnId)

    const interrupted = await window.verboo.interrupt(conversationId).catch(() => false)
    if (!interrupted && turnId) userInterruptedTurnsRef.current.delete(turnId)
    return interrupted
  }

  function clearPermissionPromptForTurn(turnId: string) {
    setPendingPermissionPrompts(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([, prompt]) => prompt.turnId !== turnId))
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
  }

  function clearQuestionPromptForTurn(turnId: string) {
    delete questionPromptsRef.current[turnId]
    setQuestionPrompts(current => {
      if (!current[turnId]) return current
      const next = { ...current }
      delete next[turnId]
      return next
    })
    setQuestionWizardOpenByTurn(current => {
      if (!(turnId in current)) return current
      const next = { ...current }
      delete next[turnId]
      return next
    })
  }

  function clearQuestionPromptsForConversation(conversationId: string) {
    const turnIds = Object.values(questionPromptsRef.current)
      .filter(prompt => prompt.conversationId === conversationId)
      .map(prompt => prompt.turnId)
    for (const turnId of turnIds) clearQuestionPromptForTurn(turnId)
  }

  function updateQuestionPromptAnswers(turnId: string, answers: QuestionAnswer[]) {
    const current = questionPromptsRef.current[turnId]
    if (!current) return
    const next = { ...current, answers }
    questionPromptsRef.current[turnId] = next
    setQuestionPrompts(prompts => ({ ...prompts, [turnId]: next }))
  }

  function isConversationRunning(conversationId: string): boolean {
    return Boolean(runningTurnByConversationRef.current[conversationId])
  }

  function createQueuedFollowUp(
    conversationId: string,
    message: string,
    attachments: AttachmentMeta[] = attachedFiles,
    // F3 (N10): o request nasce NO CLIQUE — as cópias congeladas que
    // applyAnnotations produz aqui são o que o turno carrega, mesmo que a
    // fila espere outro turno terminar e o usuário edite o rascunho nesse meio.
    annotations: readonly Annotation[] = [],
    sideChat = false,
  ): QueuedFollowUp {
    const turnModel = {
      modelId: selectedModel,
      modelDisplayName: selectedModelInfo?.displayName ?? selectedModel,
      // Stamp the provider at send time: the transcript header reads THIS,
      // not a re-resolution against a catalog that can degrade mid-turn.
      provider: selectedModelInfo?.provider,
    }
    const responseLanguage = inferResponseLanguage(message, conversationLanguageFallback(conversationId))

    return {
      id: `queue:${crypto.randomUUID()}`,
      conversationId,
      message,
      sideChat,
      turnModel,
      // applyAnnotations com lista vazia devolve a MESMA referência (a chave
      // nem existe) — o caminho sem anotações fica byte-idêntico ao pré-F3,
      // como manda o portão. Com anotações, o campo viaja ESTRUTURADO —
      // nunca concatenado em `message` (a montagem do bloco é Rust-side).
      request: applyAnnotations({
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
        attachments: expandVisualAttachmentSnapshots(attachments),
        responseEnhancementsEnabled: userSettings.responseEnhancementsEnabled,
        personality: userSettings.personality,
        customInstructions: userSettings.customInstructions,
        memoryContext: buildMemoryContext(chatStore, conversationId, userSettings),
      }, annotations),
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
    if (queuedFollowUpsRef.current.length === 0) return
    const runningConversationIds = new Set(Object.keys(runningTurnByConversationRef.current))
    const nextIndex = findNextRunnableQueueIndex(queuedFollowUpsRef.current, runningConversationIds)
    if (nextIndex < 0) return
    const next = queuedFollowUpsRef.current[nextIndex]
    if (!next) return
    const rest = queuedFollowUpsRef.current.filter((_, index) => index !== nextIndex)
    setQueuedFollowUpsList(() => rest)
    await runTurn(next)
  }

  // Interject a queued message: interrupt the current turn, wait for it to
  // end, then send the message with the conversation's sessionId so the model
  // resumes with the new input as context. The model sees the interjection
  // in its history and can pivot or continue as it sees fit.
  async function interjectMessage(queueItemId: string) {
    if (interjectDeferred.current) return // already interjecting
    const item = queuedFollowUpsRef.current.find(q => q.id === queueItemId)
    if (!item) return
    const conversationId = item.conversationId

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

    // Wait for the current turn to end (interrupt triggers done/error event).
    // Register the waiter before invoking IPC so a very fast Done event cannot
    // race past it. If the backend reports no active child, release the stale
    // frontend state and send the queued message normally instead of hanging.
    const deferred = { turnId: currentTurnId, resolve: () => {} }
    const interruptedTurn = new Promise<void>(resolve => {
      deferred.resolve = resolve
      interjectDeferred.current = deferred
    })
    const interrupted = await interruptForUser(conversationId)
    if (!interrupted) {
      deferred.resolve()
      interjectDeferred.current = undefined
    }
    await interruptedTurn

    // Now send the interjected message with the conversation's sessionId
    appendDowngradeActivity(conversationId)
    await runTurn(item)
  }

  function removeQueuedItem(queueItemId: string) {
    const item = queuedFollowUpsRef.current.find(q => q.id === queueItemId)
    if (!item) return
    void deleteVisualTempFiles(visualTempPaths(item.request.attachments ?? [])).catch(() => {})
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

  async function runTurn(item: QueuedFollowUp, options?: { skipResume?: boolean }): Promise<string> {
    pendingConversationId.current = item.conversationId
    setContextUsage(undefined)
    setTokenRate(undefined)

    const parentTurnId = item.request.turnId ?? crypto.randomUUID()
    turnConversationIds.current[parentTurnId] = item.conversationId
    // Reserve the conversation before the async request preparation. A queued
    // follow-up must not slip into this conversation during research-subagent
    // preparation, before the CLI has emitted `started`.
    markTurnStarted(item.conversationId, parentTurnId)
    let acceptedTurnId = parentTurnId
    try {
      const request = await prepareRequestWithResearchSubagents(item, parentTurnId)
      const resumeId = options?.skipResume ? undefined : conversationCliSessionId(item.conversationId)
      const turnId = await sendTrackedTurn({ ...request, turnId: parentTurnId }, resumeId)
      acceptedTurnId = turnId
      markTurnStarted(item.conversationId, turnId)
    // F3 — limpeza PÓS-confirmação + N3. O await acima resolveu: o Rust
    // aceitou o turno, ENTÃO (e só então) o rascunho é consumido — por id,
    // só os que viajaram no request; um rascunho criado DURANTE o voo fica.
    // Se sendTrackedTurn lançar, nada aqui executa e o rascunho sobrevive à
    // falha (a posição desta linha é pinada por teste estrutural).
    const sentAnnotations = request.annotations
    if (sentAnnotations?.length && !item.sideChat) {
      setAnnotationDrafts(current =>
        consumeAnnotationDrafts(current, item.conversationId, new Set(sentAnnotations.map(a => a.id))),
      )
      // N3 — "o chip vira turno": item autocontido com os pares quote+comment
      // CONGELADOS (o que o modelo recebeu, não o rascunho vivo). `text`
      // leva o fallback legível para builds antigas. O título da conversa só
      // é proposto no envio sem texto (com texto, a bolha do usuário já o deu).
      appendConversationItem(
        item.conversationId,
        buildAnnotationTurnItem(
          sentAnnotations,
          { quoteLabel: t('annotations.quoteLabel'), commentLabel: t('annotations.commentLabel') },
          annotationTurnItemId(sentAnnotations.map(annotation => annotation.id)),
          Date.now(),
        ),
        item.message.trim() ? undefined : titleFromMessage(sentAnnotations[0]?.quote ?? ''),
        turnId,
      )
    }
    turnConversationIds.current[turnId] = item.conversationId
    turnModels.current[turnId] = item.turnModel
    // Track last user text for one-shot session-resume recovery.
    // The payload carries the click-time annotations too (QA a-i): a
    // dead-session retry replays what the user SENT, not a stripped copy.
    // DECLARED ASYMMETRY (deliberate, accepted by the QA): a text+annotation
    // send retries; an annotation-ONLY send does NOT — shouldRetrySession
    // requires a non-empty message, so it fails VISIBLY instead of retrying.
    // Visible failure beats silent loss, but a reader must know the
    // asymmetry is a decision, not an oversight.
    turnRetryPayload.current[turnId] = {
      conversationId: item.conversationId,
      message: item.message,
      alreadyRetriedWithoutSession: Boolean(options?.skipResume),
      sideChat: item.sideChat,
      annotations: request.annotations,
    }
    tagAssistantMessage(item.conversationId, turnId, item.turnModel)
    if (pendingConversationId.current === item.conversationId) pendingConversationId.current = undefined
    // T3: return the REAL turnId (the one terminal done/error events
    // carry) so the compaction frontier can await THIS turn's
    // conclusion. Existing fire-and-forget callers (`void runTurn(...)`)
    // are unaffected.
      return turnId
    } catch (error) {
      markTurnFinished(item.conversationId, acceptedTurnId)
      throw error
    }
  }

  async function sendTrackedTurn(request: AgentTurnRequest, resumeSessionId?: string): Promise<string> {
    const baseline = await snapshotWorkspaceChanges(request.workingDirectory)
    const clientTurnId = request.turnId ?? crypto.randomUUID()
    const turnId = await window.verboo.sendTurn({ ...request, turnId: clientTurnId }, resumeSessionId)
    turnChangeBaselines.current[turnId] = baseline
    turnWorkingDirectories.current[turnId] = request.workingDirectory
    const browserAnnotations = request.attachments?.filter(attachment => attachment.kind === 'browser-annotation') ?? []
    if (browserAnnotations.length) turnBrowserAnnotations.current[turnId] = browserAnnotations
    const browserTempFiles = visualTempPaths(request.attachments ?? [])
    if (browserTempFiles.length) turnBrowserTempFiles.current[turnId] = browserTempFiles
    return turnId
  }

  async function prepareRequestWithResearchSubagents(
    item: QueuedFollowUp,
    parentTurnId: string,
  ): Promise<AgentTurnRequest> {
    const researchRequest = parseResearchSubagentRequest(item.message)
    if (!researchRequest) return { ...item.request, turnId: parentTurnId }

    const runId = `research:${item.id}`
    const labels = Array.from({ length: researchRequest.count }, (_, index) =>
      subagentNameFor(`${item.id}:${index}`, index),
    )
    const baseRequest = { ...item.request, turnId: parentTurnId }

    try {
      const results = await window.verboo.runResearchSubagents({
        runId,
        count: researchRequest.count,
        requestedCount: researchRequest.requestedCount,
        labels,
        baseRequest,
      })
      const researchContext = buildResearchResultsContext(results, labels, t)
      if (!researchContext) return baseRequest

      return {
        ...baseRequest,
        memoryContext: [item.request.memoryContext, researchContext].filter(Boolean).join('\n\n'),
      }
    } catch {
      return baseRequest
    }
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

    const localPreviewUrl = findLocalBrowserUrl(combined)
    if (
      browserAvailable
      && localPreviewUrl
      && activeConversationIdRef.current === conversationId
      && (!browser.browserOpen || browser.currentUrl !== localPreviewUrl)
      && browser.navigationRequest?.url !== localPreviewUrl
    ) {
      terminal.close()
      review.close()
      setSelectedSubagentId(undefined)
      browser.requestNavigation(localPreviewUrl)
    }

    const detail = detectPermissionRequest(combined)
    if (!detail) return

    const command = turnLastCommand.current[turnId] ?? extractCommandFromPermissionText(combined)
    const trusted = command ? findTrustedCommand(command, userSettingsRef.current) : undefined

    setPendingPermissionPrompts(current => {
      if (Object.values(current).some(prompt => prompt.turnId === turnId)) return current
      const prompt: PendingPermissionPrompt = {
        id: `permission:${turnId}:${Date.now()}`,
        turnId,
        conversationId,
        command,
        detail,
        autoApprove: Boolean(trusted),
      }
      return { ...current, [prompt.id]: prompt }
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

    setPendingPermissionPrompts(current => {
      if (!current[prompt.id]) return current
      const next = { ...current }
      delete next[prompt.id]
      return next
    })

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
      provider: selectedModelInfo?.provider,
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
    if (questionPromptsRef.current[turnId]) return
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
    questionPromptsRef.current[turnId] = nextPrompt
    setQuestionPrompts(current => ({ ...current, [turnId]: nextPrompt }))
    setQuestionWizardOpenByTurn(current => ({ ...current, [turnId]: autoOpen }))
  }

  async function submitQuestionAnswers(prompt: QuestionPromptState) {
    // Read through the ref: the wizard auto-advances 170ms after the last
    // click, and the state captured by its render closure can miss that
    // final answer (it shipped "(no answer)" for the last question).
    const currentPrompt = questionPromptsRef.current[prompt.turnId]
    if (!currentPrompt) return
    prompt = currentPrompt
    clearQuestionPromptForTurn(prompt.turnId)

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
    if (runningConversations.size === 0) return 'idle'
    const kind = petActivity?.kind
    const label = petActivity?.label ?? ''
    const deleting = /\b(rm|del|delete|remove|unlink)\b|apag|remov|exclu/i.test(label)
    if (kind === 'command' || kind === 'terminal') return deleting ? 'deleting' : 'command'
    if (kind === 'edit') return deleting ? 'deleting' : 'editing'
    if (kind === 'read' || kind === 'search') return 'reading'
    return 'thinking'
  }, [petFlash, runningConversations.size, petActivity])

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
    ...(browserAvailable
      ? [{ key: 'browser', label: t('palette.toggleBrowser'), icon: paletteIcons.browser, run: () => handleToggleBrowser() }]
      : []),
    { key: 'sidebar', label: t('palette.toggleSidebar'), icon: paletteIcons.sidebar, run: toggleSidebarVisibility },
    { key: 'pet', label: t('palette.togglePet'), icon: paletteIcons.pet, run: togglePet },
    {
      key: 'compact',
      label: t('palette.compactContext'),
      icon: paletteIcons.compact,
      run: () => handleCompactCommand({ kind: 'compact', raw: '/compact' }),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, currentWorkspaceDirectory, browserAvailable])

  function handleEditObjective(newObjective: string) {
    const conversationId = activeConversation?.id
    if (!conversationId) return
    const current = goalRef.current
    if (!current) return

    // T5 (v1): objective editing is DISABLED while a batch runs. Editing
    // the umbrella label would not retarget any task (the evaluator reads
    // the per-task snapshot, not the umbrella), and rewriting task texts
    // mid-flight has no safe semantics in v1 — skip/cancel remain the
    // supported escape hatches. The panel also disables the edit affordance
    // with this same message as its tooltip; this guard is the backstop for
    // any other entry point. Declared to the user, never a silent no-op.
    if (current.tasks?.length) {
      appendConversationItem(conversationId, goalSystemMessage(t('goal.batchEditDisabled')))
      return
    }

    const oldObjective = current.objective
    const updated: GoalState = {
      ...current,
      objective: newObjective,
      updatedAt: Date.now(),
      // G-C8-FIX item 5 (QA pendência 9): a new objective is a clean
      // slate for loop detection. The fingerprint ring and the
      // no-progress counter were built against the OLD objective —
      // if we don't reset them, the user can be blocked by a loop
      // signal that was inherited from a goal they just rewrote.
      // Same reasoning as a fresh createGoalState call, applied
      // in-place to an existing goal.
      recentFingerprints: [],
      noProgressCount: 0,
    }
    setGoal(updated)
    goalRef.current = updated
    // G-C5: persistence is handled by the dedicated useEffect watching
    // `goal` — no direct updateConversationGoal call here.

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
      void interjectMessage(queued.id).catch(err => {
        console.error('[goal] failed to interject objective update:', err)
      })
    }
  }

  // D-D item 2: the resume path, callable without synthesizing a slash
  // command — sendMessage's reply-to-resume uses it directly (and the
  // reservedSlashCommands contract heuristic must not see a `/goal`
  // literal near runTurn and misclassify it as CLI-dispatching).
  function resumePausedGoal() {
    setGoal(current => {
      if (!current || (current.status !== 'paused' && current.status !== 'blocked')) return current
      // G-C5-FIX: ensure ownerConversationId is set (legacy goals may
      // have been created before the field existed). Stamps with the
      // active conversation so the persist effect does not cross-write.
      const ownerConversationId = current.ownerConversationId ?? activeConversationId
      const resumed: GoalState = { ...current, ownerConversationId, status: 'active', noProgressCount: 0, errorCount: 0, recentFingerprints: [] }
      // G-C5-FIX: explicit handoff. goalRef.current must be populated
      // BEFORE startGoalScheduler runs. This updater runs synchronously
      // inside setGoal, but the side-effect (startGoalScheduler) must
      // observe goalRef.current already pointing at `resumed`.
      goalRef.current = resumed
      // D-D item 1: rehydrate the CLI session from the PERSISTED goal
      // before the first turn — after an app restart goalSessionId is
      // empty and without this the resume silently opened a NEW
      // session (context lost while the user believed it continued).
      goalSessionId.current = resumeGoalSessionId(resumed, goalSessionId.current)
      setGoalBarStatus({ kind: 'active', objective: resumed.objective, turn: resumed.turnsRun })
      void startGoalScheduler(resumed)
      return resumed
    })
  }

  function handleGoalCommand(command: Extract<ReservedSlashCommand, { kind: 'goal' }>) {
    if (cliAgentActionsBlocked && (command.action === 'start' || command.action === 'resume')) return

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
      resumePausedGoal()
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
      // T5 batch entry: a multi-line objective is parsed as a task batch —
      // one task per line, numbered/bullet markers stripped, [toolless] as
      // the per-task opt-out of the D1 evidence guard. A single line keeps
      // the LEGACY path field-by-field: no tasks array, no D1 guard, no
      // progress line, no per-task report (zero regression by construction).
      const batchParse = parseBatchInput(command.objective)

      if (batchParse.kind === 'empty') {
        // Nothing runnable (e.g. `/goal` followed only by blank lines or
        // bare list markers). Answer with the expected format and DON'T
        // touch any goal already in flight — a malformed new command must
        // not silently kill the running one.
        appendConversationItem(ensureActiveConversation(), goalSystemMessage(t('goal.batchEmpty')))
        return
      }

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

      // The batch umbrella objective is a label ("Batch of N tasks"), never
      // evaluated: the evaluator always receives the CURRENT task's text via
      // the per-task snapshot (T1). Single tasks keep the raw objective.
      const objective = batchParse.kind === 'batch'
        ? t('goal.batchObjective', { count: batchParse.tasks.length })
        : batchParse.objective

      const goalState = createGoalState({
        objective,
        accessMode: goalAccessMode, // continueGoal downgrades 'full' unless full access is enabled
        modelId: selectedModel,
        modelDisplayName: selectedModelInfo?.displayName,
        workingDirectory: wd,
        skills: selectedSkillsUnion,
        // Only a real batch (2+ tasks) carries the tasks array — a lone
        // task produces a goal identical to the pre-batch era.
        ...(batchParse.kind === 'batch' ? { tasks: batchParse.tasks } : {}),
      })
      // G-C5-FIX: stamp the goal with its owning conversation so the
      // persist effect does NOT cross-write into a different
      // conversation when the user switches mid-cycle.
      goalState.ownerConversationId = conversationId
      // The batch panel shows the user's message VERBATIM (their words,
      // their line breaks — per user request), not the synthetic
      // umbrella above. `command.objective` is the raw multi-line text
      // as typed, list markers included. Single-task goals have no
      // batchInput: their panel already shows `objective` itself.
      if (batchParse.kind === 'batch') goalState.batchInput = command.objective

      appendConversationItem(conversationId, goalSystemMessage(t('goal.systemStarted', { objective })))

      const message = batchParse.kind === 'batch'
        ? buildGoalBatchStartMessage(batchParse.tasks, wd)
        : buildGoalStartMessage(batchParse.objective, wd)
      appendConversationItem(conversationId, {
        id: `user:goal:${Date.now()}`,
        role: 'user',
        text: message,
        timestamp: Date.now(),
        skills: selectedSkillsUnion,
      }, t('goal.systemObjective', { objective }))

      setGoal(goalState)
      // G-C5-FIX: explicit handoff. goalRef.current must be populated
      // BEFORE startGoalScheduler runs, otherwise the delegate's
      // getGoal() returns undefined on the first iteration and the
      // cycle exits with 'cancelled' immediately (silent total
      // regression — the goal panel never executes). The setGoal
      // call above passes a direct value, so its functional updater
      // (which assigns goalRef.current) does NOT run synchronously.
      goalRef.current = goalState
      setGoalBarStatus({ kind: 'active', objective: goalState.objective, turn: 0 })

      void startGoalScheduler(goalState)
    }
  }

  async function startGoalScheduler(initialGoal: GoalState) {
    const controller = new AbortController()
    goalAbortRef.current = controller
    // G-C17: fresh goal, fresh dedupe key — envelopes from a previous
    // goal must never gate (or un-gate) this goal's accumulation.
    lastEvaluatorEnvelopeRef.current = undefined

    const delegate: GoalSchedulerDelegate = {
      // G-C5: no resurrection. If goalRef.current is undefined the goal
      // was cleared (cancel/clear) — the cycle must observe that and
      // exit, not resurrect a stale snapshot. runGoalCycle returns
      // 'cancelled' at the top when getGoal() is undefined.
      getGoal: () => goalRef.current,
      updateGoal: (update) => {
        setGoal(current => {
          // G-C5: if current is undefined the goal was cleared — do not
          // apply updates to a stale snapshot. Drop the update.
          if (current === undefined) return undefined
          const updated = typeof update === 'function' ? update(current) : update
          goalRef.current = updated
          return updated
        })
      },
      evaluateGoal: async (currentGoal) => {
        // G-C8-FIX: the goal belongs to the conversation that created
        // it (currentGoal.ownerConversationId), NOT to whatever the
        // user happens to be looking at. The earlier G-C8 fix read
        // activeConversationIdRef.current — which fixed the
        // same-tick birth case but introduced a cross-conversation
        // leak: if the user switched to conversation B mid-cycle, the
        // goal of A would write its evaluation transcript into B.
        // ownerConversationId is stamped at goal creation
        // (handleGoalCommand, G-C5-FIX) and is the source of truth.
        // Fallback to activeConversationIdRef.current only when the
        // goal predates the ownerConversationId field (legacy goals
        // persisted before G-C5-FIX).
        const conversationId = currentGoal.ownerConversationId ?? activeConversationIdRef.current
        if (!conversationId || controller.signal.aborted) {
          throw new Error('Goal evaluation aborted: no active conversation')
        }

        // G-C8-FIX item 4: the transcript sent to the evaluator must
        // be the OWNER's transcript, not the active conversation's.
        // conversationItemsRef.current tracks the active conversation
        // (App.tsx:587, updated at :902) — using it here would feed
        // the evaluator the wrong conversation when the user has
        // switched away. We resolve the owner's items from the store
        // ref directly. (See the parecer in the cycle report for why
        // this is the right call.)
        const ownerConversation = chatStoreRef.current.conversations.find(item => item.id === conversationId)
        const conversationItems = ownerConversation?.items ?? []
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

        // G-C17: ACCUMULATE the evaluator's token usage across EVERY
        // evaluation of this goal (was: lastEvaluatorUsage, overwritten
        // each cycle — in a multi-evaluation goal only the last parcel
        // reached the "Total registrado" line; QA blocking).
        // evaluatorUsage is a SIBLING of evaluation in the Tauri
        // boundary struct (GoalEvaluationEnvelope, G-C15-FIX), NOT
        // inside result.evaluation. Undefined when the evaluator ran no
        // tokens (Rust skip_serializing_if Option::is_none) — treat
        // absence, not null.
        //
        // Double-count guard: evaluate_goal is a single invoke → single
        // response (the G-C14 double-emission was turn EVENTS and does
        // not apply here), so each envelope accumulates exactly once.
        // The identity gate additionally blocks a re-presentation of
        // the SAME envelope object if a future refactor re-enters.
        const isNewEvaluation = shouldAccumulateEvaluatorUsage(lastEvaluatorEnvelopeRef.current, result)
        if (isNewEvaluation) {
          lastEvaluatorEnvelopeRef.current = result
        }
        setGoal(current => current ? {
          ...(isNewEvaluation ? accumulateEvaluatorUsage(current, result.evaluatorUsage) : current),
          lastEvaluation: result.evaluation,
          updatedAt: Date.now(),
        } : current)
        // G-C5/G-C8/G-C10/G-C13-FIX: synchronize goalRef.current so the
        // scheduler (and the completion path, which reads the
        // accumulated evaluatorInputTokens/evaluatorOutputTokens via the
        // live ref — goalScheduler.ts G-C17 adendo) sees the updated
        // value. setGoal's functional updater does NOT run
        // synchronously, so this sync stays OUTSIDE setGoal — and the
        // updater above stays pure so a StrictMode double-invoke cannot
        // double-apply the sum to the ref.
        if (goalRef.current) {
          goalRef.current = {
            ...(isNewEvaluation ? accumulateEvaluatorUsage(goalRef.current, result.evaluatorUsage) : goalRef.current),
            lastEvaluation: result.evaluation,
            updatedAt: Date.now(),
          }
        }

        return result.evaluation
      },
      // T1 (D1): the batch evidence guard reads the OWNER conversation's
      // LIVE transcript (same resolution as evaluateGoal above —
      // ownerConversationId, never the conversation the user happens to
      // be looking at, G-C8-FIX). Called by the scheduler only for batch
      // goals, after evaluateGoal, so the turn's action activities are
      // already appended. Returns the live array reference (read-only
      // use: the guard only counts).
      getConversationItems: () => {
        const conversationId = goalRef.current?.ownerConversationId ?? activeConversationIdRef.current
        if (!conversationId) return []
        return chatStoreRef.current.conversations.find(item => item.id === conversationId)?.items ?? []
      },
      continueGoal: async (currentGoal, nextMessage) => {
        if (controller.signal.aborted) return undefined

        // G-C8-FIX: same as evaluateGoal — the goal belongs to its
        // owner conversation, not the active one. Reading
        // activeConversationIdRef.current here caused cross-conversation
        // leaks (the continue message and the tracked turn were written
        // to whatever conversation the user was looking at, not the one
        // that owns the goal).
        const conversationId = currentGoal.ownerConversationId ?? activeConversationIdRef.current
        if (!conversationId) return undefined

        const turnModel = {
          modelId: selectedModel,
          modelDisplayName: selectedModelInfo?.displayName ?? selectedModel,
          provider: selectedModelInfo?.provider,
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
        // Same race as runTurn: `started` lands before this line, so the
        // placeholder segment was born unstamped — re-stamp it now (T10).
        tagAssistantMessage(conversationId, turnId, turnModel)

        setGoal(current => {
          if (!current) return current
          const updated = {
            ...current,
            turnsRun: current.turnsRun + 1,
            // T1: per-task counter, incremented exactly where the global
            // one is (the turn just ran). ONLY for batch goals — legacy
            // goals keep the key ABSENT so the per-task view falls back
            // to turnsRun untouched (aceite 4: no single-task regression).
            ...(current.turnsRunThisTask !== undefined
              ? { turnsRunThisTask: current.turnsRunThisTask + 1 }
              : {}),
            lastTurnId: turnId,
            lastSessionId: goalSessionId.current,
            updatedAt: Date.now(),
          }
          // G-C10 item 3: synchronize goalRef.current so the scheduler
          // sees the incremented turnsRun. Same desync class as the
          // token accumulator above — without this, the scheduler's
          // getGoal() returns a stale turnsRun and the loop detection
          // / completion logic reads the wrong turn count.
          goalRef.current = updated
          return updated
        })

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
      // T3: the COMPACTION FRONTIER — compacts the goal's OWNER
      // conversation between batch tasks and AWAITS the compact turn's
      // conclusion (the scheduler's frontier reset NEVER runs before
      // this promise settles). Mirrors handleCompactCommand's flow —
      // same CLI-session gate, same '/compact' string, same
      // skipContextEstimateUntil window — but awaited instead of
      // fire-and-forget, and with POSSE resolution
      // (ownerConversationId — G-C8-FIX), never the conversation the
      // user happens to be looking at.
      //
      // The compact turn goes through runTurn — NOT continueGoal — so
      // it does NOT increment turnsRun/turnsRunThisTask (it is
      // maintenance, not task work — Maestro's point 1). Its tokens are
      // accumulated exactly ONCE via the existing G-C14 turnId dedupe
      // in the result-event handler (point 2).
      //
      // Resolves false on ANY failure path (aborted, no conversation,
      // no CLI session, sendTurn threw, non-zero exit, abort
      // mid-compact): the batch proceeds WITHOUT compacting and the
      // scheduler declares the failure (compactionFailures) — a
      // compaction NEVER blocks the batch (point 3).
      compactOnTaskBoundary: async (currentGoal) => {
        if (controller.signal.aborted) return false
        const conversationId = currentGoal.ownerConversationId ?? activeConversationIdRef.current
        if (!conversationId) return false
        const sessionId = conversationCliSessionId(conversationId)
        if (!sessionId) return false

        skipContextEstimateUntil.current = Date.now() + 15_000

        let turnId: string
        try {
          turnId = await runTurn(createQueuedFollowUp(conversationId, '/compact'))
        } catch {
          return false
        }
        if (controller.signal.aborted) return false

        return new Promise<boolean>((resolve) => {
          compactCompletionDeferred.current = { turnId, resolve }
          // If aborted while waiting, resolve false to unblock the
          // scheduler — the batch must never hang on a compact.
          controller.signal.addEventListener('abort', () => {
            if (compactCompletionDeferred.current?.turnId === turnId) {
              compactCompletionDeferred.current = undefined
              resolve(false)
            }
          }, { once: true })
        })
      },
      abortTurn: () => {
        void interruptForUser()
        // Force the tray to idle immediately — don't wait for the CLI to
        // acknowledge the interrupt (it may be stuck reading stdout and
        // never emit the 'done' event). Prevents the timer from counting
        // forever after the user clicks abort.
        void window.verboo.forceIdleMenuBar()
      },
      onStatusChange: (status) => {
        setGoalBarStatus(status)
        // T4: the discreet batch progress line — "Tarefa k de N" stamped
        // on the LATEST turn's summary item, the same G-C15-TS surface
        // as the usage line (no badge, no box, no second item). Only the
        // 'evaluating' kind carries the fresh batchProgress payload (the
        // scheduler computes it from the loop-top snapshot); every other
        // kind passes through untouched — including legacy goals, which
        // never carry the payload and never get a line.
        // D-C: the stamp lives in features/goal/progressStamp.ts so its
        // failure modes are testable — a missing target is now a
        // console.error, never another silent loss.
        if (status.kind !== 'evaluating' || !status.batchProgress) return
        stampBatchProgressLine({
          goal: goalRef.current,
          fallbackConversationId: activeConversationIdRef.current,
          batchProgress: status.batchProgress,
          conversations: chatStoreRef.current.conversations,
          updateConversation,
          t,
        })
      },
      onLog: (message) => {
        console.log('[goal]', message)
      },
      // G-C15-TS: the user REJECTED the separate green box (G-C13's
      // approach). The evaluator's completionSummary is verbose, English,
      // and the user called it "irrelevant information" — it stays in
      // the backend (lastEvaluation) for diagnostics, NOT on the screen.
      //
      // New surface: the usage line is stamped on the LAST turn's
      // summary item (TranscriptItem.usageLine). The TurnView renders
      // it inline after the agent's final text — no box, no badge, same
      // typographic family as the surrounding message. Reads as
      // continuation of the agent's final message.
      //
      // Why stamp on the existing summary (not a new item): the last
      // turn already has a `${turnId}:summary` item (created by
      // appendTurnSummary). Adding a separate item created a second
      // green box. Stamping usageLine on the existing item keeps ONE
      // visual surface per turn and lets the TurnView render the usage
      // line inline with the agent's final text.
      //
      // ZERO-TOKEN GUARD: buildGoalUsageLine returns '' when the goal
      // has no token usage (legacy goal pre-G-C12, or zero turns). We
      // skip stamping in that case — the user sees the agent's final
      // text and the existing turn summary, no usage line.
      onComplete: (finalGoal, evaluation) => {
        const ownerConversationId = finalGoal.ownerConversationId ?? activeConversationIdRef.current
        // CONCLUSION SOUND for the goal/batch — fired BEFORE the report
        // guards below: the completion is real even when the report is
        // lost (a lost report is logged; a lost sound would be silence
        // on the exact event the sleeping user is waiting for).
        playAppSound('goalCompleted', ownerConversationId)
        // D-B/D-C: the report + usage + elapsed are the user's visible
        // completion deliverable — every drop below is LOGGED, never
        // another silent loss (the field-test complaint class).
        if (!ownerConversationId) {
          console.error('[goal] onComplete: no owner conversation — the final report was LOST (goal', finalGoal.id, ')')
          return
        }

        // G-C17: buildGoalUsageLine reads the ACCUMULATED
        // goal.evaluatorInputTokens/evaluatorOutputTokens (summed by
        // the evaluateGoal delegate from the Tauri boundary sibling —
        // G-C15-FIX), NOT evaluation.evaluatorUsage (which never
        // existed). finalGoal carries the fresh totals because the
        // scheduler overlays them from the live ref (goalScheduler.ts
        // G-C17 adendo).
        const usageLine = buildGoalUsageLine(finalGoal, t)
        // T4: the batch FINAL REPORT — one line per task with its cited
        // evidence (turns/actions, failure reason, "skipped by you"),
        // plus the compaction-failure footer. [] for legacy goals. Same
        // surface as the usage line: stamped on this same summary item,
        // no box, no badge, no second message.
        const batchReportLines = buildBatchReportLines(finalGoal, t)
        // ZERO-TOKEN GUARD (above) for the usage line; the report is the
        // batch's core deliverable and stamps even when a toolless batch
        // accumulated no tokens — but a legacy goal with no tokens stamps
        // nothing, exactly as before.
        if (!usageLine && batchReportLines.length === 0) return

        const lastTurnId = finalGoal.lastTurnId
        if (!lastTurnId) {
          console.error('[goal] onComplete: goal has no lastTurnId — no summary item to stamp the final report on; report LOST (goal', finalGoal.id, ')')
          return
        }

        const summaryItemId = `${lastTurnId}:summary`
        // Idempotency: if the summary item already has a usageLine
        // stamped, don't overwrite (defensive — the scheduler's
        // runGoalCycle returns 'completed' and exits, but a future
        // refactor could re-enter).
        const conv = chatStoreRef.current.conversations.find(c => c.id === ownerConversationId)
        if (!conv) {
          console.error('[goal] onComplete: owner conversation', ownerConversationId, 'not found — the final report was LOST')
          return
        }
        const existingItem = conv.items.find(i => i.id === summaryItemId)
        if (!existingItem) {
          console.error('[goal] onComplete: summary item', summaryItemId, 'not found in conversation', ownerConversationId, '— the final report was LOST')
          return
        }
        if (existingItem.usageLine && (batchReportLines.length === 0 || existingItem.batchReportLines)) return

        updateConversation(ownerConversationId, c => ({
          ...c,
          items: c.items.map(i =>
            i.id === summaryItemId
              ? {
                  ...i,
                  ...(usageLine ? { usageLine } : {}),
                  ...(batchReportLines.length > 0 ? { batchReportLines } : {}),
                  // T4: the report SUPERSEDES the progress line — clear
                  // it on the final item so the two never coexist (a
                  // duplicate line is the noise class the user rejected).
                  progressLine: undefined,
                }
              : i,
          ),
          updatedAt: Date.now(),
        }))
      },
      t,
    }

    try {
      await runGoalCycle(delegate)
    } catch (err) {
      // Fire-and-forget guard: if runGoalCycle throws unexpectedly,
      // pause the goal so the badge does NOT stay stuck in EXECUTANDO.
      const message = err instanceof Error ? err.message : String(err)
      console.error('[goal] Unexpected scheduler error:', message)
      const current = goalRef.current
      if (current && current.status !== 'paused' && current.status !== 'completed' && current.status !== 'cancelled') {
        setGoal({ ...current, status: 'paused', pausedAt: Date.now(), pauseReason: 'goalError' })
        setGoalBarStatus({ kind: 'stopped', objective: current.objective, reason: 'goalError' })
      }
    }
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

  // T5: kickoff message for a batch goal. Lists every task so the agent
  // sees the full plan up front, but instructs it to work ONLY the first
  // task — the scheduler drives each frontier (compaction + next task) via
  // its own per-task prompt, so this message must not invite parallel work.
  function buildGoalBatchStartMessage(tasks: { text: string }[], workingDirectory: string): string {
    return [
      `## Goal: batch of ${tasks.length} tasks`,
      '',
      'You are now working autonomously through a BATCH of tasks, in order.',
      ...tasks.map((task, index) => `${index + 1}. ${task.text}`),
      '',
      'Start with task 1 ONLY. Work it to completion and summarize what was',
      'done. Do NOT start later tasks — the system advances to each next',
      'task automatically, with a fresh context, when the current one ends.',
      'Do NOT ask for confirmation for each step.',
      '',
      `Working directory: ${workingDirectory}`,
    ].filter(Boolean).join('\n')
  }

  // G-C5: goal persistence moved to a dedicated useEffect watching
  // `goal` (see above). Direct call from updateGoal delegate removed —
  // no side effects inside React state updaters.

  async function sendFeedback(request: FeedbackRequest): Promise<FeedbackResult> {
    return window.verboo.sendFeedback(request)
  }

  async function attachFiles() {
    const batch = attachmentQueueRef.current.reserve()
    try {
      const attachments = await window.verboo.pickFiles()
      completeAttachmentBatch(batch, attachments)
    } catch (error) {
      failAttachmentBatch(batch)
      toast(t(attachmentInspectionErrorKey(error)), 'error')
    }
  }

  function addBrowserAnnotation(attachment: AttachmentMeta) {
    const batch = attachmentQueueRef.current.reserve()
    completeAttachmentBatch(batch, [attachment])
  }

  function scheduleBrowserPostEditReload(turnId: string, conversationId: string, workspaceChangeCount: number) {
    if (!browserAvailable) return
    const annotations = turnBrowserAnnotations.current[turnId]
    if (!shouldScheduleBrowserReload({
      annotationCount: annotations?.length ?? 0,
      workspaceChangeCount,
      browserOpen: browser.browserOpen,
      browserUrl: browser.currentUrl,
    })) return
    const firstAnnotation = annotations[0].browserAnnotation
    if (!firstAnnotation?.rect || firstAnnotation.url !== browser.currentUrl) return
    browser.requestReload({
      id: turnId,
      conversationId,
      url: firstAnnotation.url,
      targetRect: firstAnnotation.rect,
      autoVerify: userSettingsRef.current.browserVerificationEnabled,
      verificationPrompt: postEditVerificationPrompt(annotations, userSettingsRef.current.language),
      tabId: browser.activeTab?.id ?? '',
      generation: browser.activeTab?.generation ?? 0,
    })
  }

  function handleBrowserReloadSnapshot(attachment: AttachmentMeta, request: BrowserReloadRequest) {
    if (!request.autoVerify) {
      if (activeConversationIdRef.current !== request.conversationId) {
        const previous = pendingBrowserSnapshots.current[request.conversationId] ?? []
        if (previous.length) void deleteVisualTempFiles(visualTempPaths(previous)).catch(() => {})
        pendingBrowserSnapshots.current[request.conversationId] = [attachment]
        return
      }
      const batch = attachmentQueueRef.current.reserve()
      completeAttachmentBatch(batch, [attachment])
      return
    }
    appendConversationItem(request.conversationId, {
      id: `browser-verification:${request.id}`,
      role: 'tool',
      kind: 'activity',
      activityKind: 'image',
      text: t('browser.verificationActivity'),
      activityDetail: t('browser.verificationActivityDetail'),
      timestamp: Date.now(),
    })
    const verification = createQueuedFollowUp(request.conversationId, request.verificationPrompt)
    verification.request.attachments = [attachment]
    enqueueFollowUp(verification)
  }

  async function attachDroppedFiles(paths: string[], files: File[]) {
    if (!paths.length && !files.length) return
    const batch = attachmentQueueRef.current.reserve()
    try {
      const attachments = files.length
        ? await inspectDroppedBrowserFiles(files)
        : await window.verboo.inspectFiles(paths)
      completeAttachmentBatch(batch, attachments)
    } catch (error) {
      failAttachmentBatch(batch)
      toast(t(attachmentInspectionErrorKey(error)), 'error')
    }
  }

  // Paste handler: same pipeline as attachDroppedFiles, but also handles raw
  // image blobs (screenshots) that have no filesystem path. Those are read as
  // base64 and sent to the backend via pasteImageBlob for temp-file creation.
  async function attachPastedFiles(paths: string[], files: File[]) {
    if (!paths.length && !files.length) return
    const batch = attachmentQueueRef.current.reserve()
    try {
      const attachments = files.length
        ? await inspectBrowserFilesInOrder(files)
        : await window.verboo.inspectFiles(paths)
      completeAttachmentBatch(batch, attachments)
    } catch (error) {
      failAttachmentBatch(batch)
      toast(t(attachmentInspectionErrorKey(error)), 'error')
    }
  }

  async function inspectDroppedBrowserFiles(files: File[]): Promise<AttachmentMeta[]> {
    return inspectBrowserFilesInOrder(files)
  }

  async function inspectBrowserFilesInOrder(files: File[]): Promise<AttachmentMeta[]> {
    const controller = new AbortController()
    attachmentUploadControllersRef.current.add(controller)
    try {
      const attachments: AttachmentMeta[] = []
      for (const file of files) {
        controller.signal.throwIfAborted()
        const path = (file as File & { path?: string }).path
        const inspected = path
          ? await window.verboo.inspectFiles([path])
          : await inspectPathlessFiles(
              [file],
              inspectPastedImage,
              item => uploadPastedFile(item, window.verboo, controller.signal),
            )
        controller.signal.throwIfAborted()
        attachments.push(...inspected)
      }
      return attachments
    } catch (error) {
      controller.abort()
      throw error
    } finally {
      attachmentUploadControllersRef.current.delete(controller)
    }
  }

  async function inspectPastedImage(file: File): Promise<AttachmentMeta[]> {
    const reader = new FileReader()
    const base64 = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve((reader.result as string).split(',')[1])
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read pasted image'))
      reader.onabort = () => reject(new Error('Pasted image read was aborted'))
      reader.readAsDataURL(file)
    })
    const name = `pasted-${Date.now()}.${file.type.split('/')[1] || 'png'}`
    return window.verboo.pasteImageBlob(base64, name)
  }

  function completeAttachmentBatch(batch: number, attachments: AttachmentMeta[]) {
    const outcome = attachmentQueueRef.current.complete(batch, attachments)
    applyAttachmentOutcome(outcome)
  }

  function applyAttachmentOutcome(outcome: ReturnType<OrderedAttachmentQueue<AttachmentMeta>['complete']>) {
    setAttachedFiles(outcome.attachments)
    if (outcome.rejectedVideo) toast(t('attachments.error.secondVideo'), 'error')
    if (outcome.added.length) processAddedAttachments(outcome.added)
  }

  function failAttachmentBatch(batch: number) {
    const outcome = attachmentQueueRef.current.fail(batch)
    applyAttachmentOutcome(outcome)
  }

  function clearAttachments(preserveVisualTempFiles = false) {
    const current = attachmentQueueRef.current.snapshot()
    for (const controller of attachmentUploadControllersRef.current) controller.abort()
    attachmentUploadControllersRef.current.clear()
    attachmentQueueRef.current.reset()
    setAttachedFiles([])
    if (!preserveVisualTempFiles) {
      void deleteVisualTempFiles(visualTempPaths(current)).catch(() => {})
    }
  }

  function removeAttachment(path: string) {
    const removed = attachmentQueueRef.current.snapshot().find(attachment => attachment.path === path)
    setAttachedFiles(attachmentQueueRef.current.remove(path))
    setOcrProcessingPaths(current => current.filter(item => item !== path))
    if (removed) void deleteVisualTempFiles(visualTempPaths([removed])).catch(() => {})
  }

  function filterAttachments(keep: (attachment: AttachmentMeta) => boolean) {
    const removed = attachmentQueueRef.current.snapshot().filter(attachment => !keep(attachment))
    setAttachedFiles(attachmentQueueRef.current.filter(keep))
    void deleteVisualTempFiles(visualTempPaths(removed)).catch(() => {})
  }

  function updateAttachment(path: string, transform: (attachment: AttachmentMeta) => AttachmentMeta) {
    setAttachedFiles(attachmentQueueRef.current.update(path, transform))
  }

  function processAddedAttachments(attachments: AttachmentMeta[]) {
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
            updateAttachment(att.path, a => ({ ...a, extractionStatus: 'warning' as ExtractionStatus }))
            return
          }
          const status: ExtractionStatus = result.isEmpty ? 'warning' : 'extracted'
          updateAttachment(att.path, a => ({ ...a, extractedText: result.text, extractionStatus: status }))
        })
        .catch(() => {
          // Unhandled rejection — worker crashed.
          ocrCompletionsRef.current[att.path]?.resolve()
          delete ocrCompletionsRef.current[att.path]
          setOcrProcessingPaths(current => current.filter(p => p !== att.path))
          updateAttachment(att.path, a => ({ ...a, extractionStatus: 'warning' as ExtractionStatus }))
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
    discardSideChatForNavigation()
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
    discardSideChatForNavigation()
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
    clearAttachments()
    setActiveView('chat')
  }

  function openSideChat(context: Annotation) {
    const previousId = sideChatRef.current?.conversation.id
    if (previousId && isConversationRunning(previousId)) {
      void window.verboo.interrupt(previousId).catch(() => {})
    }
    const next = createSideChatState(
      context,
      undefined,
      undefined,
      activeConversationId,
      currentWorkspaceDirectory,
    )
    sideChatRef.current = next
    setSideChat(next)
  }

  function closeSideChat() {
    discardSideChatForNavigation()
  }

  function discardSideChatForNavigation() {
    const conversationId = sideChatRef.current?.conversation.id
    if (conversationId && isConversationRunning(conversationId)) {
      void window.verboo.interrupt(conversationId).catch(() => {})
    }
    if (conversationId) {
      setTodosByConversation(current => removeChecklistForConversation(current, conversationId))
      setPendingPermissionPrompts(current => {
        const next = Object.fromEntries(Object.entries(current).filter(([, prompt]) => prompt.conversationId !== conversationId))
        return Object.keys(next).length === Object.keys(current).length ? current : next
      })
      clearQuestionPromptsForConversation(conversationId)
    }
    sideChatRef.current = undefined
    setSideChat(undefined)
  }

  async function sendSideChatMessage(message: string) {
    if (cliAgentActionsBlocked) return
    const state = sideChatRef.current
    const trimmed = message.trim()
    if (!state || !trimmed || isConversationRunning(state.conversation.id)) return

    const conversationId = state.conversation.id
    appendConversationItem(conversationId, {
      id: `${conversationId}:user:${Date.now()}`,
      role: 'user',
      text: trimmed,
      timestamp: Date.now(),
    })
    const queued = createQueuedFollowUp(conversationId, trimmed, [], [], true)
    queued.request = buildSideChatRequest(queued.request, state.context)
    await runTurn(queued)
  }

  function selectProject(projectId: string) {
    const project = chatStore.projects.find(item => item.id === projectId && !item.archivedAt)
    if (!project) return
    discardSideChatForNavigation()
    setSelectedProjectId(project.id)
    setActiveConversationId(undefined)
    if (project.path) setConfig(current => ({ ...current, workingDirectory: project.path ?? current.workingDirectory }))
    setActiveView('chat')
  }

  function clearProjectSelection() {
    discardSideChatForNavigation()
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
    if (shouldDiscardSideChatForNavigation(sideChatRef.current, conversationId)) {
      discardSideChatForNavigation()
    }
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
      // G-C7-TS-MIGRACAO: sanitize before re-hydrating. See the matching
      // comment in the hydration effect — this is the second of two
      // call sites that reconstruct a GoalState from persisted data.
      const sanitized = sanitizeStoredGoal(storedGoal)
      const restored: GoalState = sanitized.status === 'active' || sanitized.status === 'evaluating' || sanitized.status === 'continuing'
        ? { ...sanitized, status: 'paused', pausedAt: sanitized.pausedAt ?? Date.now() }
        : sanitized
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
        const pending = pendingBrowserSnapshots.current[conversationId] ?? []
        if (pending.length) void deleteVisualTempFiles(visualTempPaths(pending)).catch(() => {})
        delete pendingBrowserSnapshots.current[conversationId]
        setQueuedFollowUpsList(current => current.filter(item => item.conversationId !== conversationId))
        setTodosByConversation(current => removeChecklistForConversation(current, conversationId))
        void deleteVisualCaptureOwner(conversationId).catch(() => {})
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

  function appendConversationItem(conversationId: string, item: TranscriptItem, title?: string, beforeTurnId?: string) {
    updateConversation(conversationId, conversation => ({
      ...conversation,
      title: conversation.title === DEFAULT_CONVERSATION_TITLE && title ? title : conversation.title,
      items: beforeTurnId
        ? insertAnnotationTurnBeforeResponse(conversation.items, item, beforeTurnId)
        : [...conversation.items, item],
      updatedAt: Date.now(),
    }))
  }

  function conversationCliSessionId(conversationId: string): string | undefined {
    const persistedSessionId = chatStoreRef.current.conversations.find(conversation => conversation.id === conversationId)?.cliSessionId
    return resolveSideChatSessionId(sideChatRef.current, conversationId, persistedSessionId)
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
    turnModel: { modelId?: string; modelDisplayName?: string; provider?: string },
  ) {
    // The Rust side emits `started` BEFORE the send_turn invoke resolves, so
    // the placeholder (`${turnId}:text:1`) is usually born BEFORE
    // turnModels.current[turnId] is populated — and appendAssistantText's
    // merge path only merges text. Nothing re-stamped the segment: this map
    // used to target `item.id === turnId`, an id NO transcript item ever has
    // (dead no-op), which is why pure-text turns persisted with no model
    // fields and the header fell back to the literal 'Verboo' (T10, measured
    // in the owner's verboo:chat-store:v1). Stamp every text segment of the
    // turn — same id family finishAssistantMessage already matches.
    updateConversation(conversationId, conversation => ({
      ...conversation,
      items: conversation.items.map(item =>
        item.id === turnId || item.id.startsWith(`${turnId}:text:`)
          ? { ...item, ...turnModel }
          : item,
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

  /** T23: stamp errorDetail on the turn's open assistant text segment so the
   *  "Mostrar detalhes técnicos" toggle (TurnErrorDetails, Transcript.tsx:461)
   *  renders on the turn body — not a separate "Sistema" badge. No-op when
   *  there is no open segment or no detail to attach. */
  function stampErrorDetailOnAssistantText(conversationId: string, turnId: string, errorDetail: string | undefined) {
    if (!errorDetail) return
    const segId = turnOpenTextSegment.current[turnId]
    if (!segId) return
    updateConversation(conversationId, conversation => ({
      ...conversation,
      items: conversation.items.map(item => item.id === segId ? { ...item, errorDetail } : item),
      updatedAt: Date.now(),
    }))
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
    delete turnResultEmittedText.current[turnId]
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
    const seenToolUseIds = new Set([
      ...Object.keys(turnCommandItemIds.current[turnId] ?? {}),
      ...Object.keys(turnToolUseItemIds.current[turnId] ?? {}),
    ])
    if (!registerRuntimeActivity(activity, keys, seenToolUseIds)) return
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

    // Subagent details live in the optional side panel. Keep the aggregate
    // count for the parent turn summary, but do not insert a large standalone
    // activity row into the main transcript.
    if (activity.kind === 'subagent') return

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
    return changeSummary
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
    const tempFiles = turnBrowserTempFiles.current[turnId]
    if (tempFiles?.length) void deleteVisualTempFiles(tempFiles).catch(() => {})
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
    delete turnResultEmittedText.current[turnId]
    delete turnLastCommand.current[turnId]
    delete turnCommands.current[turnId]
    delete turnReferences.current[turnId]
    delete turnChangeBaselines.current[turnId]
    delete turnWorkingDirectories.current[turnId]
    delete turnTouchedFiles.current[turnId]
    delete turnBrowserAnnotations.current[turnId]
    delete turnBrowserTempFiles.current[turnId]
    delete turnOpenTextSegment.current[turnId]
    delete turnTextSegmentCount.current[turnId]
    delete turnCommandItemIds.current[turnId]
    delete turnToolUseItemIds.current[turnId]
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
    if (sideChatRef.current?.conversation.id === conversationId) {
      setSideChat(current => updateSideChatState(current, conversationId, updater))
      return
    }
    // G-C5: delegate to the pure helper in chatStore so the
    // identity-preserving behavior is testable in isolation.
    updateChatStore(store => updateConversationPure(store, conversationId, updater))
  }

  function updateChatStore(updater: (store: ChatStore) => ChatStore) {
    // Persistence is debounced (see the effect below). During streaming, state
    // updates fire on every token delta; serializing the whole store to
    // localStorage on each one was pegging the main thread and thrashing GC.
    setChatStore(current => updater(current))
  }

  function workingDirectoryForConversation(conversationId: string): string {
    const sideChatDirectory = resolveSideChatWorkingDirectory(sideChatRef.current, conversationId, '')
    if (sideChatDirectory) return sideChatDirectory
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
    if (!workspacePanelsEnabled) return
    setReviewUnavailableReason(undefined)
    review.close()
    browser.close()
    simulator.close()
    setSelectedSubagentId(undefined)
    void terminal.toggle(cwd)
  }, [review, terminal, browser, simulator, workspacePanelsEnabled])

  const handleToggleSubagents = useCallback(() => {
    if (selectedSubagentId) {
      setSelectedSubagentId(undefined)
      return
    }
    const latest = latestSubagentThread(subagentThreads)
    if (!latest) return
    terminal.close()
    review.close()
    browser.close()
    simulator.close()
    setSelectedSubagentId(latest.id)
  }, [review, browser, simulator, selectedSubagentId, subagentThreads, terminal])

  const handleToggleReview = useCallback(async () => {
    if (!workspacePanelsEnabled) return
    if (review.reviewOpen) {
      review.close()
      return
    }

    terminal.close()
    browser.close()
    simulator.close()
    setSelectedSubagentId(undefined)

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
  }, [currentWorkspaceDirectory, review, terminal, browser, simulator, t, workspacePanelsEnabled])

  const handleOpenReview = useCallback((files: WorkspaceChangeEntry[], index: number) => {
    const workingDirectory = currentWorkspaceDirectory
    if (!workingDirectory) return
    terminal.close()
    browser.close()
    simulator.close()
    setSelectedSubagentId(undefined)
    review.open(workingDirectory, files, index)
  }, [currentWorkspaceDirectory, review, terminal, browser, simulator])

  const handleToggleBrowser = useCallback(() => {
    if (!browserAvailable || !workspacePanelsEnabled) return
    if (browser.browserOpen) {
      browser.toggle()
      return
    }
    terminal.close()
    review.close()
    simulator.close()
    setSelectedSubagentId(undefined)
    browser.toggle()
  }, [browser, browserAvailable, simulator, terminal, review, workspacePanelsEnabled])

  const handleToggleSimulator = useCallback(() => {
    if (!simulatorAvailable || !workspacePanelsEnabled) return
    if (simulator.simulatorOpen) {
      simulator.close()
      return
    }
    terminal.close()
    review.close()
    browser.close()
    setSelectedSubagentId(undefined)
    simulator.open()
  }, [browser, review, simulator, simulatorAvailable, terminal, workspacePanelsEnabled])

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
      if (!workspacePanelsEnabled) return
      handleToggleTerminal(workspaceDirectory || '')
    }

    window.addEventListener('keydown', handleTerminalShortcut, { capture: true })
    return () => window.removeEventListener('keydown', handleTerminalShortcut, { capture: true })
  }, [handleToggleTerminal, workspaceDirectory, workspacePanelsEnabled])

  useEffect(() => {
    function handleBrowserShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'b') return
      if (!browserAvailable) return
      event.preventDefault()
      event.stopPropagation()
      if (!workspacePanelsEnabled) return
      handleToggleBrowser()
    }

    window.addEventListener('keydown', handleBrowserShortcut, { capture: true })
    return () => window.removeEventListener('keydown', handleBrowserShortcut, { capture: true })
  }, [browserAvailable, handleToggleBrowser, workspacePanelsEnabled])

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
    const subagentsRunning = workingSubagentCount > 0
    const state: Partial<MenuBarState> = {
      execution: anyRunningTurnId ? subagentsRunning ? 'tool' : 'thinking' : 'idle',
      label: anyRunningTurnId ? subagentsRunning ? 'subagent' : 'working' : 'ready',
      startedAt: anyRunningTurnId ? turnStartedAt.current[anyRunningTurnId] : undefined,
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
    workingSubagentCount,
    cliAuth.email,
    cliAuth.loggedIn,
    effectiveContextUsage?.percentage,
    credentials.hasApiKey,
    profile.user?.email,
    anyRunningTurnId,
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
          checking={authChecking}
          authError={authError}
          authErrorDetail={authErrorDetail}
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
          onOpenFeedback={() => setFeedbackOpen(true)}
          onLoginComplete={(event) => {
            // A1: the CLI reported a successful login. Re-validate
            // against the REAL backend state (validateAccess re-fetches
            // credential/CLI/model status and unlocks only when
            // verified) — the event's status snapshot is just a fast
            // hint, never the unlock authority. authChecking shows the
            // "validating" progress on the login screen meanwhile.
            if (event.status) setCliAuth(event.status)
            void validateAccess(true)
          }}
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
        terminalOpen={visibleTerminalOpen}
        terminalUnavailableReason={terminal.terminalUnavailableReason}
        onToggleTerminal={() => handleToggleTerminal(workspaceDirectory || '')}
        reviewOpen={visibleReviewOpen}
        reviewUnavailableReason={reviewUnavailableReason}
        onToggleReview={handleToggleReview}
        browserAvailable={browserAvailable}
        browserOpen={visibleBrowserOpen}
        onToggleBrowser={handleToggleBrowser}
        simulatorAvailable={simulatorAvailable}
        simulatorOpen={visibleSimulatorOpen}
        recordingActive={simulator.recordingActive}
        onToggleSimulator={handleToggleSimulator}
        workspacePanelsEnabled={workspacePanelsEnabled}
      />

      <div
        className={`app-layout sidebar-${sidebarMode} ${sidebarPeek ? 'sidebar-peek' : ''} ${sideChat ? 'sidechat-open' : ''} ${activeView === 'settings' ? 'settings-open' : ''} ${activeView === 'settings' ? 'view-fullscreen' : ''} ${visibleTerminalOpen ? 'terminal-open' : ''} ${visibleReviewOpen ? 'review-open' : ''} ${visibleBrowserOpen ? 'browser-open' : ''} ${visibleSimulatorOpen ? 'simulator-open' : ''}`}
      >
        {activeView !== 'settings' && sidebarMode === 'hidden' && !sidebarPeek && !sidebarPeekLeaving && (
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

        {activeView !== 'settings' && (sidebarMode !== 'hidden' || sidebarPeek || sidebarPeekLeaving) && (
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
              updatePresentation={cliAgentActionsBlocked ? undefined : updateRestart.presentation}
              onRequestUpdate={() => { void updateRestart.requestUpdate() }}
              compact={sidebarMode === 'compact'}
              peek={sidebarPeek || sidebarPeekLeaving}
              onSelectView={setActiveView}
              onOpenSettings={() => {
                setSettingsTab('security')
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
              archivedConversations={archivedChats}
              onRestoreConversation={restoreConversation}
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
          onFocusCapture={() => {
            focusedConversationLaneRef.current = 'main'
            focusedConversationIdRef.current = activeConversationIdRef.current
          }}
          onPointerDownCapture={() => {
            focusedConversationLaneRef.current = 'main'
            focusedConversationIdRef.current = activeConversationIdRef.current
          }}
        >
          {activeView === 'chat' && (
            <div className="workspace-folder-badge" title={workspaceDirectory || t('workspace.noProjectOpen')}>
              <FolderClosed size={14} />
              <span>{workspaceFolderName(workspaceDirectory, activeProject?.name, t('project.none'))}</span>
            </div>
          )}
          {activeView === 'chat' && dismissedSubagentKey !== subagentIndicatorKey && (
            <SubagentIndicator
              threads={subagentThreads}
              open={showSubagentThreadPanel}
              onOpen={handleToggleSubagents}
              onDismiss={() => setDismissedSubagentKey(subagentIndicatorKey)}
            />
          )}
          {activeView === 'plugins' ? (
            <PluginsView
              onClose={() => setActiveView('chat')}
              loadIcons={userSettings.loadWebIcons}
              onManageChromeIntegration={() => {
                setSettingsTab('integrations')
                setActiveView('settings')
              }}
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
              providerStatuses={providerAuth}
              connectingProvider={connectingProvider}
              providerLoginStage={providerLoginStage}
              onProviderConnect={providerId => { void handleProviderConnect(providerId) }}
              onProviderLoginCancel={() => { void handleProviderLoginCancel() }}
              theme={theme}
              activeTab={settingsTab}
              userSettings={userSettings}
              petEnabled={petEnabled}
              petSize={petSize}
              profile={profile}
              profileLoading={profileLoading}
              workingDirectory={currentWorkspaceDirectory}
              onPetToggle={togglePet}
              onPetSizeChange={updatePetSize}
              browserAvailable={browserAvailable}
              onOpenDashboard={() => window.verboo.openDashboard()}
              onRefreshProfile={refreshProfile}
              onManagePlan={() => window.verboo.openSubscriptions()}
              onUpdateAvatar={avatar => updateUserSettings({ avatar })}
              onSaveApiKey={async apiKey => {
                await saveApiKey(apiKey)
              }}
              onThemeChange={setTheme}
              onActiveTabChange={setSettingsTab}
              onUserSettingsChange={updateUserSettings}
              soundsEnabled={soundsEnabled}
              onSoundsEnabledChange={setSoundsEnabled}
              onResetUserSettings={resetUserSettings}
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
                videoProgressByTurn={videoProgressByTurn}
                onCancelVideo={() => { void interruptForUser(activeConversationId) }}
                onEditSent={editSentMessage}
                onUserExpand={handleUserExpand}
                onStartNewConversation={() => newChat()}
                models={modelResult.models}
                apiRetryByTurn={apiRetryByTurn}
              />
              <div ref={transcriptEndRef} className="transcript-end" />
              {/* AnnotationLayer (F1): ouvinte de seleção + barra flutuante.
                  Vive dentro de hasConversation para morrer fora da view de chat.
                  Posse: o Layer só cria para a conversationId da prop DESTE
                  render — a mesma capturada pelo onCreate abaixo — e a barra é
                  dispensada ao trocar de conversa, então os dois lados nunca
                  divergem. */}
              <AnnotationLayer
                conversationId={activeConversationId}
                onCreate={annotation =>
                  setAnnotationDrafts(current =>
                    activeConversationId ? addAnnotationDraft(current, activeConversationId, annotation) : current,
                  )
                }
                onEditComment={(annotationId, comment) =>
                  setAnnotationDrafts(current =>
                    activeConversationId ? updateAnnotationComment(current, activeConversationId, annotationId, comment) : current,
                  )
                }
                onAskInSideChat={openSideChat}
              />
              {/* F2: overlay de destaque + balão, IRMÃO do transcript —
                  nunca dentro dele (regra 1: o DOM do MarkdownMessage é do
                  React; o byte-idêntico está pinado em teste). Lê os MESMOS
                  rascunhos do chip; âncora que não resolve degrada sem visual
                  e sem perder o dado. Nada aqui toca o caminho de envio. */}
              <AnnotationOverlay
                annotations={draftsForConversation(annotationDrafts, activeConversationId ?? '')}
                conversationId={activeConversationId}
              />
            </>
          ) : (
            <EmptyChat hasProject={Boolean(activeProject?.name)} projectName={projectName} line={emptyLine} />
          )}
        </section>
        {activeView === 'chat' && cliAgentActionsBlocked && (
          <CliBootstrapGate
            phase={cliBootstrapSuccessVisible
              ? 'success'
              : updateSnapshot?.status === 'error'
                ? 'error'
                : 'installing'}
            percent={updateSnapshot?.percent}
            error={updateSnapshot?.error}
            onRetry={() => { void runCliBootstrap() }}
            onOpenSettings={() => {
              setSettingsTab('security')
              setActiveView('settings')
            }}
          />
        )}
        <SideChatSurface
          sideChat={sideChat}
          busy={sideChat ? runningConversations.has(sideChat.conversation.id) : false}
          disabled={cliAgentActionsBlocked}
          onSubmit={message => { void sendSideChatMessage(message) }}
          onClose={closeSideChat}
          onFocusConversation={() => {
            focusedConversationLaneRef.current = 'side'
            focusedConversationIdRef.current = sideChatRef.current?.conversation.id
          }}
          auxiliary={(
            <>
              {sideQuestionPrompt && (
                questionWizardOpenByTurn[sideQuestionPrompt.turnId] ? (
                  <QuestionWizard
                    prompt={sideQuestionPrompt}
                    onAnswersChange={answers => updateQuestionPromptAnswers(sideQuestionPrompt.turnId, answers)}
                    onSubmit={() => { void submitQuestionAnswers(sideQuestionPrompt) }}
                    onDismiss={() => clearQuestionPromptForTurn(sideQuestionPrompt.turnId)}
                  />
                ) : (
                  <div className="question-chip-container">
                    <button
                      type="button"
                      className="question-chip"
                      onClick={() => setQuestionWizardOpenByTurn(current => ({ ...current, [sideQuestionPrompt.turnId]: true }))}
                    >
                      <MessageCircleQuestion size={15} aria-hidden="true" />
                      {sideQuestionPrompt.questions.length === 1
                        ? t('questions.chipOne')
                        : t('questions.chip', { count: sideQuestionPrompt.questions.length })}
                    </button>
                    <button
                      type="button"
                      className="question-chip-close"
                      onClick={() => clearQuestionPromptForTurn(sideQuestionPrompt.turnId)}
                      aria-label={t('questions.dismiss')}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )
              )}
              {sidePermissionPrompt && (
                <PermissionApprovalPanel
                  prompt={sidePermissionPrompt}
                  onAllow={() => respondToPermissionPrompt(sidePermissionPrompt, 'allow')}
                  onDeny={() => respondToPermissionPrompt(sidePermissionPrompt, 'deny')}
                  onAlwaysAllow={() => respondToPermissionPrompt(sidePermissionPrompt, 'always')}
                />
              )}
            </>
          )}
        />
        {showSubagentThreadPanel && selectedSubagent && (
          <SubagentThreadPanel
            threads={subagentThreads}
            selectedId={selectedSubagent.id}
            onSelect={setSelectedSubagentId}
            onClose={() => setSelectedSubagentId(undefined)}
          />
        )}
        <LocalTerminalPanel
          terminalOpen={visibleTerminalOpen}
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
          open={visibleReviewOpen}
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
      {browserAvailable && (
        <BrowserPanel
          browserOpen={visibleBrowserOpen}
          browserWidth={effectiveBrowserWidth}
          annotationMode={browser.annotationMode}
          onSetWidth={setBrowserWidth}
          onClose={browser.close}
          onTogglePencil={browser.togglePencil}
          onToggleArrow={browser.toggleArrow}
          onAddAnnotation={addBrowserAnnotation}
          navigationRequest={browser.navigationRequest}
          onNavigationHandled={browser.completeNavigation}
          reloadRequest={browser.reloadRequest}
          onReloadSnapshot={handleBrowserReloadSnapshot}
          onReloadHandled={browser.completeReload}
          minWidth={browser.MIN_WIDTH}
          maxWidth={browserWidthLimit}
          session={browser.session}
          activeTab={browser.activeTab}
          onCreateTab={browser.createTab}
          onActivateTab={browser.activateTab}
          onNavigateTab={browser.navigateTab}
          onCloseTab={browser.closeTab}
        />
      )}
      {simulatorAvailable && (
        <IosSimulatorPanel
          simulatorOpen={visibleSimulatorOpen}
          simulatorWidth={effectiveBrowserWidth}
          onSetWidth={setBrowserWidth}
          onClose={simulator.close}
          requirements={simulator.requirements}
          requirementsLoading={simulator.requirementsLoading}
          attachedUdid={simulator.attachedUdid}
          attachedDevice={simulator.attachedDevice}
          frameDataUrl={simulator.frameDataUrl}
          streamUrl={simulator.streamUrl}
          streamSource={simulator.streamSource}
          effectiveFps={simulator.effectiveFps}
          streamFps={simulator.streamFps}
          streamRates={simulator.streamRates}
          fallbackFps={simulator.fallbackFps}
          fallbackRates={simulator.fallbackRates}
          busyUdid={simulator.busyUdid}
          error={simulator.error}
          lifecycle={simulator.lifecycle}
          lastMediaFile={simulator.lastMediaFile}
          agentPresence={simulator.agentPresence}
          onAttach={udid => { void simulator.attach(udid) }}
          onDetach={() => { void simulator.detach() }}
          onEndSimulation={() => { void simulator.endSimulation() }}
          onShutdownExternalSimulation={() => { void simulator.shutdownExternalSimulation() }}
          onSystemAction={action => { void simulator.runSystemAction(action) }}
          onCaptureScreen={() => { void simulator.captureScreen() }}
          onToggleRecording={() => { void simulator.toggleRecording() }}
          onRetryAttach={() => { void simulator.retryAttach() }}
          onRetryInteraction={() => { void simulator.retryInteraction() }}
          onRevealOutput={path => { void simulator.revealOutput(path) }}
          onSetStreamRate={fps => { void simulator.setStreamRate(fps) }}
          onSetFallbackRate={fps => { void simulator.setFallbackRate(fps) }}
          onTap={point => { void simulator.tap(point) }}
          onDrag={(from, to, durationMs) => { void simulator.drag(from, to, durationMs) }}
          onTypeText={text => { void simulator.typeText(text) }}
          onPressKey={key => { void simulator.pressKey(key) }}
          onInspectPoint={simulator.inspectPoint}
          onCaptureAnnotation={(_kind, rect, element) => simulator.captureAnnotation(rect, element)}
          onDeleteCapture={simulator.deleteCapture}
          onAddAnnotation={addBrowserAnnotation}
          onRefresh={() => { void simulator.refresh() }}
          minWidth={browser.MIN_WIDTH}
          maxWidth={browserWidthLimit}
        />
      )}
      </div>
      {(() => {
        // G-C10 item 1: GoalStatusBar moved INTO composer-aux-stack (below).
        // It was previously rendered as a sibling of bottom-dock, but
        // bottom-dock is position:fixed (composer.css:1-9) — siblings
        // fall out of the rounded frame and the fixed composer floats
        // over them. The aux-stack is the slot the panel uses, and the
        // bar was designed for the same slot (mutual exclusion with the
        // panel by status). Keeping them as siblings inside the same
        // fixed container restores the rounded-frame clipping.
        return null
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
          {showJumpToLatest && hasConversation && (
            <button className="jump-to-latest" type="button" onClick={() => scrollToLatest('smooth')} title={t('workspace.jumpToLatest')}>
              <ArrowDown size={17} />
            </button>
          )}
          {(goal && goal.status !== 'completed' && goal.status !== 'blocked' && goal.status !== 'cancelled') || exitGoal || mainQuestionPrompt || checklistFlight.committed?.form === 'docked' || checklistFlight.spacerHeight !== null ? (
            <div className="composer-aux-stack" role="region" aria-label={t('goal.auxStackLabel')}>
              {/* T1-TodoWrite: the checklist rides ABOVE the goal —
                  the goal always stays closest to the composer
                  (approved hierarchy: list → goal → composer). The
                  spacer animates the flow space during a FLIP flight
                  so the goal panel slides instead of jumping. */}
              {checklistFlight.spacerHeight !== null && (
                <div className="checklist-spacer" style={{ height: checklistFlight.spacerHeight }} aria-hidden="true" />
              )}
              {checklistFlight.committed?.form === 'docked' && activeChecklistTodos && (
                <ChecklistPanel
                  todos={activeChecklistTodos}
                  form="docked"
                  cardPos={null}
                  onCardPosChange={() => {}}
                  onToggleForm={() => setChecklistFormPref('float')}
                  flightStyle={checklistFlight.flightStyle}
                  flying={checklistFlight.flying}
                  entering={checklistFlight.entering}
                  exiting={checklistCompletionExit.exiting}
                  registerElement={checklistFlight.registerPanel}
                />
              )}
              {goal && goal.status !== 'completed' && goal.status !== 'blocked' && goal.status !== 'cancelled' && (
                <GoalActivePanel
                  goal={goal}
                  turnInProgress={activeConversationId ? runningConversations.has(activeConversationId) : false}
                  compact={!!(mainQuestionPrompt && questionWizardOpenByTurn[mainQuestionPrompt.turnId])}
                  onEditObjective={handleEditObjective}
                  onPause={() => handleGoalCommand({ kind: 'goal', action: 'pause', raw: '/goal pause' })}
                  onResume={() => handleGoalCommand({ kind: 'goal', action: 'resume', raw: '/goal resume' })}
                  onCancel={() => handleGoalCommand({ kind: 'goal', action: 'clear', raw: '/goal clear' })}
                />
              )}
              {/* Genie exit: while the terminal goal's panel plays its
                  sink-back animation, the aux-stack stays mounted (see
                  the exitGoal clause above) and the panel renders with
                  `leaving`. Handlers are inert — pointer-events:none in
                  CSS — but the props are required. The GoalStatusBar is
                  gated with !exitGoal so the exit window does NOT make
                  the bar reachable in a path where it never rendered
                  before (terminal goal without open questions): the bar
                  keeps exactly its pre-genie reachability. */}
              {exitGoal && (
                <GoalActivePanel
                  goal={exitGoal}
                  leaving
                  turnInProgress={false}
                  compact={!!(mainQuestionPrompt && questionWizardOpenByTurn[mainQuestionPrompt.turnId])}
                  onEditObjective={() => {}}
                  onPause={() => {}}
                  onResume={() => {}}
                  onCancel={() => {}}
                />
              )}
              {/* G-C10 item 1: GoalStatusBar lives in the same aux-stack
                  slot as GoalActivePanel. Mutual exclusion by status:
                  panel covers active|evaluating|continuing|paused, bar
                  covers completed|blocked|cancelled (toast/brief feedback).
                  Both are inside bottom-dock now, so the fixed composer
                  no longer floats over the bar and the rounded frame
                  clips both. */}
              {goal && !exitGoal && (goal.status === 'completed' || goal.status === 'blocked' || goal.status === 'cancelled') && (
                <GoalStatusBar
                  status={goalBarStatus}
                  onPause={() => handleGoalCommand({ kind: 'goal', action: 'pause', raw: '/goal pause' })}
                  onResume={() => handleGoalCommand({ kind: 'goal', action: 'resume', raw: '/goal resume' })}
                  onCancel={() => handleGoalCommand({ kind: 'goal', action: 'clear', raw: '/goal clear' })}
                  onClear={() => handleGoalCommand({ kind: 'goal', action: 'clear', raw: '/goal clear' })}
                />
              )}
              {mainQuestionPrompt && (
                questionWizardOpenByTurn[mainQuestionPrompt.turnId] ? (
                  <QuestionWizard
                    prompt={mainQuestionPrompt}
                    onAnswersChange={answers => updateQuestionPromptAnswers(mainQuestionPrompt.turnId, answers)}
                    onSubmit={() => { void submitQuestionAnswers(mainQuestionPrompt) }}
                    onDismiss={() => clearQuestionPromptForTurn(mainQuestionPrompt.turnId)}
                  />
                ) : (
                  <div className="question-chip-container">
                    <button type="button" className="question-chip" onClick={() => setQuestionWizardOpenByTurn(current => ({ ...current, [mainQuestionPrompt.turnId]: true }))}>
                      <MessageCircleQuestion size={15} aria-hidden="true" />
                      {mainQuestionPrompt.questions.length === 1
                        ? t('questions.chipOne')
                        : t('questions.chip', { count: mainQuestionPrompt.questions.length })}
                    </button>
                    <button
                      type="button"
                      className="question-chip-close"
                      onClick={() => {
                        clearQuestionPromptForTurn(mainQuestionPrompt.turnId)
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
          {videoFallbackRoute && videoFallbackResolveRef.current && (
            <VideoFallbackModal
              route={videoFallbackRoute}
              onRespond={choice => {
                videoFallbackResolveRef.current?.(choice)
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
            disabled={cliAgentActionsBlocked}
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
            onRemoveAttachment={removeAttachment}
            onSubmit={sendMessage}
            onGoalCommand={handleGoalCommand}
            queue={queuedFollowUpsRef.current.filter(item => item.conversationId === activeConversationId)}
            onQueueSendNow={queueItemId => { void interjectMessage(queueItemId) }}
            onQueueEdit={editQueuedItem}
            onQueueRemove={removeQueuedItem}
            onPetCommand={togglePet}
            onCompactCommand={handleCompactCommand}
            annotations={draftsForConversation(annotationDrafts, activeConversationId ?? '')}
            onRemoveAnnotation={annotationId =>
              setAnnotationDrafts(current =>
                activeConversationId ? removeAnnotationDraft(current, activeConversationId, annotationId) : current,
              )
            }
            onEditAnnotationComment={(annotationId, comment) =>
              setAnnotationDrafts(current =>
                activeConversationId ? updateAnnotationComment(current, activeConversationId, annotationId, comment) : current,
              )
            }
            value={composerValue}
            onValueChange={setComposerValue}
            busy={activeConversationId ? runningConversations.has(activeConversationId) : false}
            leftToolbar={
              <AccessSelector
                value={accessMode}
                fullAccessEnabled={userSettings.fullAccessEnabled}
                onChange={setAccessMode}
                onRequestFullAccessSettings={() => {
                  setSettingsTab('security')
                  setActiveView('settings')
                }}
              />
            }
            rightToolbar={
              <>
                <TokenRateMeter rate={tokenRate} active={Boolean(activeTurnId)} />
                <ModelSelector
                  models={modelResult.models}
                  selectedModel={selectedModel}
                  hasConversationHistory={hasConversation}
                  modelResult={modelResult}
                  verbooPlan={cliAuth.subscriptionType ?? undefined}
                  providerStatuses={providerAuth}
                  onConnectProvider={providerId => { void handleProviderConnect(providerId) }}
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

      {providerRiskNotice && (
        <ProviderRiskDialog
          provider={providerRiskNotice.provider}
          message={providerRiskNotice.message}
          onAccept={() => void handleProviderRiskAccept()}
          onCancel={() => void handleProviderLoginCancel()}
        />
      )}

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

      {/* T1-TodoWrite: the floating checklist card lives in a portal —
          position:fixed must be free of any fixed/transformed ancestor
          (the bottom-dock is position:fixed; mounting a floating panel
          inside it is exactly the panel-that-fell-to-the-bottom defect
          class this project already paid for). */}
      {checklistFlight.committed?.form === 'floating' && activeChecklistTodos && createPortal(
        <ChecklistPanel
          todos={activeChecklistTodos}
          form="floating"
          cardPos={checklistCardPos}
          onCardPosChange={setChecklistCardPos}
          onToggleForm={() => setChecklistFormPref('dock')}
          flightStyle={checklistFlight.flightStyle}
          flying={checklistFlight.flying}
          entering={checklistFlight.entering}
          exiting={checklistCompletionExit.exiting}
          registerElement={checklistFlight.registerPanel}
        />,
        document.body,
      )}

    </main>
    </I18nProvider>
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
  // An explicit selection SURVIVES vanishing from a catalog snapshot: provider
  // models are attached per refresh and degrade silently (model_service.rs
  // attach_provider_models), so a transient provider-CLI hiccup must not
  // demote the user's choice — every later refresh would keep the demotion.
  // The persisted choice gets the same protection at startup under a degraded
  // catalog. models[0] only when no explicit selection exists (first paint).
  return currentModelId ?? preferredModelId ?? models[0]?.id
}

/** The CLI emits `{"type":"system","subtype":"api_retry","attempt":N,
 *  "max_retries":M,"retry_delay_ms":D,...}` while it retries a rate-limited
 *  request (measured: 10 attempts over ~3 min). The Rust forwarder rides it
 *  as a json event — surface it instead of sitting on a mute "Thinking…"
 *  (field defect). `retry_delay_ms` is the declared wait before the next
 *  retry; when it's hour-scale the "retry" is really a quota reset (T13). */
export function extractApiRetry(payload: unknown): { attempt: number; maxRetries: number; retryDelayMs?: number } | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  if (record.type !== 'system' || record.subtype !== 'api_retry') return undefined
  const attempt = typeof record.attempt === 'number' ? record.attempt : undefined
  const maxRetries = typeof record.max_retries === 'number' ? record.max_retries : undefined
  if (!attempt || !maxRetries) return undefined
  const retryDelayMs = typeof record.retry_delay_ms === 'number' ? record.retry_delay_ms : undefined
  return { attempt, maxRetries, retryDelayMs }
}

/** The Rust forwarder also turns a result event's `result` string into stdout
 *  (turn_service.rs:3073-3077) AFTER the same text already streamed from the
 *  assistant event. Remembering the announced result text lets the stdout
 *  handler skip the exact re-emission — otherwise the final message renders
 *  twice in the body (field defect: the quota error duplicated). */
export function extractResultText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  if (record.type !== 'result') return undefined
  return typeof record.result === 'string' && record.result.trim() ? record.result : undefined
}

function clearApiRetryNotice(
  prev: Record<string, { attempt: number; maxRetries: number }>,
  turnId: string,
): Record<string, { attempt: number; maxRetries: number }> {
  if (!(turnId in prev)) return prev
  const next = { ...prev }
  delete next[turnId]
  return next
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

function buildResearchResultsContext(
  results: ResearchSubagentResult[],
  labels: string[],
  t: Translator,
): string {
  if (results.length === 0) return ''
  return [
    t('subagent.resultsContextTitle'),
    '',
    ...results.map(result => [
      `${labels[result.index - 1] ?? `Subagente ${result.index}`} (${result.status}):`,
      `${t('subagent.summary')}: ${result.summary}`,
      result.findings.length ? `${t('subagent.findings')}:\n${result.findings.map(finding => `- ${finding}`).join('\n')}` : '',
      result.sources.length ? `${t('subagent.sources')}:\n${result.sources.map(source => `- ${source}`).join('\n')}` : '',
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

function activityDisplayLabel(activity: TurnActivity, t: Translator): string {
  if (activity.kind === 'read') return t('transcript.readOne')
  if (activity.kind === 'edit') return t('transcript.editOne')
  if (activity.kind === 'search') return t('transcript.searchOne')
  if (activity.kind === 'command') return t('transcript.commandOne')
  if (activity.kind === 'terminal') return t('transcript.terminalOne')
  if (activity.kind === 'image') return t('transcript.imageOne')
  if (activity.kind === 'permission') return t('transcript.permissionOne')
  if (activity.kind === 'subagent') return t('transcript.subagentOne')
  // FRENTE-A (2026-08-02): browser intentionally diverges from the
  // kind-level flattening used by read/edit/command because the product
  // reference requires the Chrome step to identify each action. Preserve
  // the tool-specific label, with the generic fallback for empty labels.
  if (activity.kind === 'browser') return activity.label || t('transcript.browserOne')
  if (activity.kind === 'context') return activity.label
  if (activity.kind === 'thinking') return t('transcript.thinking')
  return t('transcript.toolOne')
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

function extractTokenUsage(payload: unknown): TokenUsage | undefined {
  const usage = extractUsageObject(payload)
  if (!usage) return undefined

  // G-C12: the CLI sends snake_case keys in its raw stream payload
  // (input_tokens, output_tokens, cache_creation_input_tokens,
  // cache_read_input_tokens). We read them in snake_case here and
  // return a TokenUsage-typed object with camelCase keys, so the
  // return value matches the shape the Rust side sends via Tauri
  // events (serde rename_all camelCase). Consumers can treat both
  // paths (CLI raw payload and Rust event.result.usage) uniformly.
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
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreationTokens,
    cacheReadInputTokens: cacheReadTokens,
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
function slimMeta(a: AttachmentMeta): Pick<AttachmentMeta, 'path' | 'name' | 'kind' | 'size' | 'mediaType' | 'browserAnnotation' | 'simulatorAnnotation'> {
  return {
    path: a.path,
    name: a.name,
    kind: a.kind,
    size: a.size,
    mediaType: a.mediaType,
    browserAnnotation: a.browserAnnotation,
    simulatorAnnotation: a.simulatorAnnotation,
  }
}

function cleanCliFailureLine(line: string): string {
  return line.replace(/\x1B\[[0-9;]*m/g, '').trim()
}

// Truncate tool_result output before persisting it on a TranscriptItem. Keeps
// the store small while preserving the most useful part (head of the output,
// where the signal is). ANSI escape sequences are stripped first (same regex
// as chatStore.stripTerminalControl) so the rendered detail is clean text.
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
