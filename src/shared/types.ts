export type GoalStatus =
  | 'active'
  | 'paused'
  | 'evaluating'
  | 'continuing'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | 'budget_limited'

export type GoalEvaluationResult = {
  decision: 'complete' | 'continue' | 'blocked'
  confidence: number
  reason: string
  evidence: string[]
  missing: string[]
  nextMessage?: string
}

export type AgentResultSnapshot = {
  turnId: string
  exitCode: number | null
  sessionId?: string
  stopReason?: string
  isError?: boolean
  usage?: TokenUsage
  permissionDenials?: unknown[]
  errors?: string[]
  rawResult?: unknown
}

export type GoalState = {
  id: string
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  pausedAt?: number
  pauseReason?: string
  lastEvaluation?: GoalEvaluationResult
  lastSessionId?: string
  lastTurnId?: string
  turnsRun: number
  maxTurns: number
  maxElapsedMs: number
  maxInputTokens?: number
  usedInputTokens: number
  usedOutputTokens: number
  accessMode: AccessMode
  modelId?: string
  modelDisplayName?: string
  workingDirectory: string
  skills: SkillSummary[]
  noProgressCount: number
  recentFingerprints: string[]
}

export type GoalEvaluationInput = {
  goal: GoalState
  conversationItems: TranscriptItem[]
  latestResult?: AgentResultSnapshot
  contextUsage?: ContextUsageSnapshot
}

export type AccessMode = 'approval' | 'auto' | 'full'
export type ThemeMode = 'dark' | 'light'
export type LanguageCode = 'en-US' | 'pt-BR'
export type SettingsTab =
  | 'permissions'
  | 'trustedCommands'
  | 'app'
  | 'notifications'
  | 'personalization'
  | 'memory'
  | 'updates'
  | 'archived'
export type PersonalityMode = 'pragmatic' | 'concise' | 'explanatory'
export type CompletionNotificationMode = 'always' | 'background' | 'never'

export type TrustedCommandRule = {
  id: string
  command: string
  createdAt: number
  lastUsedAt?: number
  useCount: number
}

export type SkillSource = 'project' | 'user' | 'legacy' | 'managed'

export type SkillSummary = {
  id: string
  name: string
  description: string
  path: string
  source: SkillSource
  trusted: boolean
}

export type TranscriptItem = {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  timestamp: number
  kind?: 'message' | 'activity' | 'summary'
  activityKind?: 'thinking' | 'image' | 'read' | 'edit' | 'search' | 'command' | 'terminal' | 'permission' | 'subagent' | 'queued' | 'context' | 'tool' | 'compacting'
  activityDetail?: string
  command?: CommandRun
  changeSummary?: WorkspaceChangeSummary
  modelId?: string
  modelDisplayName?: string
  streaming?: boolean
  skills?: SkillSummary[]
}

export type WorkspaceChangeEntry = {
  path: string
  additions: number
  deletions: number
  status?: 'modified' | 'added' | 'deleted' | 'untracked'
}

export type TurnActionKind =
  | 'read' | 'search' | 'edit' | 'create' | 'delete' | 'command'
  | 'image' | 'terminal' | 'permission' | 'agent-open' | 'agent-close' | 'tool'

export type CommandRun = { input: string; output: string; status: 'success' | 'failure' | 'running' }

export type TurnAction = { kind: TurnActionKind; label: string; detail?: string; command?: CommandRun }

export type TurnBlock =
  | { kind: 'text'; id: string; text: string; streaming: boolean }
  | { kind: 'actions'; id: string; actions: TurnAction[] }

export type WorkspaceChangeSummary = {
  files: WorkspaceChangeEntry[]
  totalFiles: number
  additions: number
  deletions: number
}

export type ChatProject = {
  id: string
  name: string
  path?: string
  collapsed: boolean
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

export type StoredConversation = {
  id: string
  title: string
  cliSessionId?: string
  projectId?: string
  items: TranscriptItem[]
  goal?: GoalState
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

export type ChatStore = {
  version: 2
  projects: ChatProject[]
  conversations: StoredConversation[]
}

export type VerbooModel = {
  id: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsVision?: boolean
  visionSupportSource?: 'router' | 'raw-capabilities' | 'heuristic'
  raw: unknown
}

export type ModelDiscoveryResult = {
  models: VerbooModel[]
  source: 'cli' | 'api-key' | 'cache' | 'none'
  stale: boolean
  error?: string
}

export type UserSettings = {
  language: LanguageCode
  defaultAccessMode: AccessMode
  fullAccessEnabled: boolean
  lastSelectedModelId?: string
  showInMenuBar: boolean
  showMenuBarText: boolean
  staySignedIn: boolean
  preventSleepWhileRunning: boolean
  completionNotifications: CompletionNotificationMode
  permissionNotifications: boolean
  questionNotifications: boolean
  responseEnhancementsEnabled: boolean
  personality: PersonalityMode
  customInstructions: string
  trustedCommands: TrustedCommandRule[]
  memoriesEnabled: boolean
  chroniclePreview: boolean
  ignoreToolChatsForMemory: boolean
  goalMode: {
    enabled: boolean
    maxTurns: number
    maxElapsedMinutes: number
    allowAutoAccess: boolean
  }
  updates: UpdateSettings
}

export type MenuBarState = {
  execution: 'idle' | 'thinking' | 'tool' | 'permission' | 'done' | 'error'
  label?: string
  startedAt?: number
  modelId?: string
  modelDisplayName?: string
  contextWindow?: number
  contextUsage?: number
  workingDirectory?: string
  loggedIn?: boolean
  email?: string
}

export type TokenUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type ContextUsageSnapshot = {
  usedTokens: number
  maxTokens?: number
  percentage?: number
  inputTokens?: number
  outputTokens?: number
  source: 'cli-usage'
  updatedAt: number
}

export type TokenRateSnapshot = {
  outputTokens: number
  totalTokens: number
  tokensPerSecond?: number
  requestsPerMinute?: number
  source: 'cli-usage'
  updatedAt: number
}

export type CredentialStatus = {
  hasApiKey: boolean
  apiKeyHint?: string
}

export type CliAuthStatus = {
  loggedIn: boolean
  authMethod?: string
  apiProvider?: string
  email?: string
  orgId?: string
  orgName?: string | null
  subscriptionType?: string | null
  error?: string
}

export type LoginResult = {
  ok: boolean
  message: string
  status?: CliAuthStatus
}

export type ProfileUsageSummary = {
  tokensInTotal?: number
  tokensOutTotal?: number
  totalTokens?: number
  reqTotal?: number
}

export type ProfileActivityDay = {
  date: string
  count: number
}

export type ProfilePlan = {
  id?: string
  name?: string
  status?: string
  priceLabel?: string
  models?: string[]
  concurrentRequests?: number
}

export type ProfileUser = {
  id?: string
  name?: string
  email?: string
}

export type ProfileResult = {
  status: 'ready' | 'unauthenticated' | 'error'
  fetchedAt?: number
  user?: ProfileUser
  plan?: ProfilePlan
  summary?: ProfileUsageSummary
  activity?: ProfileActivityDay[]
  activeDays?: number
  error?: string
}

export type AttachmentKind = 'image' | 'file'

export type AttachmentMeta = {
  path: string
  name: string
  size: number
  kind: AttachmentKind
  mediaType?: string
  width?: number
  height?: number
}

export type AgentTurnRequest = {
  turnId?: string
  conversationId: string
  message: string
  model?: string
  modelSupportsVision?: boolean
  contextWindow?: number
  responseLanguage?: LanguageCode
  accessMode: AccessMode
  workingDirectory: string
  skills: SkillSummary[]
  attachments?: AttachmentMeta[]
  responseEnhancementsEnabled?: boolean
  personality?: PersonalityMode
  customInstructions?: string
  memoryContext?: string
}

export type ResearchSubagentRequest = {
  id: string
  index: number
  total: number
  topic: string
  baseRequest: AgentTurnRequest
}

export type ResearchSubagentsRunRequest = {
  runId?: string
  count: number
  requestedCount?: number
  baseRequest: AgentTurnRequest
}

export type ResearchSubagentProgress = {
  id: string
  index: number
  total?: number
  runId?: string
  status: 'queued' | 'running' | 'reading' | 'searching' | 'complete' | 'failed'
  summary: string
  activity?: string
  detail?: string
  mission?: string
  label?: string
}

export type ResearchSubagentResult = {
  id: string
  index: number
  status: 'complete' | 'failed'
  summary: string
  findings: string[]
  sources: string[]
}

export type FeedbackCategory = 'bug' | 'feedback' | 'question'

export type FeedbackDiagnostics = {
  appVersion: string
  platform: string
  appSource: 'desktop'
  projectName?: string
  activeView?: string
  modelId?: string
  modelDisplayName?: string
  modelSource?: ModelDiscoveryResult['source']
  accessMode?: AccessMode
  contextWindow?: number
  contextUsage?: ContextUsageSnapshot
  authMethod?: string
  cliLoggedIn?: boolean
  hasApiKey?: boolean
}

export type FeedbackRequest = {
  category: FeedbackCategory
  title: string
  description: string
  contact?: string
  includeDiagnostics: boolean
  diagnostics?: FeedbackDiagnostics
}

export type FeedbackResult = {
  ok: boolean
  channel: 'supabase' | 'mailto'
  message: string
  error?: string
}

export type RuntimeStatus = {
  kind: 'permission' | 'question' | 'tool'
  label: string
}

export type RuntimeActivity = {
  key: string
  label: string
  detail?: string
  kind: NonNullable<TranscriptItem['activityKind']>
  toolUseId?: string
}

export type AgentEvent =
  | { type: 'started'; turnId: string; conversationId?: string }
  | { type: 'stdout'; turnId: string; conversationId?: string; text: string }
  | { type: 'stderr'; turnId: string; conversationId?: string; text: string }
  | { type: 'json'; turnId: string; conversationId?: string; payload: unknown; runtimeStatus?: RuntimeStatus; runtimeActivity?: RuntimeActivity }
  | { type: 'result'; turnId: string; conversationId?: string; result: AgentResultSnapshot }
  | { type: 'subagent-progress'; progress: ResearchSubagentProgress }
  | { type: 'error'; turnId: string; conversationId?: string; message: string }
  | { type: 'done'; turnId: string; conversationId?: string; exitCode: number | null }

export type AppConfig = {
  workingDirectory: string
  accessMode: AccessMode
  platform: NodeJS.Platform
  selectedModel?: string
}

// ── Review types ────────────────────────────────────────────────

export type WorkspaceReviewScope = 'github-repo' | 'git-repo' | 'local-folder'

export type WorkspaceReviewCapabilities = {
  canDiff: boolean
  canRevert: boolean
  canOpenExternal: boolean
}

export type WorkspaceReviewMetadata = {
  scope: WorkspaceReviewScope
  title: string
  subtitle: string
  isGitRepository: boolean
  isGitHubRepository: boolean
  repositoryRoot?: string
  currentBranch?: string
  upstreamBranch?: string
  capabilities: WorkspaceReviewCapabilities
}

export type WorkspaceBranch = {
  name: string
  current: boolean
  remote: boolean
  upstream?: string
}

export type WorkspaceBranchInfo = {
  currentBranch?: string
  upstreamBranch?: string
  branches: WorkspaceBranch[]
  canSwitch: boolean
  dirty: boolean
  dirtyFiles: string[]
  message?: string
}

export type WorkspaceBranchSwitchResult = {
  ok: boolean
  message?: string
  branchInfo?: WorkspaceBranchInfo
}

export type FileDiffStatus = WorkspaceChangeEntry['status'] | 'added' | 'modified' | 'deleted' | 'untracked'

export type FileDiffLine = {
  kind: 'context' | 'add' | 'del'
  oldLine?: number
  newLine?: number
  text: string
}

export type FileDiffHunk = {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: FileDiffLine[]
}

export type FileDiff = {
  path: string
  status: FileDiffStatus
  additions: number
  deletions: number
  binary: boolean
  truncated: boolean
  hunks: FileDiffHunk[]
  message?: string
}

// ── Update types ────────────────────────────────────────────────

export type UpdateChannel = 'stable' | 'beta'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'not-available'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export type UpdateSnapshot = {
  status: UpdateStatus
  channel: UpdateChannel
  currentVersion: string
  availableVersion?: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: string
  percent?: number
  transferredBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  lastCheckedAt?: number
  downloadedAt?: number
  error?: string
}

export type UpdateSettings = {
  channel: UpdateChannel
  autoCheck: boolean
  autoDownload: boolean
}

// ── Terminal types ──────────────────────────────────────────────

export type LocalTerminalSession = {
  id: string
  cwd: string
  shell: string
  createdAt: number
  running: boolean
}

export type LocalTerminalStartRequest = {
  cwd: string
  cols: number
  rows: number
}

export type TerminalDataEvent = {
  sessionId: string
  data: string
}
