export type GoalStatus =
  | 'active'
  | 'paused'
  | 'evaluating'
  | 'continuing'
  | 'blocked'
  | 'completed'
  | 'cancelled'

/**
 * Goal decision returned by the evaluator (Rust `GoalDecision` enum,
 * serialized lowercase). `pause` differs from `blocked` — pause means
 * the model itself flagged a soft-stop condition (e.g. `unsafe`,
 * `needsUser`) that the user may be able to resolve and then resume.
 */
export type GoalDecision = 'continue' | 'pause' | 'complete'

/**
 * Stable reason identifiers (Rust `GoalReasonId` enum, camelCase).
 * Used by the FE for circuit-breaking, i18n, and analytics. The
 * string the model emitted is preserved in `GoalEvaluationResult.reason`.
 *
 * `userPaused`, `userCancelled`, and `safetyLimit` are FE-side reasonIds
 * (not emitted by the Rust evaluator) — set by the scheduler when the
 * user pauses/cancels or when a safety limit (maxTurns/maxElapsed) is
 * reached. They share the same i18n namespace so call sites don't branch.
 */
export type GoalReasonId =
  | 'taskIncomplete'
  | 'taskFailure'
  | 'unsafe'
  | 'needsUser'
  | 'done'
  | 'infraError'
  | 'userPaused'
  | 'userCancelled'
  | 'safetyLimit'
  | 'goalError'

/**
 * Mirror of Rust `GoalEvaluationResult` (src-tauri/src/models/types.rs:810).
 * `reasonId` is the programmatic handle; `reason` is the model's free-form
 * text (shown as a secondary detail). `sessionSummary`, `gaps`, `nextAction`,
 * and `completionSummary` feed the next-turn prompt and the UX cards.
 */
export type GoalEvaluationResult = {
  decision: GoalDecision
  reasonId: GoalReasonId
  reason: string
  sessionSummary?: string
  gaps: string[]
  nextAction?: string
  completionSummary?: string
  confidence: number
}

/**
 * G-C15-FIX: the Tauri boundary struct for `evaluate_goal`.
 *
 * The Rust side (src-tauri/src/lib.rs:40 `EvaluationResult`) declares
 * `evaluation`, `user_message`, and `evaluator_usage` as SIBLINGS at
 * the top level of the returned JSON — NOT nested inside `evaluation`.
 * The previous G-C15-TS adendo wrongly placed `evaluatorUsage` INSIDE
 * `GoalEvaluationResult`, so the renderer read `evaluation.evaluatorUsage`
 * which never existed (the key is a sibling of `evaluation`), and the
 * evaluator's tokens never reached the usage line. Same defect class
 * as the original TokenUsage bug (TS type describes a shape the Rust
 * doesn't send), but on PLACEMENT instead of CASING.
 *
 * `evaluatorUsage` is `Option<TokenUsage>` with `skip_serializing_if
 * Option::is_none` — when the evaluator ran no tokens the key is
 * OMITTED from the JSON (not null). On the TS side this arrives as
 * `undefined` — treat absence, not null.
 */
export type GoalEvaluationEnvelope = {
  evaluation: GoalEvaluationResult
  /** Legacy bridge field; FE should read `evaluation.nextAction`. */
  userMessage?: string
  /** Evaluator's own token usage for THIS evaluation call. Sibling of
   *  `evaluation`, NOT inside it. camelCase keys inside (TokenUsage). */
  evaluatorUsage?: TokenUsage
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
  /**
   * G-C17: evaluator's own token usage ACCUMULATED across EVERY
   * evaluation of this goal (input parcel), summed by the evaluateGoal
   * delegate from the `evaluatorUsage` SIBLING of `evaluation` in the
   * Tauri boundary struct (GoalEvaluationEnvelope — G-C15-FIX), NOT
   * from inside `lastEvaluation`.
   *
   * Replaces G-C15-FIX's `lastEvaluatorUsage` (last-write-wins): in a
   * multi-evaluation goal only the LAST parcel reached the usage line,
   * so the "Total registrado" label under-reported by ~one evaluation
   * (~30-40k input tokens) per discarded cycle. QA blocking.
   *
   * Renderer-only: Rust GoalState (types.rs:970) has no counterpart —
   * serde ignores unknown keys when the goal crosses the boundary
   * inside GoalEvaluationInput. Optional because legacy stored goals
   * pre-G-C17 lack the key; readers coalesce with `?? 0` (treat
   * ABSENCE, not null — same lesson as skip_serializing_if).
   */
  evaluatorInputTokens?: number
  /** G-C17: output parcel — see evaluatorInputTokens. */
  evaluatorOutputTokens?: number
  lastSessionId?: string
  lastTurnId?: string
  turnsRun: number
  /**
   * @deprecated Budget limits are no longer enforced — tokens and time
   * are unlimited. Kept on the type for backwards compatibility with
   * stored goals; new goals set this to u32::MAX (4_294_967_295).
   *
   * CONTRACT: Rust GoalState (types.rs:935) declares max_turns: u32.
   * Sending a value > 4_294_967_295 causes serde to reject the
   * entire evaluate_goal invoke. Use GOAL_MAX_TURNS_UNLIMITED from
   * goalState.ts — never Number.MAX_SAFE_INTEGER.
   */
  maxTurns?: number
  /**
   * @deprecated See maxTurns.
   */
  maxElapsedMs?: number
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
  /**
   * Consecutive evaluator failures (CLI timeout, parse error, network).
   * Reset to 0 on any successful evaluation. When it reaches
   * `MAX_EVALUATION_ERRORS` the scheduler pauses the goal with
   * `pauseReason: 'infra_error'` so the user can intervene instead of
   * burning budget on a broken evaluator.
   */
  errorCount?: number
  /**
   * G-C5-FIX: id of the conversation that owns this goal. The
   * persistence effect uses this to avoid cross-writing the goal into
   * a conversation that was just selected by the user — without this,
   * switching from conversation A (with active goal) to conversation B
   * fires the persist effect with `goal=A` + `activeConversationId=B`,
   * corrupting B's stored goal. The next flush would correct it, but
   * a crash between the two leaves B with a stale goal.
   */
  ownerConversationId?: string
}

export type GoalEvaluationInput = {
  goal: GoalState
  conversationItems: TranscriptItem[]
  latestResult?: AgentResultSnapshot
  contextUsage?: ContextUsageSnapshot
}

export type AccessMode = 'approval' | 'auto' | 'full'
export type LanguageCode = 'en-US' | 'pt-BR'

/**
 * Theme preference. `system` resolves to `dark` or `light` via
 * `matchMedia('(prefers-color-scheme: dark)')` and updates when the
 * OS preference changes.
 */
export type ThemeMode = 'dark' | 'light' | 'system'
export type SettingsTab =
  | 'permissions'
  | 'trustedCommands'
  | 'customCommands'
  | 'app'
  | 'verbooInChrome'
  | 'notifications'
  | 'personalization'
  | 'memory'
  | 'projectInstructions'
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
  /** When the skill originates from a plugin, holds the plugin id for the
   *  composer chip icon (PluginIcon). Undefined for filesystem skills. */
  pluginId?: string
  /** Display name of the source plugin, for chip rendering. */
  pluginName?: string
  /** When true, this entry represents a plugin-level mention (the whole
   *  plugin, not a specific skill inside it). path is empty; Rust backend
   *  emits the plugin mention line without a path. */
  isPluginMention?: boolean
}

export type TranscriptItem = {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  timestamp: number
  kind?: 'message' | 'activity' | 'summary'
  activityKind?: 'thinking' | 'image' | 'video' | 'read' | 'edit' | 'search' | 'command' | 'terminal' | 'permission' | 'subagent' | 'queued' | 'context' | 'tool' | 'compacting'
  activityDetail?: string
  activityAdditions?: number
  activityDeletions?: number
  activityDiffPreview?: string
  command?: CommandRun
  // Captured tool_result output for non-command activities (read/edit/search/etc).
  // Truncated at capture time to keep persistence small. Commands keep their
  // output in `command.output` instead.
  toolOutput?: string
  changeSummary?: WorkspaceChangeSummary
  // G-C15-TS: goal-completion usage line (e.g. "Uso registrado: 79.695
  // tokens; tempo aproximado: 8min20s"). Set on the per-turn summary item
  // of the goal's LAST turn by the onComplete delegate. The TurnView
  // renders this inline after the agent's final text — no separate box,
  // no badge, same typographic family as the surrounding message. Empty
  // when the goal accumulated no tokens (zero-guard).
  usageLine?: string
  modelId?: string
  modelDisplayName?: string
  streaming?: boolean
  skills?: SkillSummary[]
  // Attachments sent with this message — thumbnail metadata only (paths,
  // names, kinds), no base64 blobs. Survives conversation reload.
  attachments?: Pick<AttachmentMeta, 'path' | 'name' | 'kind' | 'size' | 'mediaType' | 'browserAnnotation'>[]
}

export type WorkspaceChangeEntry = {
  path: string
  additions: number
  deletions: number
  status?: 'modified' | 'added' | 'deleted' | 'untracked'
}

export type TurnActionKind =
  | 'read' | 'search' | 'edit' | 'create' | 'delete' | 'command'
  | 'image' | 'video' | 'terminal' | 'permission' | 'agent-open' | 'agent-close' | 'tool'

export type CommandRun = { input: string; output: string; status: 'success' | 'failure' | 'running' }

export type TurnAction = {
  kind: TurnActionKind
  label: string
  detail?: string
  command?: CommandRun
  // Truncated tool_result output for non-command actions. Surfaced inside the
  // expanded ActionRow so the user can see what a Read/Edit/Search returned.
  toolOutput?: string
  // Line diff stats emitted by Geralt's edit service — animate via SlotText
  // in the ActionRow label (see QW4 diff counts).
  additions?: number
  deletions?: number
  // CLI-style diff preview (+/- lines) truncated for Write/Edit/MultiEdit.
  // Surfaced in the expanded ActionRow so the user can read what changed.
  diffPreview?: string
}

export type TurnBlock =
  | { kind: 'text'; id: string; text: string; streaming: boolean }
  | { kind: 'thinking'; id: string; text: string; streaming: boolean }
  | { kind: 'actions'; id: string; actions: TurnAction[] }

export type WorkspaceChangeSummary = {
  files: WorkspaceChangeEntry[]
  totalFiles: number
  additions: number
  deletions: number
}

export type ProjectInstructionFile = {
  name: 'AGENTS.md' | 'CLAUDE.md'
  exists: boolean
  size?: number
}

export type ProjectInstructionReadResult = {
  name: 'AGENTS.md' | 'CLAUDE.md'
  content: string
  exists: boolean
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

export type SubagentThreadStatus =
  | 'queued'
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type SubagentThreadEvent = {
  id: string
  kind: 'mission' | 'agent-message' | 'tool-call' | 'tool-result' | 'status' | 'final' | 'error'
  text: string
  timestamp: number
  toolName?: string
  toolUseId?: string
  isError?: boolean
}

export type SubagentThread = {
  id: string
  runtimeAgentId?: string
  parentTurnId: string
  toolUseId?: string
  label: string
  mission: string
  status: SubagentThreadStatus
  events: SubagentThreadEvent[]
  createdAt: number
  updatedAt: number
}

export type SubagentThreadUpdate = {
  threadId: string
  runtimeAgentId?: string
  toolUseId?: string
  label?: string
  mission?: string
  status?: SubagentThreadStatus
  event?: SubagentThreadEvent
}

export type StoredConversation = {
  id: string
  title: string
  cliSessionId?: string
  projectId?: string
  items: TranscriptItem[]
  subagents: SubagentThread[]
  goal?: GoalState
  createdAt: number
  updatedAt: number
  /** Last time a turn *finished* in this conversation (result / error).
   *  Bumped only on turn conclusion, NOT on streaming tokens. Used for stable
   *  sidebar ordering: when absent (legacy data) the sort falls back to
   *  updatedAt. Guaranteed to be present on new conversations (=== createdAt). */
  lastTurnEndedAt?: number
  archivedAt?: number
}

export type ChatStore = {
  version: 3
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
  /** Promoted from raw.reasoning when the router serves it. FE reads this
   *  first, falling back to model.raw?.reasoning for backward compat. */
  reasoning?: ModelReasoning
  raw: unknown
}

export type ModelReasoning = {
  effortLevels: string[]
  defaultEffort: string
}

export type ModelDiscoveryResult = {
  models: VerbooModel[]
  source: 'cli' | 'api-key' | 'cache' | 'none'
  stale: boolean
  error?: string
}

export type CustomSlashCommand = {
  id: string
  name: string
  description: string
  body: string
  createdAt: number
}

export type UserSettings = {
  language: LanguageCode
  theme: ThemeMode
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
  customSlashCommands: CustomSlashCommand[]
  memoriesEnabled: boolean
  chroniclePreview: boolean
  ignoreToolChatsForMemory: boolean
  goalMode: {
    /** @deprecated Goal mode is always on; kept for backwards compat. */
    enabled?: boolean
    /**
     * @deprecated Budget limits no longer enforced; kept for backwards compat.
     * CONTRACT: Rust GoalModeSettings (types.rs:647) declares max_turns: u32.
     * Must stay ≤ 4_294_967_295.
     */
    maxTurns?: number
    /**
     * @deprecated See maxTurns.
     * CONTRACT: Rust GoalModeSettings (types.rs:651) declares max_elapsed_minutes: u32.
     * Must stay ≤ 4_294_967_295.
     */
    maxElapsedMinutes?: number
    allowAutoAccess: boolean
  }
  updates: UpdateSettings
  // Consent for vision fallback (spawn a vision-capable model to describe
  // images when the selected model can't see). Default: 'ask'.
  visionFallbackConsent: VisionFallbackConsent
  videoFallbackConsent: VideoFallbackConsent
  // Paths of untrusted skills (project-root skills) the user has approved
  // with "Always Allow". Trusted skills (user/legacy roots) don't need
  // approval — they pass through directly.
  trustedSkills: string[]
  // Avatar configuration: how the user's profile picture is rendered.
  avatar?: AvatarSettings
  /**
   * When true, commits made from the Review panel include a
   * `Co-Authored-By: Verboo Code <noreply@code.verboo.ai>` trailer.
   * Default: false (opt-in).
   */
  includeVerbooCoAuthor: boolean
  /** When true, a verification mini-turn fires after edits that affect the browser. */
  browserVerificationEnabled: boolean
  /** Per-model reasoning effort preference. Keyed by model id; value is one
   *  of the model's raw.reasoning.effortLevels (e.g. "low", "medium", "high").
   *  Absent → model's defaultEffort applies. Promoted to UserSettings by
   *  Geralt; FE falls back to localStorage when the backend hasn't landed yet. */
  effortByModel?: Record<string, string>
  /**
   * When true (default), the plugins view fetches real icons from plugin
   * homepages (apple-touch-icon / favicon) via the backend cache. When
   * false, only monograms are rendered — no network calls for icons.
   * Privacy toggle in Settings → Privacy.
   */
  loadWebIcons: boolean
}

/// Profile avatar configuration.
/// kind='initials' → show the user's initials (default, no storage needed).
/// kind='preset'   → render one of the 50 built-in SVG icons (presetId + color).
/// kind='upload'   → show a user-uploaded photo (uploadPath saved by backend).
export type AvatarSettings = {
  kind: 'initials' | 'preset' | 'upload'
  presetId?: string
  presetColor?: string
  uploadPath?: string
  // Monotonic version bumped on each upload. The backend uses a fixed filename
  // (avatar.ext) so path never changes — version busts the cache and ensures
  // retry after a previous load failure.
  uploadVersion?: number
}

/// User consent for the vision fallback feature.
/// - 'ask': prompt the user before each fallback (default — safest).
/// - 'always': always run the fallback without asking.
/// - 'never': never run the fallback; images are ignored with a warning.
export type VisionFallbackConsent = 'ask' | 'always' | 'never'

export type VideoFallbackConsent = 'ask' | 'always' | 'never'

export type VideoUnderstandingRoute =
  | 'nativeOriginal'
  | 'nativeSdrProxy'
  | 'sampledFramesWithTranscript'

export type VideoComponentState = {
  asrModel: 'absent' | 'ready'
  bytes?: number
}

/// One frame the backend wants OCRed, addressed by a webview-loadable URL.
export type VideoOcrFrame = {
  timestampMs: number
  url: string
}

/// Backend request to OCR up to 60 timestamped frames for one video job.
export type VideoOcrRequest = {
  jobId: string
  frames: VideoOcrFrame[]
}

/// One recognized frame returned to the backend.
export type VideoOcrText = {
  timestampMs: number
  text: string
  confidence: number
}

export type VideoTranscriberProgress = {
  state: 'downloading' | 'ready' | 'error'
  bytesDownloaded: number
  totalBytes: number
  error?: string
}

/// State returned by `getVisionFallbackState` for Zelda's settings UI.
export type VisionFallbackState = {
  consent: VisionFallbackConsent
  helperModel?: {
    id: string
    displayName: string
  }
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

/**
 * Token usage as serialized by the Rust side.
 *
 * CONTRACT: Rust `TokenUsage` (src-tauri/src/models/types.rs:929-936) is
 * declared with `#[serde(rename_all = "camelCase")]`, so the JSON the
 * renderer receives via Tauri events has camelCase keys:
 *   inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens
 *
 * G-C12: this type previously declared snake_case keys, which made tsc
 * validate all reads against a contract that LIED about what the Rust
 * side sends. The renderer read `usage.input_tokens` (undefined) and
 * the `?? 0` coalescing silently turned every read into zero — the
 * goal token accumulator and the composer tok/s indicator both
 * appeared to work in tests but always reported zero in production.
 *
 * NOTE: the CLI sends snake_case in its raw stream payload, and the
 * Rust side desserializes that into the same struct (serde rename
 * works both ways). The renderer's `extractTokenUsage` reads the
 * CLI's raw snake_case payload directly and must continue to do so;
 * it returns a `TokenUsage` typed value, so it renames the keys to
 * camelCase on the way out (see App.tsx:extractTokenUsage).
 */
export type TokenUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

export type ContextUsageSnapshot = {
  usedTokens: number
  maxTokens?: number
  percentage?: number
  inputTokens?: number
  outputTokens?: number
  /**
   * 'cli-usage' — real numbers reported by the CLI stream.
   * 'estimated' — local chars/4 estimate; used when the router reports
   * all-zero usage and no context_window object.
   */
  source: 'cli-usage' | 'estimated'
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

export type AttachmentKind = 'image' | 'video' | 'file' | 'browser-annotation'

export type VideoHdrKind = 'sdr' | 'hlg' | 'pq' | 'dolbyVision' | 'unknown'

export type VideoProgressStage =
  | 'validating'
  | 'preparing'
  | 'transcribing'
  | 'analyzing'
  | 'consolidating'

export type VideoStreamMetadata = {
  durationMs: number
  container: string
  videoCodec: string
  audioCodec?: string
  width: number
  height: number
  avgFps: number
  hasAudio: boolean
  hdr: VideoHdrKind
  colorPrimaries?: string
  colorTransfer?: string
  bitDepth?: number
}

export type ModelMediaCapabilities = {
  image: boolean
  video: boolean
  audio: boolean
  videoContainers: string[]
  videoCodecs: string[]
  acceptsHdrVideo: boolean
}

export type CliMediaCapabilities = {
  imageBlocks: boolean
  videoBlocks: boolean
  audioBlocks: boolean
}

export type VideoProgress = {
  jobId: string
  turnId: string
  stage: VideoProgressStage
  completedUnits?: number
  totalUnits?: number
}

// Outcome of attempting text extraction on an attachment.
// - 'extracted': extractedText holds real content the model can reason about.
// - 'warning': extractedText holds a warning string (scanned/corrupt/too-large).
// Absent when no extraction was attempted (non-PDF, image).
export type ExtractionStatus = 'extracted' | 'warning'

// Browser annotation created via pencil (freehand) or arrow (element pick).
// Crop and viewport snapshot are local PNGs produced by the native webview.
export type BrowserAnnotation = {
  kind: 'pen' | 'element'
  crop: string
  note?: string
  url: string
  selector?: string
  component?: string
  rect: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
  viewportSnapshot?: { path: string; width: number; height: number; size: number }
}

export type AttachmentMeta = {
  path: string
  name: string
  size: number
  kind: AttachmentKind
  mediaType?: string
  width?: number
  height?: number
  // Text extracted from the file at attach time (e.g. PDF text layer).
  // When present, this is injected into the prompt so any model — vision
  // or not — can reason about the content. Absence means no extraction
  // was attempted or the file is only usable via vision (image/PDF-as-image).
  extractedText?: string
  // Whether extractedText holds real content ('extracted') or a warning
  // string ('warning'). Frontend uses this to distinguish "model has real
  // content" from "model received a warning" without parsing the string.
  extractionStatus?: ExtractionStatus
  video?: VideoStreamMetadata
  browserAnnotation?: BrowserAnnotation
}

export type AgentTurnRequest = {
  turnId?: string
  conversationId: string
  message: string
  model?: string
  modelSupportsVision?: boolean
  runVisionFallback?: boolean
  mediaCapabilities?: ModelMediaCapabilities
  cliMediaCapabilities?: CliMediaCapabilities
  runVideoAnalysis?: boolean
  contextWindow?: number
  effort?: string
  /** Reasoning config snapshot at request-build time. FE reads this on the
   *  Rust side to know which effortLevels are valid for the model, so it can
   *  distinguish "user picked 'none'" from "no preference sent". */
  reasoning?: ModelReasoning
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
  label?: string
  topic: string
  baseRequest: AgentTurnRequest
}

export type ResearchSubagentsRunRequest = {
  runId?: string
  count: number
  requestedCount?: number
  labels?: string[]
  baseRequest: AgentTurnRequest
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
  additions?: number
  deletions?: number
  diffPreview?: string
}

export type CliTerminalFailure = {
  category: string
  message: string
  details: string[]
  exitCode: number | null
  sessionId?: string
  recoveryReady: boolean
}

export type AgentEvent =
  | { type: 'started'; turnId: string; conversationId?: string }
  | { type: 'stdout'; turnId: string; conversationId?: string; text: string }
  | { type: 'stderr'; turnId: string; conversationId?: string; text: string }
  | { type: 'json'; turnId: string; conversationId?: string; payload: unknown; runtimeStatus?: RuntimeStatus; runtimeActivity?: RuntimeActivity }
  | { type: 'result'; turnId: string; conversationId?: string; result: AgentResultSnapshot }
  | { type: 'subagent-thread'; turnId: string; conversationId: string; subagentThread: SubagentThreadUpdate }
  | { type: 'video-progress'; turnId: string; conversationId?: string; videoProgress: VideoProgress }
  | { type: 'error'; turnId: string; conversationId?: string; message: string; payload?: CliTerminalFailure; exitCode?: number | null }
  | { type: 'done'; turnId: string; conversationId?: string; exitCode: number | null }

export type AppConfig = {
  workingDirectory: string
  accessMode: AccessMode
  platform: NodeJS.Platform
  selectedModel?: string
}

// ── Verboo in Chrome integration ──────────────────────────────

export type ChromeComponentState = 'missing' | 'managed' | 'outdated' | 'invalid' | 'conflict'
export type ChromeConnectionState = 'connected' | 'waitingForChrome' | 'ambiguous' | 'incompatible'
export type ChromeIntegrationAggregate = 'notConfigured' | 'incomplete' | 'ready' | 'connected'
export type ChromeExtensionIdSource = 'none' | 'release' | 'development'

export type ChromeIntegrationStatus = {
  extension: ChromeComponentState
  bridge: ChromeComponentState
  mcp: ChromeComponentState
  connection: ChromeConnectionState
  aggregate: ChromeIntegrationAggregate
  installedVersion?: string
  availableVersion: string
  canConfigure: boolean
  canRepair: boolean
  canRemove: boolean
  storeUrlAvailable: boolean
  developmentBuild: boolean
  extensionIdSource: ChromeExtensionIdSource
  errorCode?: string
}

export type ChromeIntegrationRequest = {
  developmentExtensionId?: string
}

// ── Review types ────────────────────────────────────────────────

export type WorkspaceReviewScope = 'github-repo' | 'git-repo' | 'local-folder'

export type WorkspaceReviewCapabilities = {
  canDiff: boolean
  canRevert: boolean
  canOpenExternal: boolean
  canCommit: boolean
  canPush: boolean
  canCreatePr: boolean
}

export type WorkspaceCommitResult = {
  ok: boolean
  commitHash?: string
  error?: string
}

export type WorkspacePullRequestResult = {
  ok: boolean
  url?: string
  error?: string
}

export type WorkspacePushResult = {
  ok: boolean
  remote?: string
  branch?: string
  error?: string
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
  aheadCount?: number
  behindCount?: number
  hasUpstream?: boolean
  hasRemote?: boolean
  lastCommitHash?: string
  lastCommitSubject?: string
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
  /**
   * True when a stable channel with a valid manifest exists. False on 404,
   * network error, or invalid manifest. Fail-closed: when in doubt, false.
   * Drives the disabled state of the Stable choice chip in settings.
   * Mirror of Rust `UpdateSnapshot.stable_channel_available`.
   */
  stableChannelAvailable?: boolean
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

export type InstallUpdateResult = {
  status: 'busy' | 'restarting'
  activeTurns: number
}

export type SidebarUpdatePresentation = {
  phase:
    | 'available'
    | 'downloading'
    | 'ready'
    | 'waiting'
    | 'restarting'
    | 'error'
  version?: string
  percent?: number
  error?: string
  actionEnabled: boolean
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
