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
  // D-D: the agent honest-reported the task as impossible but produced
  // only a symbolic artifact (empty file, stub). Rust emits pause +
  // taskImpossible; the FE pauses RESUMABLY (blocked, never failed) so
  // the user can reply in the composer and resume with context intact.
  | 'taskImpossible'
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

/**
 * T1/T2: status of one task inside a goal BATCH.
 *   pending  → not started
 *   active   → the task the scheduler is currently working on (at most
 *              one per goal). The T2 state matrix calls this "running" —
 *              same state, older name kept so T1 code stays stable.
 *   done     → passed the D1 completion rule (decision=complete +
 *              turnsRunThisTask>0 + whitelisted action evidence).
 *   failed   → terminal failure (T2 rows 5/7/8: unsafe, infraError at
 *              max, or loop detected). Counts toward the K guard unless
 *              the path pauses the batch on its own (unsafe/infraError
 *              bypass K — they already ARE systemic diagnoses).
 *   blocked  → the evaluator soft-stopped with needsUser (T2 row 4):
 *              the task waits for the user, resumable — returns to
 *              'active' when the cycle restarts. Distinct from failed:
 *              blocked is a question, failed is a diagnosis.
 *   skipped  → the USER chose to jump over a blocked task (T2 row 12).
 *              Distinct from failed ON PURPOSE: skip is a human
 *              decision, NOT a systemic problem, so it never feeds K.
 */
export type GoalTaskStatus = 'pending' | 'active' | 'done' | 'failed' | 'blocked' | 'skipped'

/**
 * T1: one task of a goal BATCH (the /goal-lote). ONE GoalState record
 * owns the whole batch — N tasks INSIDE a single goal, NOT N goals.
 * ownerConversationId lives on the goal and is stamped once at creation;
 * advancing between tasks never touches it (the contract is POSSESSION,
 * not freshness — G-C5/G-C8 family).
 *
 * Renderer-only: Rust GoalState (types.rs:921) has no task concept and
 * serde ignores unknown keys when the goal crosses inside
 * GoalEvaluationInput (same argument as G-C17's evaluatorInputTokens).
 *
 * `toolless` is the per-task D1 opt-out: a task whose legitimate output
 * is prose only (e.g. "write a haiku in chat") declares it AT CREATION.
 * Default (absent) REQUIRES whitelisted action evidence to complete.
 * Opting out waives ONLY the evidence leg — turnsRunThisTask>0 still
 * applies (a zero-turn completion is never accepted).
 */
export type GoalTask = {
  id: string
  text: string
  status: GoalTaskStatus
  toolless?: boolean
  startedAt?: number
  completedAt?: number
  // T4: per-task EVIDENCE for the final batch report, stamped by the
  // scheduler at the task's terminal transition (done/failed/skipped).
  // The report must CITE what sustained each conclusion — a batch that
  // completes a task with zero observable action is the turnsRun-zero
  // incident class multiplied by N in silence. Renderer-only, same
  // serde-ignores-unknown-keys argument as the GoalState batch fields.
  /** Turns the task ran (turnsRunThisTask captured BEFORE the boundary
   *  reset). */
  turns?: number
  /** Whitelisted action activities counted in the task's D1 evidence
   *  window at completion (done only; undefined for toolless tasks —
   *  evidence waived — and for non-done outcomes). */
  evidenceCount?: number
  /** WHY the task failed: 'loop' (three identical fingerprints),
   *  'unsafe' (evaluator flag — pauses the whole batch), 'infraError'
   *  (evaluator dead at max retries). Absent for done/skipped. */
  failureReason?: 'loop' | 'unsafe' | 'infraError'
}

export type GoalState = {
  id: string
  objective: string
  /** The raw multi-line message the user typed to start a batch — shown
   *  verbatim in the goal panel instead of the synthetic umbrella
   *  ("Batch of N tasks") so they recognize their own request. TS-only;
   *  present only on batch goals. Crosses inside GoalEvaluationInput as
   *  an ignored unknown key (same serde argument as the G-C17/T1
   *  renderer-only fields): the evaluator reads `objective`, which the
   *  snapshot keeps pointing at the CURRENT task — never at this text. */
  batchInput?: string
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
   *
   * T1 adendo: in a BATCH goal this is stamped once at creation and is
   * NEVER re-stamped when advancing between tasks — the contract is
   * POSSESSION, not freshness.
   */
  ownerConversationId?: string
  /**
   * T1: the task BATCH. When present and non-empty, this goal is a
   * batch: one GoalState record owning N tasks (see GoalTask). When
   * ABSENT, the goal is a legacy single-task goal and every batch code
   * path is skipped — the pre-T1 behavior is preserved byte-for-byte
   * (aceite 4: no single-task regression). The key stays ABSENT (not
   * undefined-valued, not empty) for legacy goals so the check
   * `goal.tasks?.length` is the only gate.
   *
   * Renderer-only: Rust GoalState (types.rs:921) has no counterpart;
   * serde ignores unknown keys at the boundary (same as G-C17).
   */
  tasks?: GoalTask[]
  /**
   * T1: index of the currently active task inside `tasks`. Clamped by
   * readers (currentGoalTask in goalState.ts) so a stale index can
   * never crash the cycle. Renderer-only (see `tasks`).
   */
  taskIndex?: number
  /**
   * T1: turns executed for the CURRENT task. Reset to 0 at every task
   * boundary (aceite 2). Incremented where `turnsRun` is incremented
   * (App.tsx continueGoal delegate) — and ONLY for batch goals: legacy
   * goals keep the key ABSENT so the per-task view falls back to
   * `turnsRun` untouched.
   *
   * This is the counter that crosses to Rust: buildEvaluatorSnapshot
   * (goalState.ts) copies it into the SNAPSHOT's `turnsRun` field, so
   * the stateless Rust evaluator and its "Turns run: N" prompt operate
   * PER TASK without knowing a batch exists. Renderer-only at rest
   * (same serde argument as G-C17).
   */
  turnsRunThisTask?: number
  /**
   * T2 (row 9): the K guard's counter — CONSECUTIVE tasks that reached
   * `failed` while the batch kept running (today only the loop path,
   * row 8; unsafe and infraError-at-max pause the batch immediately and
   * BYPASS K — rows 5/7, they already ARE systemic diagnoses and
   * waiting for a second occurrence would ignore information we have).
   *
   * Incremented on each failed task, RESET TO 0 on ANY task done
   * ("contam só failed CONSECUTIVOS, e ZERA em qualquer done"). A skip
   * (row 12) is TRANSPARENT to K: it neither increments nor resets —
   * skip is a user decision, not a health signal, and two loop failures
   * with a skip between them are still consecutive failures. When the
   * counter reaches BATCH_STAGNATION_K (=2) the batch pauses with
   * pauseReason 'batchStagnation'.
   *
   * Renderer-only (same serde argument as G-C17); resume does NOT reset
   * it — the failures are still consecutive across a pause, and pause
   * is cheap (the user clicks resume once).
   */
  consecutiveFailedTasks?: number
  /**
   * T3: how many task-boundary compactions FAILED in this batch. The
   * frontier protocol compacts between tasks; when a compaction fails
   * the batch PROCEEDS WITHOUT COMPACTING (never blocked by it) — but
   * the failure must not be hidden: this counter is what lets the final
   * report (T4) declare "N compactions failed; the batch continued
   * without compacting". A missing key means zero failures (legacy
   * batches pre-T3 read as `?? 0`).
   *
   * Renderer-only (same serde argument as G-C17): the field crosses to
   * Rust inside the GoalState snapshot and serde ignores unknown keys
   * there; nothing changes in src-tauri.
   */
  compactionFailures?: number
  /**
   * T3b: a compaction frontier is OWED to the current task. Set ONLY by
   * skipBlockedGoalTask (row 12): the skip advance happens OUTSIDE the
   * goal cycle — a pure transition, the UI collects the click (T4) and
   * the App restarts the cycle — so the frontier cannot run inline the
   * way it does on the done/loop advances. The next runGoalCycle start
   * sees the flag, executes the pending frontier with the exact T3
   * protocol (fire /compact, AWAIT conclusion, THEN reset) and clears
   * it — so later resumes of the SAME task do not compact again
   * (idempotent). NOT set when the skipped task was the LAST one (the
   * batch completed; there is no next task to compact for). Also NOT
   * set when the skipped task ran ZERO turns (T3b coalescence): with
   * no turns, nothing new entered the context since the last
   * compaction — the skip is declared in the goal log instead.
   *
   * Renderer-only (same serde argument as G-C17): the flag crosses to
   * Rust inside the GoalState snapshot and serde ignores unknown keys
   * there; nothing changes in src-tauri.
   */
  pendingCompaction?: boolean
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
  | 'general'
  | 'account'
  | 'context'
  | 'security'
  | 'integrations'
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
  kind?: 'message' | 'activity' | 'summary' | 'annotation'
  // 'planning' — T1-TodoWrite (2026-07-31): the Rust side maps the
  // todowrite tool to kind="planning" (turn_service.rs activity_for_tool)
  // ON PURPOSE: planning is declaring intent, NOT acting, so this kind
  // must stay OUT of the D1 observable-action whitelist
  // (goalState.ts ACTION_ACTIVITY_KINDS). The transcript renders no row for
  // planning: ChecklistPanel is its dedicated presentation, and the
  // evaluator just never counts it as action.
  activityKind?: 'thinking' | 'image' | 'video' | 'read' | 'edit' | 'search' | 'command' | 'terminal' | 'permission' | 'subagent' | 'queued' | 'context' | 'tool' | 'compacting' | 'planning' | 'browser'
  activityDetail?: string
  /** Native diagnostic kept behind a friendly user-facing error summary. */
  errorDetail?: string
  /** User-requested interruption uses the assistant's quiet transcript treatment. */
  presentation?: 'interruption'
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
  // T4: batch-goal PROGRESS line (e.g. "Tarefa 3 de 12"), stamped on the
  // LATEST turn's summary item while the batch runs (one line, updated
  // each cycle — never a badge, never a separate box; the G-C15-TS
  // surface rule). Cleared on the final item when the batch completes —
  // the report below supersedes it, and two lines saying the same thing
  // is the duplication the user rejected. Renderer-only like usageLine:
  // Rust's TranscriptItem has no counterpart and serde ignores the
  // unknown keys when items cross inside GoalEvaluationInput —
  // usageLine itself is the in-production precedent (G-C15-TS).
  progressLine?: string
  // T4: batch-goal FINAL REPORT — one line per task with its cited
  // evidence (turns/actions for done, reason for failed, "skipped by
  // you"), plus the compaction-failure footer when compactions failed.
  // Stamped on the LAST turn's summary item by the onComplete delegate
  // alongside usageLine. Rendered as plain lines in the SAME
  // .turn-usage-line typographic family — no box, no badge.
  batchReportLines?: string[]
  modelId?: string
  modelDisplayName?: string
  /** Provider stamped at send time (F3: absent = verboo). The transcript
   *  header prefers this over re-resolving from the live catalog — the
   *  catalog can degrade mid-turn (provider CLI hiccup) and the header of a
   *  finished turn must not retroactively lose its provider. */
  provider?: string
  streaming?: boolean
  skills?: SkillSummary[]
  // Attachments sent with this message — thumbnail metadata only (paths,
  // names, kinds), no base64 blobs. Survives conversation reload.
  attachments?: Pick<AttachmentMeta, 'path' | 'name' | 'kind' | 'size' | 'mediaType' | 'browserAnnotation' | 'simulatorAnnotation'>[]
  /** F3 (N3): the annotation TURN item — kind 'annotation'. The quote+comment
   *  pairs are FROZEN inside the item at send time: "consultable forever"
   *  never depends on re-anchoring against the transcript (the excerpt may
   *  be edited or compacted away later). Self-contained by design.
   *  DEGRADATION CONTRACT for older builds: `text` carries a readable
   *  fallback rendering of these same pairs, so an old version that does
   *  not know kind 'annotation' still shows the content as a plain user
   *  message instead of breaking or hiding it. */
  annotationEntries?: { quote: string; comment: string | null }[]
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
  // FRENTE-A (2026-08-02): the bundled Verboo-in-Chrome extension's tools
  // (mcp__verboo-in-chrome__* → activity_for_tool kind "browser"). One kind
  // shared by all 8 tools; the specific action lives in the label.
  | 'browser'

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
  /** Owning provider (F2 contract, mirrors Rust `VerbooModel.provider` with
   *  `skip_serializing_if = "Option::is_none"`): ABSENT means 'verboo' — the
   *  current catalog keeps working unchanged. Values seen: 'claude', 'codex'. */
  provider?: string
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

/** F4 contract, mirrors Rust `ProviderAuthStatus` (provider_login_pty.rs:74-79):
 *  ONE ENTRY PER PROVIDER the login bridge supports — `connected: false`
 *  entries included, so this IS the provider universe for the renderer.
 *  `account` is absent when None (skip_serializing_if). The global CLI auth
 *  state is an internal backend detail and does NOT cross to the renderer
 *  (CONTRATO DE REMOÇÃO, provider_login_pty.rs:64-69). */
export type ProviderAuthStatus = {
  provider: string
  connected: boolean
  account?: string
}

/** F4 contract, mirrors Rust `ProviderLoginEvent` (provider_login_pty.rs:45)
 *  emitted on the `provider-login:event` channel. `state` is snake_case on
 *  the wire; `message` is absent when None (skip_serializing_if).
 *  `risk_notice` (claude): the Anthropic policy acceptance screen — `message`
 *  carries the FULL notice, verbatim; the owner accepts or cancels. */
export type ProviderLoginEvent = {
  provider: string
  state: 'awaiting_browser' | 'risk_notice' | 'connected' | 'error'
  message?: string
}

export type LoginResult = {
  ok: boolean
  message: string
  status?: CliAuthStatus
}

/**
 * A1: kind discriminator of `LoginEvent`. Rust enum `LoginEventKind`
 * (types.rs:608) uses `#[serde(rename_all = "lowercase")]` — a
 * DIFFERENT serde attribute from the `camelCase` used by the struct
 * family around it (LoginEvent, TokenUsage, …). The wire values are
 * exactly these lowercase strings; capitalizing them here
 * ('Url' | 'Complete' | 'Error') would compile and silently never
 * match — the same defect class as the snake_case TokenUsage.
 */
export type LoginEventKind = 'url' | 'complete' | 'error'

/**
 * A1: payload of the `login:event` Tauri channel (event name is
 * literally `login:event`, with the colon). Rust struct LoginEvent
 * (types.rs:590) uses `rename_all = "camelCase"`. All four optional
 * fields use `skip_serializing_if Option::is_none` — when absent the
 * KEY IS OMITTED from the JSON and arrives as `undefined`, not null.
 * Treat absence, not null.
 *
 * Dispatch contract (cli_service.rs):
 *   - `url`      → `url` carries the login URL extracted from CLI
 *                  stdout. The browser may not open by itself (Linux,
 *                  issue #59), so the UI MUST show it, copyable.
 *   - `complete` → login finished. `ok === false` means failure;
 *                  `message` carries CLI stdout/stderr (the specific
 *                  cause); `status` is the post-login auth snapshot.
 *   - `error`    → infra failure (e.g. spawn). `message` carries the
 *                  specific cause — never reduce it to a generic.
 */
export type LoginEvent = {
  kind: LoginEventKind
  url?: string
  message?: string
  ok?: boolean
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

export type AttachmentKind = 'image' | 'video' | 'file' | 'browser-annotation' | 'simulator-annotation'

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

export type SimulatorAnnotation = {
  kind: 'element' | 'area'
  crop: string
  note?: string
  device: {
    name: string
    udid: string
    iosVersion: string
    orientation: 'portrait' | 'landscape'
  }
  deviceGeneration: number
  frameGeneration: number
  rect: { x: number; y: number; width: number; height: number }
  deviceRect: { x: number; y: number; width: number; height: number }
  element?: { id: string; role: string; label?: string }
  viewportSnapshot: { path: string; width: number; height: number; size: number }
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
  simulatorAnnotation?: SimulatorAnnotation
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
  /** F3-Annotations: user annotations on transcript excerpts, sent as a
   *  FIELD — never concatenated into `message` (the block assembly with
   *  UPPERCASE origin labels and char-safe truncation lives in Rust,
   *  turn_service.rs build_annotation_block). Mirrors
   *  `#[serde(default)] annotations: Option<Vec<Annotation>>`: the key is
   *  ABSENT when empty, so a request without annotations stays
   *  byte-identical to the pre-F3 shape (pinned by applyAnnotations). */
  annotations?: Annotation[]
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

/**
 * T1-TodoWrite (2026-07-31): one entry of a TodoWrite tool call.
 * Frontier with TORNO — mirrors `pub struct TodoItem` in
 * src-tauri/src/models/types.rs, which is `#[serde(rename_all =
 * "camelCase")]`: the Rust field `active_form` arrives as `activeForm`.
 * Declaring `active_form` here would compile and read `undefined`
 * forever — the exact G-C12 TokenUsage defect class. The key-shape
 * pair is pinned in features/goal/rustSerdeContract.test.ts.
 *
 * `status` values come from the CLI's TodoItemSchema:
 * "pending" | "in_progress" | "completed". `activeForm` is the
 * present-continuous label the CLI shows while the item is
 * in_progress (e.g. "Mapeando os reasonIds"); display falls back to
 * `content` when it is empty.
 */
export type TodoItemStatus = 'pending' | 'in_progress' | 'completed'

export type TodoItem = {
  content: string
  status: TodoItemStatus
  activeForm: string
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
  /**
   * T1-TodoWrite: structured todo list from the todowrite tool.
   * Frontier with TORNO (`todos: Option<Vec<TodoItem>>` in types.rs
   * with `skip_serializing_if = "Option::is_none"`): when there is no
   * list the KEY IS ABSENT from the JSON — it arrives `undefined`,
   * never `null`. Treat ABSENCE, not nullity. Populated only for
   * main-turn todowrite events; subagent TodoWrites are filtered in
   * Rust and never cross the bridge. Semantics: each TodoWrite call
   * REPLACES the whole list — never accumulate.
   */
  todos?: TodoItem[]
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
export type ChromePanelState = 'notApplicable' | 'unknown'

export type ChromeIntegrationStatus = {
  extension: ChromeComponentState
  bridge: ChromeComponentState
  mcp: ChromeComponentState
  connection: ChromeConnectionState
  panelState: ChromePanelState
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

// --- Anotações (F0) -----------------------------------------------------------
// Contrato FIXADO pelo Maestro, idêntico ao que o TORNO recebeu no Rust. Não
// renomear, não acrescentar campo: a fronteira Rust<->TS é camelCase e o Rust
// já tem serde(rename_all = "camelCase") — um campo em snake_case aqui zera
// silenciosamente o dado na ponte (já aconteceu com TokenUsage).
//
// Teto de quote: seleções acima de ANNOTATION_QUOTE_MAX (2000) chars são
// truncadas NA CRIAÇÃO (não no resolvedor). Convenção de marcação, sem campo
// novo no contrato: ao truncar, a criação grava suffix === '' — o suffix do
// trecho COMPLETO não é vizinho do quote truncado no texto, então não teria
// poder de desempate; o vazio sinaliza "não use suffix" e quote.length ===
// ANNOTATION_QUOTE_MAX com suffix vazio identifica um quote truncado.
export const ANNOTATION_QUOTE_MAX = 2000
export const ANNOTATION_CONTEXT_MAX = 40

export type Annotation = {
  id: string
  segmentId: string
  quote: string
  prefix: string
  suffix: string
  occurrenceIndex: number
  comment: string | null
  createdAt: number
}
