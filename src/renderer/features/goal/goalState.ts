import type { AccessMode, GoalState, GoalTask, SkillSummary, TranscriptItem } from '../../../shared/types'

/**
 * "Unlimited" sentinel for numeric fields that Rust declares as u32.
 *
 * The Rust GoalState (types.rs:935) declares `max_turns: u32` whose
 * maximum is 4_294_967_295. Sending a value above that — e.g.
 * Number.MAX_SAFE_INTEGER (9_007_199_254_740_991) — causes serde to
 * reject the entire `evaluate_goal` Tauri invoke before the CLI is
 * ever spawned. The Goal would silently never run.
 *
 * 4.29 billion turns is semantically infinite for a goal loop.
 * This constant is the contract boundary: TS must never exceed it.
 *
 * DOMAIN: turns (count of iterations). Do NOT use for time fields —
 * use GOAL_MAX_ELAPSED_MS_UNLIMITED instead. Same numeric value,
 * different meaning; mixing them is the class of defect that caused
 * G-C7 in the first place.
 */
export const GOAL_MAX_TURNS_UNLIMITED = 4_294_967_295

/**
 * "Unlimited" sentinel for the elapsed-time budget, in milliseconds.
 *
 * DOMAIN: time (milliseconds). Distinct from GOAL_MAX_TURNS_UNLIMITED
 * (turns) on purpose — same numeric value, different meaning.
 *
 * The Rust GoalState (types.rs:986) declares `max_elapsed_ms: u64`,
 * so we are NOT constrained to u32::MAX here. We choose u32::MAX
 * (4_294_967_295 ms ≈ 49.7 days) for three reasons:
 *   1. It is far beyond any realistic single-goal run — a goal that
 *      ran 49 days continuously would be a bug, not a use case.
 *   2. It matches the turns sentinel, so a reader who understands
 *      one immediately understands the other.
 *   3. If Rust ever narrows max_elapsed_ms to u32 (e.g. for struct
 *      alignment), this value still fits — no second migration.
 *
 * The risk of using Number.MAX_SAFE_INTEGER here would be different
 * from G-C7: u64 holds it, so serde would NOT reject the invoke.
 * But it would still be a domain leak — a JS implementation detail
 * leaking into a Rust contract — and we are explicitly rejecting
 * that pattern.
 */
export const GOAL_MAX_ELAPSED_MS_UNLIMITED = 4_294_967_295

type CreateGoalInput = {
  objective: string
  accessMode: AccessMode
  modelId?: string
  modelDisplayName?: string
  workingDirectory: string
  skills: SkillSummary[]
  /**
   * Kept for backwards compatibility with callers that still pass
   * settings values, but no longer enforced — tokens and time are
   * unlimited. Defaults to GOAL_MAX_TURNS_UNLIMITED (= u32::MAX)
   * so the scheduler never pauses on budget, and serde accepts the
   * value.
   */
  maxTurns?: number
  maxElapsedMinutes?: number
  /**
   * T1: the task BATCH. When present and non-empty, the goal is created
   * as a batch: ONE GoalState record owning N tasks — the first task is
   * stamped `active` (+startedAt), the rest `pending`, taskIndex=0 and
   * turnsRunThisTask=0. When absent, the batch keys stay ABSENT on the
   * goal (legacy single-task path, zero regression — aceite 4).
   *
   * `toolless` is the per-task D1 opt-out declared AT CREATION (the
   * "write a haiku in chat" case). Default REQUIRES action evidence.
   */
  tasks?: { text: string; toolless?: boolean }[]
}

export function createGoalState(input: CreateGoalInput): GoalState {
  const now = Date.now()
  // T1: batch creation. The first task starts active with its evidence
  // window opened (startedAt); the rest wait as pending. When no batch
  // is provided the batch keys stay ABSENT on the returned goal — the
  // legacy single-task path gates on `goal.tasks?.length`.
  const batchTasks: GoalTask[] | undefined = input.tasks?.length
    ? input.tasks.map((task, index) => ({
        id: `task:${crypto.randomUUID()}`,
        text: task.text.trim(),
        status: (index === 0 ? 'active' : 'pending') as GoalTask['status'],
        ...(task.toolless ? { toolless: true } : {}),
        ...(index === 0 ? { startedAt: now } : {}),
      }))
    : undefined
  return {
    id: `goal:${crypto.randomUUID()}`,
    objective: input.objective.trim(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    turnsRun: 0,
    // Unlimited — fields remain on GoalState for backwards compat but
    // are set to domain-appropriate sentinels and never trigger a
    // pause. Each constant matches its Rust field's type width:
    //   - maxTurns (u32) ← GOAL_MAX_TURNS_UNLIMITED
    //   - maxElapsedMs (u64) ← GOAL_MAX_ELAPSED_MS_UNLIMITED
    // Mixing them is the G-C7 defect class — keep them separate.
    maxTurns: GOAL_MAX_TURNS_UNLIMITED,
    maxElapsedMs: GOAL_MAX_ELAPSED_MS_UNLIMITED,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    accessMode: input.accessMode,
    modelId: input.modelId,
    modelDisplayName: input.modelDisplayName,
    workingDirectory: input.workingDirectory,
    skills: input.skills,
    noProgressCount: 0,
    recentFingerprints: [],
    // T1: batch keys present ONLY for batch goals (conditional spread
    // keeps them ABSENT — not undefined-valued — on legacy goals).
    ...(batchTasks ? { tasks: batchTasks, taskIndex: 0, turnsRunThisTask: 0 } : {}),
  }
}

/**
 * Sanitize a GoalState loaded from persisted storage (chatStore /
 * conversation.goal) before it re-enters the live React state.
 *
 * WHY THIS EXISTS:
 * Goals created before G-C7-TS-FIX (v0.6.0-beta.x) stored
 * `maxTurns: Number.MAX_SAFE_INTEGER` (9_007_199_254_740_991) and
 * `maxElapsedMs: Number.MAX_SAFE_INTEGER` on disk. The Rust
 * GoalState declares `max_turns: u32` (types.rs:935), so serde rejects
 * the entire `evaluate_goal` invoke when the stale value is sent —
 * the goal silently never runs, exactly the original G-C7 bug, but
 * for pre-existing goals rather than newly-created ones.
 *
 * This function clamps every numeric field that has a Rust-side
 * width to its domain's sentinel, so any goal persisted with a
 * too-large value is migrated on read. The migration is idempotent:
 * goals already within bounds pass through unchanged.
 *
 * CALL SITES: every path that reconstructs a GoalState from
 * persisted data must run through this function. Today there are
 * two — App.tsx hydration effect (~line 1132) and
 * selectConversation (~line 3532). If a third appears, route it
 * through here too; the contract-test file enumerates the call
 * sites via grep to catch omissions.
 *
 * DOMAIN: this is the dual of createGoalState — createGoalState
 * builds a fresh goal with correct sentinels; sanitizeStoredGoal
 * repairs a stale one. Both must agree on the constant mapping.
 */
export function sanitizeStoredGoal(goal: GoalState): GoalState {
  return {
    ...goal,
    // turns domain — Rust u32 (types.rs:935)
    maxTurns:
      goal.maxTurns !== undefined && goal.maxTurns > GOAL_MAX_TURNS_UNLIMITED
        ? GOAL_MAX_TURNS_UNLIMITED
        : goal.maxTurns,
    // time domain — Rust u64 (types.rs:986), but we still cap at the
    // time sentinel for domain consistency (see GOAL_MAX_ELAPSED_MS_UNLIMITED
    // JSDoc for why u32::MAX is the chosen ceiling despite u64 width).
    maxElapsedMs:
      goal.maxElapsedMs !== undefined && goal.maxElapsedMs > GOAL_MAX_ELAPSED_MS_UNLIMITED
        ? GOAL_MAX_ELAPSED_MS_UNLIMITED
        : goal.maxElapsedMs,
  }
}

export function goalSystemMessage(text: string): TranscriptItem {
  return {
    id: `goal-system:${crypto.randomUUID()}`,
    role: 'system',
    text,
    timestamp: Date.now(),
  }
}

// ─── D-D: pause with reply-to-resume (taskImpossible) ───────────────

/**
 * D-D item 1 — SESSION REHYDRATION on resume ("sem perda de contexto").
 *
 * The goal's CLI session survives an in-app pause because there is no
 * live process and every turn re-attaches via resume. But the App's
 * goalSessionId ref is volatile and was NEVER rehydrated from
 * goal.lastSessionId (the persisted value): resuming after an APP
 * RESTART silently created a NEW session — the user replied believing
 * the model remembered everything and it started from zero.
 *
 * The rule: a LIVE session id always wins (never clobber the session
 * the in-app pause kept); only when the ref is empty (restart) do we
 * fall back to the persisted lastSessionId. Legacy goals without
 * lastSessionId legitimately return undefined → a fresh session, the
 * pre-D-D behavior for goals that never ran a turn.
 */
export function resumeGoalSessionId(
  goal: GoalState,
  liveSessionId: string | undefined,
): string | undefined {
  return liveSessionId ?? goal.lastSessionId
}

/**
 * D-D item 2 — REPLY RESUMES. A composer reply auto-resumes the goal
 * ONLY when all three hold:
 *   - the goal is PAUSED (an active goal must never be re-triggered);
 *   - the pause reason is 'taskImpossible' — other pauses (userPaused,
 *     unsafe, batchStagnation…) keep their explicit-resume semantics,
 *     a reply must not resume them by accident (counterfactual pinned
 *     in the tests);
 *   - POSSE: the message went to the goal's OWNER conversation
 *     (ownerConversationId), not whatever conversation is active —
 *     replying in an unrelated chat must not drive the goal (G-C8).
 */
export function shouldResumeGoalOnUserMessage(
  goal: GoalState | undefined,
  conversationId: string,
): boolean {
  return (
    goal?.status === 'paused' &&
    goal.pauseReason === 'taskImpossible' &&
    goal.ownerConversationId === conversationId
  )
}

// ─── T1: goal BATCH (lote) + D1 action-evidence guard ───────────────

/**
 * T1: the currently active task of a batch goal, with the index clamped
 * into range so a stale `taskIndex` (e.g. persisted mid-refactor) can
 * never crash the cycle. Returns undefined for legacy single-task goals
 * (batch keys absent) — every batch code path gates on this.
 */
export function currentGoalTask(goal: GoalState): GoalTask | undefined {
  const tasks = goal.tasks
  if (!tasks || tasks.length === 0) return undefined
  return tasks[Math.min(goal.taskIndex ?? 0, tasks.length - 1)]
}

/**
 * T1 — THE SNAPSHOT TRICK (b): the GoalState actually sent to the Rust
 * evaluator for a batch goal.
 *
 * The Rust evaluator is STATELESS and only reads the GoalState the
 * renderer sends at each `evaluate_goal` call. By sending a snapshot
 * whose `objective` is the CURRENT TASK's text and whose `turnsRun` is
 * `turnsRunThisTask` (the per-task counter copied into the global field
 * Rust already reads), the evaluator's completion guard and its
 * "Turns run: N" prompt operate PER TASK without Rust knowing a batch
 * exists. ZERO change in src-tauri — if this ever needs a Rust change,
 * the design leaked: STOP and go back to the Maestro.
 *
 * Legacy goals (no tasks) get the SAME OBJECT REFERENCE back — the
 * pre-T1 code path is preserved byte-for-byte, provable by identity.
 *
 * The spread carries ownerConversationId/skills/workingDirectory/etc.
 * untouched (the App.tsx evaluateGoal delegate resolves the owner
 * conversation from the object it receives — G-C8-FIX), and the extra
 * batch keys cross harmlessly: serde ignores unknown keys inside
 * GoalEvaluationInput (same argument as G-C17's evaluatorInputTokens).
 */
export function buildEvaluatorSnapshot(goal: GoalState): GoalState {
  const task = currentGoalTask(goal)
  if (!task) return goal
  return {
    ...goal,
    objective: task.text,
    turnsRun: goal.turnsRunThisTask ?? 0,
  }
}

/**
 * T1/T2: advance the batch at a task boundary. The finished task is
 * stamped with `outcome` (+completedAt), the next one `active`
 * (+startedAt — opens its D1 evidence window), everything else
 * untouched. Pure: the caller (goalScheduler) resets
 * taskIndex/turnsRunThisTask on the goal.
 *
 * T2: `outcome` is 'done' for the D1 pass (row 1, the default), and
 * 'failed' for the loop kill (row 8) — a failed task still advances the
 * batch so one stuck task does not drag nineteen with it.
 */
export function advanceGoalTasks(
  tasks: GoalTask[],
  doneIndex: number,
  now: number,
  outcome: GoalTask['status'] = 'done',
  // T4: per-task evidence for the final report (turns / evidenceCount /
  // failureReason), merged into the OUTGOING task's stamp only. The next
  // task's activation stamp is never touched.
  outcomeExtra?: Partial<GoalTask>,
): GoalTask[] {
  return tasks.map((task, index) =>
    index === doneIndex
      ? { ...task, status: outcome, completedAt: now, ...outcomeExtra }
      : index === doneIndex + 1
        ? { ...task, status: 'active' as GoalTask['status'], startedAt: now }
        : task,
  )
}

/**
 * T2 (row 12): the USER skips a blocked task. Pure transition —
 * the UI (T4) collects the click and the App restarts the cycle.
 *
 *   task:      blocked → skipped (+completedAt), NEVER failed — skip is
 *              a human decision, distinct from a systemic diagnosis.
 *   batch:     back to 'active' (clears pausedAt/pauseReason), advances
 *              to i+1 with turnsRunThisTask reset — or to 'completed'
 *              when the skipped task was the LAST one (row 13: the last
 *              task reached a terminal state).
 *   K guard:   TRANSPARENT — consecutiveFailedTasks is carried over
 *              untouched. Counting skips toward K would fire the guard
 *              on human intent instead of system health — and whoever
 *              is skipping is already present, so pausing to tell them
 *              is redundant noise (Maestro's rationale). Resetting on
 *              skip would equally lie: two loop failures with a skip
 *              between them are still consecutive failures.
 *   T3b:       the advance is a TASK BOUNDARY, so it owes the next task
 *              a compaction frontier — but this transition runs OUTSIDE
 *              the goal cycle, where the frontier protocol (fire,
 *              AWAIT, then reset) cannot execute. It therefore stamps
 *              `pendingCompaction: true` (only when there IS a next
 *              task) and the next runGoalCycle start settles the debt.
 *   T3b COALESCENCE (Maestro's call): the debt is NOT stamped when the
 *              skipped task ran ZERO turns — with no turns, nothing was
 *              added to the context since the last compaction, and
 *              compacting would spend 25-50s compressing exactly the
 *              same content (the user's original complaint is time
 *              wasted in the dumb zone; a useless compaction is
 *              literally that). The skip is DECLARED via `onLog` —
 *              skipping silently would be the defect class this whole
 *              cycle worked to eliminate.
 *
 * `onLog` is optional and only invoked for the DECLARED coalescence
 * skip; the T4/App wiring should pass the goal log channel. Pure with
 * respect to the returned state either way.
 *
 * `onBatchComplete` (D-B) is optional and invoked ONLY when this skip
 * completes the batch (the skipped task was the last one) — receiving
 * the SAME completed state the function returns. The skip advance runs
 * OUTSIDE the goal cycle, so the scheduler's onComplete is out of reach
 * from here; without this notification the batch ended with no final
 * report (the D-B defect: no per-task evidence, no elapsed time, no
 * tokens on screen). The caller wires the report stamper — the
 * transition itself stays pure in its return value.
 *
 * No-op (same reference back) when the current task is not 'blocked' —
 * skipping a running/done/failed task is not a legal transition.
 */
export function skipBlockedGoalTask(
  goal: GoalState,
  now: number,
  onLog?: (message: string) => void,
  onBatchComplete?: (completedGoal: GoalState) => void,
): GoalState {
  const tasks = goal.tasks
  const task = currentGoalTask(goal)
  if (!tasks || tasks.length === 0 || !task || task.status !== 'blocked') return goal
  const taskIndex = Math.min(goal.taskIndex ?? 0, tasks.length - 1)
  const isLastTask = taskIndex >= tasks.length - 1
  const turnsThisTask = goal.turnsRunThisTask ?? 0
  // T3b coalescence: a zero-turn task owes NO frontier — nothing new to
  // compact. Declared, never silent.
  const owesFrontier = !isLastTask && turnsThisTask > 0
  if (!isLastTask && !owesFrontier) {
    onLog?.(
      `Frontier: skipping compaction — skipped task ${taskIndex + 1}/${tasks.length} ran 0 turns; ` +
      `nothing new was added to the context since the last compaction.`,
    )
  }
  const next: GoalState = {
    ...goal,
    // T4: the skipped task carries its turn count into the report —
    // "skipped by you" is the conclusion, the turns are the context.
    tasks: advanceGoalTasks(tasks, taskIndex, now, 'skipped', { turns: turnsThisTask }),
    taskIndex: taskIndex + 1,
    turnsRunThisTask: 0,
    // K TRANSPARENT: consecutiveFailedTasks deliberately NOT mentioned.
    // T3b: frontier owed to the next task (cleared by the cycle start);
    // NOT stamped when the batch just completed — no next task exists —
    // nor when the skipped task ran zero turns (coalescence, above).
    ...(owesFrontier ? { pendingCompaction: true } : {}),
    ...(isLastTask
      ? { status: 'completed' as GoalState['status'], completedAt: now, pausedAt: undefined, pauseReason: undefined }
      : { status: 'active' as GoalState['status'], pausedAt: undefined, pauseReason: undefined }),
    updatedAt: now,
  }
  // D-B: the terminal skip completes the batch — notify so the final
  // report fires on this path too.
  if (isLastTask) onBatchComplete?.(next)
  return next
}

/**
 * T3: RE-OPEN the active task's D1 evidence window at the END of the
 * compaction frontier.
 *
 * Why this exists: the boundary advance (advanceGoalTasks) stamps the
 * next task's `startedAt` BEFORE the compact turn runs. Without a
 * re-stamp, the compact turn's own activities would fall INSIDE the new
 * task's evidence window (timestamp >= startedAt) — and any whitelisted
 * kind emitted by the CLI during /compact would count as "action
 * evidence" for a task that has not run a single turn of its own. The
 * compact turn alone must NEVER satisfy the next task's D1 guard
 * (Maestro's protocol; CADINHO's explicit condition), so the window is
 * re-opened AFTER the compact concludes: everything the compact turn
 * did lands before the new `startedAt` and is excluded by
 * countActionActivities' `timestamp < windowStart` skip.
 *
 * Only the task at `activeIndex` with status 'active' is re-stamped —
 * done/failed/skipped tasks keep their history, and a missing/absent
 * active task makes this a no-op map (defensive: same clamp discipline
 * as currentGoalTask).
 */
export function reopenTaskEvidenceWindow(
  tasks: GoalTask[],
  activeIndex: number,
  now: number,
): GoalTask[] {
  return tasks.map((task, index) =>
    index === activeIndex && task.status === 'active'
      ? { ...task, startedAt: now }
      : task,
  )
}

/**
 * T1 (c) — D1 ACTION WHITELIST. The activity kinds that COUNT as an
 * observable action for the task-evidence guard.
 *
 * Evidence, pasted from the REAL type (src/shared/types.ts:240-241 —
 * verified, not assumed; the originally drafted criterion
 * `kind === 'tool-result'` targeted a shape that does NOT exist in
 * TranscriptItem — there is NO 'tool-result' kind):
 *
 *   kind?: 'message' | 'activity' | 'summary'
 *   activityKind?: 'thinking' | 'image' | 'video' | 'read' | 'edit' |
 *     'search' | 'command' | 'terminal' | 'permission' | 'subagent' |
 *     'queued' | 'context' | 'tool' | 'compacting'
 *   toolOutput?: string
 *
 * COUNT as action:      edit, command, terminal, read, search, tool,
 *                       subagent.
 * DO NOT count:         thinking, queued, context, compacting,
 *                       permission, image, video.
 *
 * The whitelist is MANDATORY (not "any activity") because activityKind
 * includes `thinking` — if thinking counted, PENSAR would count as
 * AGIR and the guard would be born useless against the exact failure
 * mode it exists to catch (an agent completing a task by prose).
 */
export const ACTION_ACTIVITY_KINDS = [
  'edit',
  'command',
  'terminal',
  'read',
  'search',
  'tool',
  'subagent',
] as const satisfies readonly NonNullable<TranscriptItem['activityKind']>[]

/**
 * T1 (c): count the whitelisted action activities inside a task's
 * evidence window (`windowStart` = the task's startedAt; items at the
 * exact boundary millisecond count, `>=`).
 *
 * DECLARED LIMIT (h): this guard proves the PRESENCE of an action, NOT
 * the CORRECTNESS of the action — an edit that wrote garbage passes.
 * Do not read a green D1 check as proof the work is right; that is the
 * evaluator's job, not the guard's. (Same lesson as the seven Windows
 * defects: a test that proves FORM must never be read as proving
 * COMPILATION — so this limit is written down where the check lives.)
 */
export function countActionActivities(items: TranscriptItem[], windowStart = 0): number {
  let count = 0
  for (const item of items) {
    if (item.activityKind === undefined) continue
    if (item.timestamp < windowStart) continue
    if ((ACTION_ACTIVITY_KINDS as readonly string[]).includes(item.activityKind)) count++
  }
  return count
}
