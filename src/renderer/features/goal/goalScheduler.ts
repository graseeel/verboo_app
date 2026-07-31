import type { GoalEvaluationResult, GoalState, GoalTask, TranscriptItem } from '../../../shared/types'
import type { GoalStatusBarState } from './GoalStatusBar'
import type { Translator } from '../../i18n'
import { buildContinuePrompt, buildCompletionMessage, buildUsageSummary } from './goalPrompt'
import { isInfraError } from './goalReason'
import { advanceGoalTasks, buildEvaluatorSnapshot, countActionActivities, currentGoalTask, reopenTaskEvidenceWindow } from './goalState'

/**
 * Maximum consecutive evaluator failures before the scheduler pauses the
 * goal with `pauseReason: 'infra_error'`. Prevents burning budget on a
 * broken evaluator (CLI timeout, parse error, network).
 */
export const MAX_EVALUATION_ERRORS = 3

/**
 * Number of consecutive identical fingerprints required to flag a loop.
 * Kept as a named constant so the threshold is visible at the detection
 * site — do NOT change without explicit Maestro sign-off.
 */
export const LOOP_FINGERPRINT_THRESHOLD = 3

/**
 * T1 (e): fingerprint pushed into the ring when the D1 guard REJECTS a
 * `complete` decision (task tried to complete by prose). Deterministic
 * per task — NOT computed from the evaluation's free text — so an agent
 * that insists produces IDENTICAL entries, climbs noProgressCount, and
 * dies by the loop detector that already exists (threshold ~3). No new
 * mechanism: the rejected evaluation is DOWNGRADED to a continue and
 * this marker is what feeds the ring.
 */
const D1_REJECTED_FINGERPRINT_PREFIX = 'd1:complete-rejected-no-evidence:task'

/**
 * T2 (row 9) — the K guard: how many CONSECUTIVE failed tasks pause the
 * whole batch with pauseReason 'batchStagnation'. K = 2.
 *
 * K exists to detect a SYSTEMIC ENVIRONMENT problem — auth dropped,
 * disk full, CLI broken — not to judge individual tasks. Why 2 and not
 * more (Maestro's call, recorded verbatim): pausing is NOT cancelling —
 * the batch is resumable — so erring on the pause side costs one click,
 * while erring on the other side costs the whole batch grinding on with
 * a broken environment. With costs this asymmetric, the low number wins.
 *
 * What BYPASSES K (pauses on the FIRST occurrence): unsafe (row 5) and
 * infraError at max (row 7) — both already ARE systemic diagnoses, so
 * waiting for a second strike would ignore information we already have.
 * What NEVER feeds K: a user SKIP (row 12) — see GoalTask status docs.
 */
export const BATCH_STAGNATION_K = 2

/** Backoff cap: max wait between transient-error retries (8 s). */
const MAX_RETRY_DELAY_MS = 8_000

/** Base delay for transient-error retry backoff (1 s). */
const BASE_RETRY_DELAY_MS = 1_000

/** Shortest interval we bother logging in retry (rounded up). */
const MIN_LOG_INTERVAL_MS = 1_000

/**
 * Cap on the `recentFingerprints` ring. We only ever compare the last 3
 * entries (see `detectLoop`), so keeping more is pure memory bloat.
 */
const FINGERPRINT_RING_CAP = 3

/**
 * Compose a stable fingerprint from a goal evaluation.
 *
 * What counts as PROGRESS: a turn counts as progress if its fingerprint
 * DIFFERS from the previous turn's fingerprint. Two adjacent turns with
 * the same fingerprint did not add structural information — the agent is
 * repeating itself.
 *
 * LIMITATION — textual, not semantic: this fingerprint is built from
 * stable fields of `GoalEvaluationResult` (decision + reasonId +
 * sessionSummary + gaps + nextAction) with whitespace normalized. Two
 * turns that failed for the same underlying reason but with a single
 * different word in `sessionSummary` will produce different fingerprints
 * and slip past this detector. True semantic loop detection is a
 * separate structural concern (G-C3/G-C4) and is NOT attempted here.
 * This detector catches the common case: the agent emits the same
 * evaluation verbatim (or whitespace-collapsed) turn after turn.
 */
function computeFingerprint(evaluation: GoalEvaluationResult): string {
  const raw = [
    evaluation.decision,
    evaluation.reasonId,
    evaluation.sessionSummary ?? '',
    evaluation.gaps.join('|'),
    evaluation.nextAction ?? '',
  ].join('\u0001')
  // Collapse runs of whitespace to a single space and trim. This makes
  // fingerprints robust to formatting noise (extra spaces, newlines)
  // while preserving content. NOT a semantic normalization.
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * Promise-based sleep. Not abortable by design — the while-loop at the
 * top of `runGoalCycle` checks `getGoal()?.status` on wake-up, so any
 * cancellation signalled during the sleep is caught at the next loop
 * entry. This avoids threading an AbortSignal through the delegate to
 * reach a single helper.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

export type GoalSchedulerDelegate = {
  getGoal: () => GoalState | undefined
  updateGoal: (update: ((prev: GoalState) => GoalState) | GoalState) => void
  /**
   * Run the evaluator. Returns the typed evaluation result on success.
   * On failure (CLI timeout, parse error, network), THROWS — the
   * scheduler counts consecutive errors and pauses the goal after
   * `MAX_EVALUATION_ERRORS`. Callers must NOT swallow errors into a
   * fake "continue" decision.
   */
  evaluateGoal: (goal: GoalState) => Promise<GoalEvaluationResult>
  continueGoal: (goal: GoalState, nextMessage: string) => Promise<string | undefined>
  /**
   * T3: the COMPACTION FRONTIER between batch tasks. Called ONLY on the
   * done-advance path (matrix row 1: a non-last task passed D1 and the
   * batch is moving to the next task). The implementation must:
   *   1. send the equivalent of the /compact command to the goal's
   *      OWNER conversation (the measured CLI behavior: slash commands
   *      are intercepted BEFORE the model — the "/nonexistent → Unknown
   *      skill in 9ms, zero API calls" control proves the agent cannot
   *      answer ABOUT the command instead of executing it);
   *   2. AWAIT the compaction turn's conclusion (resolve only when the
   *      turn's terminal event arrives) — the scheduler's reset NEVER
   *      happens before this promise settles;
   *   3. resolve true when the compaction concluded cleanly, false on
   *      any failure (no CLI session, turn error, abort, non-zero exit).
   *
   * The compaction turn goes through runTurn, NOT continueGoal — it
   * must NOT increment turnsRun/turnsRunThisTask (it is maintenance,
   * not task work). Its tokens are accumulated ONCE via the existing
   * G-C14 turnId dedupe in the App's result handler.
   *
   * OPTIONAL on purpose: when absent (unit tests, hosts without a CLI
   * session), the scheduler takes the ATOMIC T1/T2 boundary — a single
   * updateGoal with the advance — and no compaction is attempted.
   */
  compactOnTaskBoundary?: (goal: GoalState) => Promise<boolean>
  /**
   * T1 (D1): the LIVE transcript items of the goal's OWNER conversation
   * (same resolution as evaluateGoal: ownerConversationId, NOT whatever
   * the user is looking at — G-C8-FIX). The scheduler reads them only
   * inside the batch D1 guard to count whitelisted action activities in
   * the current task's window; legacy single-task goals never trigger
   * a call.
   *
   * REQUIRED, not optional: the evidence guard must never silently
   * no-op. A delegate that cannot provide the transcript would make
   * batch tasks unable to complete (fail-closed) with no visible cause
   * — a type error at the construction site is the honest failure.
   */
  getConversationItems: () => TranscriptItem[]
  abortTurn: () => void
  onStatusChange: (status: GoalStatusBarState) => void
  onLog: (message: string) => void
  /**
   * G-C13: called once when the evaluator decides `complete`. Receives
   * the final goal state (with tokens accumulated and completedAt
   * stamped) and the evaluator's structured result. The App.tsx
   * implementation appends a PERSISTENT transcript item to the owner
   * conversation with the formatted token count and elapsed time —
   * this is the user-facing surface for the usage summary, NOT
   * onLog (which goes to console.log and is invisible to the user).
   *
   * Why a dedicated callback (not just onLog): onLog is a debugging
   * channel. The completion summary needs to reach the rendered UI,
   * which requires a different code path (appendConversationItem).
   * Folding this into onLog would require the App.tsx onLog handler
   * to parse the message back into structured data — fragile and
   * exactly the "data produced, no consumer" pattern G-C13 fixes.
   *
   * D-B: `evaluation` is OPTIONAL since D-B — the batch can also
   * complete WITHOUT a fresh evaluation: a loop-kill on the LAST task
   * (row 13) and skipping the last task both reach 'completed' from a
   * state transition, and the report must fire there too (the user's
   * field-test complaint: no per-task evidence, no elapsed, no tokens).
   * Those paths pass the goal's lastEvaluation when one exists.
   */
  onComplete?: (goal: GoalState, evaluation?: GoalEvaluationResult) => void
  /** i18n translator for system messages emitted by the scheduler. */
  t: Translator
}

export type ScheduleResult = 'completed' | 'cancelled' | 'paused' | 'blocked' | 'error'

/**
 * T3/T3b: the COMPACTION FRONTIER protocol core — shared by all three
 * task-boundary kinds. T3 wired the done-advance (row 1); T3b (Maestro
 * ratification) extended to EVERY task boundary — done, loop-kill
 * (row 8, inline at the kill) and skip (row 12, settled at cycle start)
 * — because "start each task on a clean context" does not depend on how
 * the previous one ended, and a loop-killed task leaves the MOST
 * polluted context of the batch (several turns of repetition).
 *
 * MANDATORY ORDER (Maestro's protocol): the compact turn must CONCLUDE
 * before any frontier state is reset — the reset NEVER happens before
 * `compactOnTaskBoundary` settles. The reset then:
 *   - zeroes turnsRunThisTask (already zeroed by the advance write;
 *     restated so the protocol reads in one place);
 *   - clears the fingerprint ring + noProgressCount: a REAL compaction
 *     changed the transcript, so fingerprints computed against the
 *     pre-compact context are a stale baseline — keeping them would
 *     compare the next task's evaluations against a transcript that no
 *     longer exists;
 *   - RE-OPENS the new task's D1 evidence window (startedAt stamped
 *     NOW, post-compact): the advance had opened it BEFORE the compact
 *     turn ran, so without the re-stamp any whitelisted activity
 *     emitted by the CLI during /compact would count as action evidence
 *     for a task that never ran. The compact turn alone must NEVER
 *     satisfy the next task's D1 guard — on the loop path this matters
 *     even MORE, because the previous task FAILED.
 *
 * FAILURE: the batch PROCEEDS WITHOUT COMPACTING — never blocked by
 * it — but the failure is DECLARED (log + compactionFailures counter
 * for the T4 report), never hidden. On failure the ring is PRESERVED
 * on the done/skip paths (the transcript did not change, so the loop
 * detector's baseline stays valid — disarming it would strip
 * protection we still need) but CLEARED on the loop path
 * (`clearPoisonedRingOnFailure`): a ring that just killed a task holds
 * three IDENTICAL fingerprints, and preserving it would fail the next
 * task at the very next loop-top check without a single evaluation of
 * its own — the exact defect the T2 reset existed to prevent. The
 * evidence window is re-opened on both policies (a partial compact
 * turn may have emitted activities).
 *
 * SKIP PATH (`settlePendingCompaction`): the skip advance ran OUTSIDE
 * the cycle and left pendingCompaction: true; this frontier settles
 * the debt and clears the flag WHATEVER the outcome — a failed
 * frontier is declared and moved past, not retried on every resume.
 *
 * HONESTY LINE (required): this frontier only controls compaction at
 * the boundary. The REACTIVE context-overflow recovery that already
 * exists in App.tsx (~1877-1906 and ~1989-1996) can fire in the MIDDLE
 * of a task, outside our control; when it does, the loop detector is
 * disarmed BY NATURE — the transcript changed, so the evaluator's
 * output changes and fingerprints no longer compare. That cannot be
 * prevented honestly from here; the T2 K guard (batchStagnation) is
 * the net for that case. Do not read this frontier as control over
 * mid-task compaction.
 */
async function runTaskBoundaryFrontier(
  delegate: GoalSchedulerDelegate,
  goal: GoalState,
  options: {
    frontierIndex: number
    totalTasks: number
    clearPoisonedRingOnFailure: boolean
    settlePendingCompaction?: boolean
  },
): Promise<void> {
  const { frontierIndex, totalTasks } = options
  delegate.onLog(
    `Frontier: compacting context before task ${frontierIndex + 1}/${totalTasks}...`,
  )
  let compacted: boolean
  try {
    // Guaranteed present by every call site (all gate on the delegate's
    // optional field before calling).
    compacted = await delegate.compactOnTaskBoundary!(goal)
  } catch (error) {
    delegate.onLog(
      `Frontier: compaction threw (${error instanceof Error ? error.message : String(error)}); treating as failure.`,
    )
    compacted = false
  }
  const now = Date.now()
  if (compacted) {
    delegate.updateGoal((prev: GoalState) => ({
      ...prev,
      turnsRunThisTask: 0,
      recentFingerprints: [],
      noProgressCount: 0,
      tasks: reopenTaskEvidenceWindow(prev.tasks ?? [], prev.taskIndex ?? frontierIndex, now),
      ...(options.settlePendingCompaction ? { pendingCompaction: undefined } : {}),
    }))
    delegate.onLog(
      'Frontier: compaction concluded; ring, noProgressCount and turnsRunThisTask reset; evidence window reopened.',
    )
  } else {
    delegate.updateGoal((prev: GoalState) => ({
      ...prev,
      compactionFailures: (prev.compactionFailures ?? 0) + 1,
      turnsRunThisTask: 0,
      tasks: reopenTaskEvidenceWindow(prev.tasks ?? [], prev.taskIndex ?? frontierIndex, now),
      // Loop path: clear the PROVABLY POISONED ring even on failure (see
      // doc); done/skip paths: preserve the healthy ring (doc above).
      ...(options.clearPoisonedRingOnFailure
        ? { recentFingerprints: [], noProgressCount: 0 }
        : {}),
      ...(options.settlePendingCompaction ? { pendingCompaction: undefined } : {}),
    }))
    delegate.onLog(
      'Frontier: compaction FAILED; the batch proceeds WITHOUT compacting ' +
      '(declared — compactionFailures incremented). ' +
      (options.clearPoisonedRingOnFailure
        ? 'Poisoned loop ring cleared anyway — it would kill the next task unread.'
        : 'Ring and noProgressCount preserved.'),
    )
  }
}

export async function runGoalCycle(delegate: GoalSchedulerDelegate): Promise<ScheduleResult> {
  const goal = delegate.getGoal()
  if (!goal) return 'cancelled'

  // T2 (row 4) resume normalization: a task left 'blocked' by a
  // needsUser pause returns to 'active' when the cycle (re)starts —
  // 'blocked' only exists while the batch waits for the user. Initial
  // starts never have a blocked current task, so this only fires on
  // resume.
  const startTask = currentGoalTask(goal)
  if (goal.tasks?.length && startTask?.status === 'blocked') {
    delegate.updateGoal((prev: GoalState) => ({
      ...prev,
      tasks: prev.tasks?.map(task =>
        task.id === startTask.id ? { ...task, status: 'active' as GoalTask['status'] } : task,
      ),
    }))
    delegate.onLog('Resumed batch: blocked task back to active.')
  }

  // T3b (row 12 frontier): a SKIP advance happens OUTSIDE the cycle —
  // skipBlockedGoalTask is a pure transition collected by the UI (T4) —
  // so it could not run the frontier inline and stamped
  // pendingCompaction: true instead. Settle the debt BEFORE the first
  // evaluation, with the exact T3 protocol (fire, AWAIT, then reset):
  // the task starts on a clean context and the compact turn never
  // counts as its action evidence (the helper re-opens the D1 window
  // post-compact). The flag is cleared WHATEVER the outcome — a failed
  // frontier is declared and moved past, not retried on every resume
  // (idempotent). Without a wired delegate the flag stays inert and
  // nothing fires (T2 tests, hosts without a CLI session).
  const pendingGoal = delegate.getGoal()
  if (pendingGoal?.pendingCompaction && delegate.compactOnTaskBoundary) {
    const pendingTasks = pendingGoal.tasks ?? []
    await runTaskBoundaryFrontier(delegate, pendingGoal, {
      frontierIndex: Math.min(pendingGoal.taskIndex ?? 0, Math.max(pendingTasks.length - 1, 0)),
      totalTasks: pendingTasks.length,
      clearPoisonedRingOnFailure: false,
      settlePendingCompaction: true,
    })
  }

  delegate.onStatusChange({ kind: 'active', objective: goal.objective, turn: goal.turnsRun })

  while (true) {
    const currentGoal = delegate.getGoal()
    if (!currentGoal) {
      delegate.onLog('Goal was cleared during cycle.')
      return 'cancelled'
    }

    if (currentGoal.status === 'paused' || currentGoal.status === 'cancelled') {
      delegate.onLog(`Goal paused or cancelled during cycle.`)
      return 'cancelled'
    }

    // No budget enforcement — tokens and time are unlimited in Verboo.
    // T2 (rows 8/9/13): loop detection on a BATCH fails only the current
    // task and the batch stays ACTIVE and advances — one stuck task
    // does not drag nineteen with it. On a LEGACY goal the pre-T2
    // behavior stands: the whole goal is blocked.
    if (detectLoop(currentGoal)) {
      const loopTasks = currentGoal.tasks
      const loopTask = currentGoalTask(currentGoal)
      if (loopTasks?.length && loopTask) {
        const loopTaskIndex = Math.min(currentGoal.taskIndex ?? 0, loopTasks.length - 1)
        const consecutiveFailed = (currentGoal.consecutiveFailedTasks ?? 0) + 1
        const isLastTask = loopTaskIndex >= loopTasks.length - 1
        const now = Date.now()
        // T4: captured ONCE here so every loop write below can stamp the
        // per-task evidence (failureReason 'loop' + the turns the task
        // ran) — and reused by the T3b coalescence gate further down.
        const loopTurnsThisTask = currentGoal.turnsRunThisTask ?? 0

        if (isLastTask) {
          // T2 (row 13): the LAST task reached a terminal state → the
          // batch is done. Row 13 BEATS the K guard: with no tasks left
          // there is nothing to pause FOR. The batch completes with its
          // failures recorded per task (the T4 report distinguishes).
          delegate.updateGoal((prev: GoalState) => ({
            ...prev,
            tasks: prev.tasks?.map((task, index) =>
              index === loopTaskIndex
                ? {
                    ...task,
                    status: 'failed' as GoalTask['status'],
                    completedAt: now,
                    // T4: evidence for the final report — WHY it failed.
                    failureReason: 'loop' as const,
                    turns: loopTurnsThisTask,
                  }
                : task,
            ),
            consecutiveFailedTasks: consecutiveFailed,
            recentFingerprints: [],
            noProgressCount: 0,
            status: 'completed',
            completedAt: now,
          }))
          delegate.onStatusChange({ kind: 'completed', objective: currentGoal.objective })
          delegate.onLog(
            `Loop detected on last task ${loopTaskIndex + 1}/${loopTasks.length}; task failed, batch completed.`,
          )
          // D-B: this path completed the batch WITHOUT onComplete — no
          // per-task report, no elapsed time, no tokens on screen (the
          // user's field-test complaint). Fire it now, with the goal
          // built LOCALLY (G-C13 lesson: updateGoal's setGoal updater
          // does not run synchronously, so delegate.getGoal() cannot be
          // trusted to carry completedAt here). No evaluator-token
          // overlay: no evaluation ran since the loop-top snapshot, so
          // currentGoal already carries every accumulated parcel. The
          // evaluation passed is the last one the goal saw — loops are
          // detected FROM evaluations, so it exists on this path.
          delegate.onComplete?.(
            {
              ...currentGoal,
              tasks: currentGoal.tasks?.map((task, index) =>
                index === loopTaskIndex
                  ? {
                      ...task,
                      status: 'failed' as GoalTask['status'],
                      completedAt: now,
                      failureReason: 'loop' as const,
                      turns: loopTurnsThisTask,
                    }
                  : task,
              ),
              consecutiveFailedTasks: consecutiveFailed,
              recentFingerprints: [],
              noProgressCount: 0,
              status: 'completed',
              completedAt: now,
            },
            currentGoal.lastEvaluation,
          )
          return 'completed'
        }

        if (consecutiveFailed >= BATCH_STAGNATION_K) {
          // T2 (row 9): K consecutive task failures = systemic
          // environment problem (auth dropped, disk full, CLI broken).
          // Pause — NOT cancel: the batch is resumable. The pointer is
          // advanced past the failed task so a resume continues with
          // the next one; the failed tasks stay failed for the T4
          // report. pauseReason 'batchStagnation' is a plain String in
          // Rust, so it crosses serde freely — NOTHING changes in
          // src-tauri (the i18n key is T4's; here only the value).
          delegate.updateGoal((prev: GoalState) => ({
            ...prev,
            tasks: advanceGoalTasks(prev.tasks ?? [], loopTaskIndex, now, 'failed', {
              // T4: evidence for the final report — WHY it failed.
              failureReason: 'loop',
              turns: loopTurnsThisTask,
            }),
            taskIndex: loopTaskIndex + 1,
            turnsRunThisTask: 0,
            consecutiveFailedTasks: consecutiveFailed,
            recentFingerprints: [],
            noProgressCount: 0,
            status: 'paused',
            pausedAt: now,
            pauseReason: 'batchStagnation',
          }))
          delegate.onStatusChange({ kind: 'stopped', objective: currentGoal.objective, reason: 'batchStagnation' })
          delegate.onLog(
            `Batch stagnation: ${consecutiveFailed} consecutive task failures (K=${BATCH_STAGNATION_K}). ` +
            `Task ${loopTaskIndex + 1} failed; batch paused before task ${loopTaskIndex + 2}.`,
          )
          return 'paused'
        }

        // T2 (row 8): task failed, batch STAYS ACTIVE, advance to i+1.
        // T3b (Maestro ratification): this advance is a TASK BOUNDARY,
        // so the compaction frontier fires here too — a loop-killed task
        // produced several turns of repetition, the MOST polluted
        // context in the batch; carrying it into the next task is the
        // user's original complaint ("tempo demais na zona burra"). The
        // report loses no diagnosis: it is built from goal state (per-
        // task status/reason), and the CLI compaction keeps a summary.
        // T3b COALESCENCE (Maestro's call): skip the frontier when the
        // task that is LEAVING ran ZERO turns — with no turns, nothing
        // was added to the context since the last compaction, so
        // compacting would spend 25-50s compressing exactly the same
        // content (the user's original complaint IS time wasted in the
        // dumb zone; a useless compaction is literally that). The skip
        // is DECLARED in the log — never silent.
        if (delegate.compactOnTaskBoundary && loopTurnsThisTask > 0) {
          // SPLIT WRITE (the T3 atomic-advance solution, applied to the
          // kill): the kill/advance lands FIRST — the poisoned ring
          // survives until the compact settles, which is safe because
          // NOTHING reads it while the cycle is suspended at the await —
          // and the frontier reset comes AFTER, per the mandatory
          // order. clearPoisonedRingOnFailure: this ring is provably
          // toxic (three identical fingerprints), so it is cleared even
          // when the compaction fails — see runTaskBoundaryFrontier.
          delegate.updateGoal((prev: GoalState) => ({
            ...prev,
            tasks: advanceGoalTasks(prev.tasks ?? [], loopTaskIndex, now, 'failed', {
              // T4: evidence for the final report — WHY it failed.
              failureReason: 'loop',
              turns: loopTurnsThisTask,
            }),
            taskIndex: loopTaskIndex + 1,
            turnsRunThisTask: 0,
            consecutiveFailedTasks: consecutiveFailed,
          }))
          delegate.onLog(
            `Loop detected on task ${loopTaskIndex + 1}/${loopTasks.length}; task marked failed, ` +
            `batch continues with task ${loopTaskIndex + 2}.`,
          )
          await runTaskBoundaryFrontier(delegate, currentGoal, {
            frontierIndex: loopTaskIndex + 1,
            totalTasks: loopTasks.length,
            clearPoisonedRingOnFailure: true,
          })
        } else {
          // Legacy atomic kill: advance + reset in ONE write, the exact
          // T2 behavior. The ring and noProgressCount are RESET so the
          // next task does not inherit this task's poisoned fingerprints
          // (an inherited ring would fail the next task at the very next
          // loop-top check without a single evaluation of its own). The
          // ring cleanup is needed in BOTH sub-cases below — poisoned is
          // poisoned, compacted or not.
          // Two sub-cases land here: (a) NO frontier wired (T2 unit
          // tests, hosts without a CLI session) — nothing to declare;
          // (b) frontier wired BUT the killed task ran ZERO turns — the
          // T3b coalescence skip, which MUST be declared in the log
          // (never silent).
          if (delegate.compactOnTaskBoundary) {
            delegate.onLog(
              `Frontier: skipping compaction — task ${loopTaskIndex + 1}/${loopTasks.length} ran 0 turns; ` +
              `nothing new was added to the context since the last compaction.`,
            )
          }
          delegate.updateGoal((prev: GoalState) => ({
            ...prev,
            tasks: advanceGoalTasks(prev.tasks ?? [], loopTaskIndex, now, 'failed', {
              // T4: evidence for the final report — WHY it failed.
              failureReason: 'loop',
              turns: loopTurnsThisTask,
            }),
            taskIndex: loopTaskIndex + 1,
            turnsRunThisTask: 0,
            consecutiveFailedTasks: consecutiveFailed,
            recentFingerprints: [],
            noProgressCount: 0,
          }))
          delegate.onLog(
            `Loop detected on task ${loopTaskIndex + 1}/${loopTasks.length}; task marked failed, ` +
            `batch continues with task ${loopTaskIndex + 2}.`,
          )
        }
        continue
      }

      delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'blocked' }))
      delegate.onStatusChange({ kind: 'stopped', objective: currentGoal.objective, reason: 'loop' })
      delegate.onLog('Loop detected: identical output fingerprints.')
      return 'blocked'
    }

    delegate.onLog(`Evaluating goal progress (turn ${currentGoal.turnsRun})...`)
    // T4: the batch progress rides the status change so the App can
    // stamp "Tarefa k de N" on the latest turn's summary item — computed
    // from the FRESH loop-top snapshot (a goalRef read could lag one
    // cycle right after a boundary write; this snapshot never does).
    const batchProgress = currentGoal.tasks?.length
      ? {
          current: Math.min((currentGoal.taskIndex ?? 0) + 1, currentGoal.tasks.length),
          total: currentGoal.tasks.length,
        }
      : undefined
    delegate.onStatusChange({
      kind: 'evaluating',
      objective: currentGoal.objective,
      turn: currentGoal.turnsRun,
      ...(batchProgress ? { batchProgress } : {}),
    })
    delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'evaluating' }))

    let evaluation: GoalEvaluationResult
    try {
      // T1 (b) THE SNAPSHOT TRICK: for batch goals the evaluator receives
      // a snapshot whose objective is the CURRENT task's text and whose
      // turnsRun is turnsRunThisTask — the stateless Rust evaluator then
      // guards and prompts PER TASK without knowing a batch exists.
      // Legacy goals pass through with the same object reference.
      evaluation = await delegate.evaluateGoal(buildEvaluatorSnapshot(currentGoal))
    } catch (err) {
      const errorCount = (currentGoal.errorCount ?? 0) + 1
      const message = err instanceof Error ? err.message : String(err)
      delegate.onLog(`Evaluator error #${errorCount}: ${message}`)

      if (errorCount >= MAX_EVALUATION_ERRORS) {
        // G-C6-FIX-UI: synthesize a lastEvaluation carrying the error
        // message so the panel can render it via goal.errorPausedBody.
        // Without this, the message lived only in onLog and the user
        // saw the generic "Erro de infraestrutura do avaliador".
        const syntheticEvaluation: GoalEvaluationResult = {
          decision: 'pause',
          reasonId: 'infraError',
          reason: message,
          gaps: [],
          confidence: 0,
        }
        // T2 (row 7): infraError AT MAX pauses the batch (existing
        // behavior — untouched) and marks the current task 'failed'.
        // This path BYPASSES the K guard: a broken evaluator is already
        // a systemic diagnosis — waiting for a second failed task would
        // ignore information we already have.
        delegate.updateGoal((prev: GoalState) => ({
          ...prev,
          status: 'paused',
          pausedAt: Date.now(),
          pauseReason: 'infraError',
          errorCount,
          lastEvaluation: syntheticEvaluation,
          ...stampCurrentTask(prev, 'failed', {
            // T4: evidence for the final report — WHY it failed.
            failureReason: 'infraError',
            turns: currentGoal.turnsRunThisTask ?? 0,
          }),
        }))
        delegate.onStatusChange({
          kind: 'stopped',
          objective: currentGoal.objective,
          reason: 'infraError',
        })
        delegate.onLog(delegate.t('goal.errorPausedTitle', { count: errorCount }) + ': ' + message)
        return 'paused'
      }

      // Transient error — backoff before retry so the user sees the
      // retry progressing instead of a free-spin loop. Backoff formula:
      //   delay = min(BASE_RETRY_DELAY_MS * 2^(errorCount-1), MAX_RETRY_DELAY_MS)
      // Progressão: 1s → 2s → 4s → 8s (cap). Starts at 1 s to avoid
      // hammering the CLI on the first transient glitch; the 8 s cap
      // bounds worst-case wait to 15 s total before infra pause.
      // Chosen because exponential backoff with cap is the standard
      // transient-fault pattern — doubles fast enough to clear a
      // congested resource, cap prevents unbounded wait.
      delegate.updateGoal((prev: GoalState) => ({ ...prev, errorCount }))
      const delay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, errorCount - 1), MAX_RETRY_DELAY_MS)
      const seconds = Math.ceil(delay / MIN_LOG_INTERVAL_MS)
      delegate.onLog(delegate.t('goal.errorRetryingTitle', { count: errorCount, seconds }))
      delegate.onLog(delegate.t('goal.errorRetryingBody', { message }))
      await sleep(delay)
      continue
    }

    // Successful evaluation — reset error counter.
    if ((currentGoal.errorCount ?? 0) > 0) {
      delegate.updateGoal((prev: GoalState) => ({ ...prev, errorCount: 0 }))
    }

    // ── T1: batch bookkeeping + D1 action-evidence guard ─────────────
    // Runs ONLY for batch goals (tasks?.length > 0); legacy single-task
    // goals skip every branch below and keep the pre-T1 behavior
    // byte-for-byte (aceite 4).
    //
    // (d) A task becomes done ONLY when ALL THREE hold:
    //       1. evaluation.decision === 'complete'
    //       2. turnsRunThisTask > 0
    //       3. >= 1 whitelisted action activity in the task's window
    //          (waived ONLY for tasks declared toolless at creation).
    // (e) A `complete` WITHOUT evidence is NOT a failure and NOT a
    //     completion: it becomes NO-PROGRESS — the evaluation is
    //     DOWNGRADED to a continue, the task keeps running, and a
    //     deterministic fingerprint feeds the ring (see
    //     D1_REJECTED_FINGERPRINT_PREFIX): insist and die by the loop
    //     detector that already exists.
    let effectiveEvaluation = evaluation
    let fingerprint: string
    let advancedTaskText: string | undefined
    let completedTaskIndex: number | undefined
    // Set when a NON-LAST task passed D1 and the batch advanced: the
    // completion path must NOT fire (decision stays 'complete' — the
    // TASK completed, the GOAL has not). Without this gate the whole
    // goal completes at the first task boundary.
    let didAdvance = false
    // T3b COALESCENCE: the leaving task's turn count, captured BEFORE the
    // advance write resets turnsRunThisTask to 0 — the frontier gate
    // below reads it after the reset, so it cannot re-read the field.
    let turnsThisTaskBeforeAdvance: number | undefined
    // T4: the completed task's evidence, captured at the D1 pass so the
    // final report can CITE it (turns + whitelisted actions). Used by
    // BOTH the advance write (non-last task) and the terminal
    // completion stamp (last task). undefined evidenceCount = toolless
    // waiver (the report says "toolless" instead of citing actions).
    let completedTaskTurns: number | undefined
    let completedTaskEvidence: number | undefined
    const batchTasks = currentGoal.tasks
    const activeTask = currentGoalTask(currentGoal)
    const taskIndex = currentGoal.taskIndex ?? 0
    const clampedTaskIndex = batchTasks?.length ? Math.min(taskIndex, batchTasks.length - 1) : 0
    if (evaluation.decision === 'complete' && batchTasks && batchTasks.length > 0 && activeTask) {
      const turnsThisTask = currentGoal.turnsRunThisTask ?? 0
      const windowStart = activeTask.startedAt ?? currentGoal.startedAt ?? 0
      const evidenceCount = countActionActivities(delegate.getConversationItems(), windowStart)
      const turnsOk = turnsThisTask > 0
      const evidenceOk = activeTask.toolless === true || evidenceCount > 0
      if (!turnsOk || !evidenceOk) {
        // D1 REJECTION. DECLARED LIMIT (h): the guard proves PRESENCE
        // of action, NOT CORRECTNESS — an edit that wrote garbage would
        // have passed; what it refuses is completion with NO observable
        // action at all (the turnsRun-zero incident class).
        effectiveEvaluation = {
          ...evaluation,
          decision: 'continue',
          reasonId: 'taskIncomplete',
          reason:
            `Completion rejected by the action-evidence guard: the task was ` +
            `declared complete with turns run this task = ${turnsThisTask} and ` +
            `whitelisted action activities in the task window = ${activeTask.toolless === true ? 'waived (toolless task)' : evidenceCount}. ` +
            `Perform the work with real tool actions before declaring completion.`,
        }
        fingerprint = `${D1_REJECTED_FINGERPRINT_PREFIX}:${clampedTaskIndex}`
        delegate.onLog(
          `D1 guard rejected completion of task ${clampedTaskIndex + 1}/${batchTasks.length} ` +
          `(turnsThisTask=${turnsThisTask}, evidence=${activeTask.toolless === true ? 'waived' : evidenceCount}). Downgraded to continue.`,
        )
      } else {
        fingerprint = computeFingerprint(evaluation)
        completedTaskIndex = clampedTaskIndex
        // T4: capture the evidence NOW — the D1 block's turnsThisTask /
        // evidenceCount go out of scope before the completion write.
        completedTaskTurns = turnsThisTask
        completedTaskEvidence = activeTask.toolless === true ? undefined : evidenceCount
        if (clampedTaskIndex < batchTasks.length - 1) {
          // Non-last task done → advance the batch IN PLACE: same goal
          // record, ownerConversationId UNTOUCHED (POSSE, not freshness),
          // turnsRunThisTask reset at the boundary (aceite 2).
          // T2 (row 9): a done RESETS the K guard — only CONSECUTIVE
          // failures count.
          const now = Date.now()
          advancedTaskText = batchTasks[clampedTaskIndex + 1].text
          didAdvance = true
          turnsThisTaskBeforeAdvance = turnsThisTask
          delegate.updateGoal((prev: GoalState) => ({
            ...prev,
            // T4: the completed task carries its evidence into the
            // final report (turns always; actions unless toolless).
            tasks: advanceGoalTasks(prev.tasks ?? [], clampedTaskIndex, now, 'done', {
              turns: turnsThisTask,
              ...(completedTaskEvidence !== undefined ? { evidenceCount: completedTaskEvidence } : {}),
            }),
            taskIndex: clampedTaskIndex + 1,
            turnsRunThisTask: 0,
            consecutiveFailedTasks: 0,
          }))
          delegate.onLog(
            `Task ${clampedTaskIndex + 1}/${batchTasks.length} done; advancing to task ${clampedTaskIndex + 2}. turnsRunThisTask reset to 0.`,
          )
        }
      }
    } else {
      fingerprint = computeFingerprint(evaluation)
    }

    // Persist the evaluation on the goal for UI hydration. T1: persists
    // the EFFECTIVE evaluation — a D1-rejected completion is stored as
    // the downgraded continue, so the panel never displays "complete"
    // for a task that kept running.
    delegate.updateGoal((prev: GoalState) => ({ ...prev, lastEvaluation: effectiveEvaluation }))

    // Update loop-detection state. The fingerprint is computed from the
    // evaluation we just received (or the deterministic D1 marker when
    // the guard rejected a completion); if it matches the previous
    // turn's fingerprint, the agent is repeating itself and
    // noProgressCount increments. Otherwise it resets — a structural
    // change means the agent is making progress even if the decision is
    // still 'continue'. See `computeFingerprint` for the
    // textual-vs-semantic limitation.
    delegate.updateGoal((prev: GoalState) => {
      const prevFp = prev.recentFingerprints.at(-1)
      const isRepeat = prevFp !== undefined && fingerprint === prevFp
      const nextNoProgress = isRepeat ? prev.noProgressCount + 1 : 0
      const nextRing = [...prev.recentFingerprints, fingerprint].slice(-FINGERPRINT_RING_CAP)
      return { ...prev, recentFingerprints: nextRing, noProgressCount: nextNoProgress }
    })

    // ─── T3/T3b: COMPACTION FRONTIER (compact at EVERY task boundary)
    // T3 wired this path (done-advance, row 1). T3b (Maestro
    // ratification): EVERY task boundary compacts — the loop-kill
    // advance (row 8) fires it inline at the kill, and the skip advance
    // (row 12) settles it at cycle start via pendingCompaction. What
    // still does NOT compact: the K-pause (row 9 — the batch stops for
    // the user, no next task starts) and a terminal LAST task (row
    // 13/done — nothing to compact for).
    // The protocol core (mandatory order, failure policy, honesty line)
    // lives in runTaskBoundaryFrontier — shared by all three kinds.
    if (didAdvance && delegate.compactOnTaskBoundary) {
      // T3b COALESCENCE (Maestro's call): skip when the task that is
      // LEAVING ran zero turns — nothing new entered the context since
      // the last compaction, so compacting would spend 25-50s on the
      // same content. DECLARED, never silent. NOTE: unreachable today —
      // the D1 guard requires turnsThisTask > 0 for a done-advance — but
      // the uniform rule ("every boundary compacts EXCEPT when there is
      // nothing new") is kept in one shape across the three paths so a
      // future D1 change cannot silently reintroduce a useless compact.
      if ((turnsThisTaskBeforeAdvance ?? 0) > 0) {
        await runTaskBoundaryFrontier(delegate, currentGoal, {
          frontierIndex: clampedTaskIndex + 1,
          totalTasks: batchTasks?.length ?? 0,
          clearPoisonedRingOnFailure: false,
        })
      } else {
        delegate.onLog(
          `Frontier: skipping compaction — task ${clampedTaskIndex + 1}/${batchTasks?.length ?? 0} ran 0 turns; ` +
          `nothing new was added to the context since the last compaction.`,
        )
      }
    }

    // The completion path fires ONLY when the goal itself is done: a
    // D1-downgraded completion arrives here as 'continue', and a batch
    // that just advanced to its next task must continue, not complete
    // (didAdvance gate — see the T1 block above).
    if (effectiveEvaluation.decision === 'complete' && !didAdvance) {
      const completionMessage = buildCompletionMessage(evaluation)
      // G-C10 item 3: stamp completedAt BEFORE building the usage
      // summary, so the elapsed time is computed from the real
      // completion instant. The updateGoal below writes the same
      // completedAt to the persisted goal; the local stamp is only
      // used to build the summary string for the log line.
      const completedAt = Date.now()
      // T1: in a batch, the LAST task also passed D1 — stamp it done in
      // the same write that completes the goal. Undefined for legacy
      // goals: the tasks key stays absent.
      const tasksCompleted =
        completedTaskIndex !== undefined && batchTasks
          ? batchTasks.map((task, index) =>
              index === completedTaskIndex
                ? {
                    ...task,
                    status: 'done' as GoalTask['status'],
                    completedAt,
                    // T4: the LAST task's evidence for the report (the
                    // earlier tasks were stamped at each advance write).
                    turns: completedTaskTurns ?? 0,
                    ...(completedTaskEvidence !== undefined
                      ? { evidenceCount: completedTaskEvidence }
                      : {}),
                  }
                : task,
            )
          : undefined
      const goalForSummary: GoalState = { ...currentGoal, completedAt }
      const usageSummary = buildUsageSummary(goalForSummary)
      delegate.updateGoal((prev: GoalState) => ({
        ...prev,
        status: 'completed',
        completedAt,
        lastEvaluation: evaluation,
        ...(tasksCompleted ? { tasks: tasksCompleted } : {}),
        // T2 (row 9): a done RESETS the K guard — including the terminal
        // done that completes the batch ("ZERA em qualquer done").
        ...(batchTasks?.length ? { consecutiveFailedTasks: 0 } : {}),
      }))
      delegate.onStatusChange({ kind: 'completed', objective: currentGoal.objective })
      // G-C13-FIX: build finalGoal LOCALLY from currentGoal + the
      // fields we just stamped, NOT via delegate.getGoal(). The
      // delegate's getGoal() reads goalRef.current, and updateGoal
      // above calls setGoal(updater) — React does NOT execute the
      // updater synchronously, so goalRef.current still lacks
      // completedAt when getGoal() runs on the next line. The
      // onComplete delegate in App.tsx gates the usage line on
      // `hasRealUsage = totalTokens > 0 && startedAt && completedAt`;
      // a missing completedAt silently drops the "Uso registrado" line
      // even when the goal accumulated real tokens. This is the 7th
      // ref/state desync defect of the cycle (G-C5/G-C8/G-C10 family).
      // The G-C5-FIX comment at App.tsx:3043 already documents the
      // armadilha ("setGoal's functional updater does NOT run
      // synchronously") — that lesson was not applied to this new
      // code path. Building finalGoal locally closes the defect at
      // the source: deterministic, no dependency on React's commit
      // timing, no extra callback on the delegate.
      //
      // G-C17 adendo: currentGoal is a loop-top snapshot taken BEFORE
      // this iteration's evaluateGoal ran, so it LACKS the evaluator
      // token parcel the delegate just accumulated. With last-write-
      // wins this only mattered in multi-evaluation goals; with G-C17
      // accumulation it would drop the FINAL evaluation's parcel from
      // the "Total registrado" line (a 1-turn goal would show ~115k
      // instead of ~150k). The evaluateGoal delegate syncs goalRef
      // SYNCHRONOUSLY (App.tsx, outside setGoal), so the live ref has
      // the fresh totals — overlay ONLY the two accumulator fields,
      // nothing else: completedAt/status/lastEvaluation are still
      // stamped locally below because updateGoal's setGoal updater does
      // not run synchronously and the live ref cannot be trusted for
      // them.
      const liveGoal = delegate.getGoal()
      const finalGoal: GoalState = {
        ...currentGoal,
        evaluatorInputTokens: liveGoal?.evaluatorInputTokens ?? currentGoal.evaluatorInputTokens,
        evaluatorOutputTokens: liveGoal?.evaluatorOutputTokens ?? currentGoal.evaluatorOutputTokens,
        status: 'completed',
        completedAt,
        lastEvaluation: evaluation,
        // T1: a completed batch carries ALL tasks done (the last one was
        // stamped above; the earlier ones were stamped at each advance).
        ...(tasksCompleted ? { tasks: tasksCompleted } : {}),
        // T2 (row 9): K reset mirrored in the local finalGoal (the same
        // done that completed the batch zeroes the counter).
        ...(batchTasks?.length ? { consecutiveFailedTasks: 0 } : {}),
      }
      if (delegate.onComplete) {
        delegate.onComplete(finalGoal, evaluation)
      }
      // G-C10 item 3b: append the formatted token+time summary to the
      // completion log. Format: "Objetivo concluído: <summary>. Uso
      // registrado: 569.180 tokens; tempo aproximado: 24min20s".
      const heading = delegate.t('goal.completedHeading')
      const body = [completionMessage, usageSummary].filter(Boolean).join('. ')
      delegate.onLog(body ? `${heading}: ${body}` : heading)
      return 'completed'
    }

    if (evaluation.decision === 'pause') {
      // Maestro resolution: pause only on soft-stop reasons the user can
      // resolve (unsafe, needsUser) or infra failures. taskFailure and
      // taskIncomplete are continue-eligible — the model should keep
      // working to fix the failure, not pause.
      const reasonId = evaluation.reasonId
      const shouldPause = reasonId === 'unsafe' || reasonId === 'needsUser' || reasonId === 'infraError'
      if (!shouldPause) {
        // Fall through to continue path — treat as a continue with the
        // structured prompt. The reasonId is preserved on lastEvaluation
        // for the UI to surface the failure context.
        delegate.updateGoal((prev: GoalState) => ({ ...prev, lastEvaluation: evaluation }))
      } else {
        // T2 (rows 4/5): the batch pauses (existing behavior — unsafe
        // stops the WHOLE batch: safety is not per-task; if the agent
        // flagged something unsafe on task 3, moving to task 4 would be
        // ignoring the warning). The task stamp differs: needsUser →
        // 'blocked' (a question waiting for the user, resumable);
        // unsafe/infraError → 'failed' (a diagnosis; both BYPASS K —
        // they pause on the first occurrence because they already ARE
        // systemic diagnoses).
        const taskOutcome: GoalTask['status'] =
          reasonId === 'needsUser' ? 'blocked' : 'failed'
        delegate.updateGoal((prev: GoalState) => ({
          ...prev,
          status: 'paused',
          pausedAt: Date.now(),
          pauseReason: reasonId,
          lastEvaluation: evaluation,
          // T4: a failed task carries WHY into the final report
          // ('unsafe' | 'infraError'); blocked (needsUser) is not a
          // terminal stamp — the skip records its turns later.
          ...stampCurrentTask(
            prev,
            taskOutcome,
            taskOutcome === 'failed'
              ? { failureReason: reasonId as 'unsafe' | 'infraError', turns: currentGoal.turnsRunThisTask ?? 0 }
              : undefined,
          ),
        }))
        delegate.onStatusChange({
          kind: 'stopped',
          objective: currentGoal.objective,
          reason: reasonId,
        })
        delegate.onLog(delegate.t('goal.pausedHeading') + ': ' + reasonId)
        return 'paused'
      }
    }

    // decision === 'continue' (or a D1-downgraded completion, or a batch
    // task that just advanced)
    //
    // T1: the prompt objective is the CURRENT TASK's text for batch
    // goals — the next task's text right after an advance — so the
    // agent is re-anchored on the task it is actually working on, not
    // the whole batch's umbrella objective. Computed LOCALLY (not via
    // delegate.getGoal()): updateGoal's setGoal updater does not run
    // synchronously in production, so the post-advance goal cannot be
    // trusted to be readable here (G-C13/G-C17 desync family).
    const continueObjective = advancedTaskText ?? activeTask?.text ?? currentGoal.objective
    const nextMessage = buildContinuePrompt({
      objective: continueObjective,
      evaluation: effectiveEvaluation,
      workingDirectory: currentGoal.workingDirectory,
    })

    delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'continuing' }))
    delegate.onStatusChange({ kind: 'continuing', objective: currentGoal.objective, turn: currentGoal.turnsRun })

    delegate.onLog(`Continuing goal with structured prompt (${nextMessage.length} chars).`)
    const nextSessionId = await delegate.continueGoal(currentGoal, nextMessage)

    if (!nextSessionId) {
      delegate.onLog('Continue goal returned no session ID (interrupted/error).')
      if (delegate.getGoal()?.status === 'cancelled') return 'cancelled'

      // Terminal error — the turn failed without producing a session.
      // Before G-C3 this path returned 'error' silently; the badge
      // stayed in 'continuing' forever because nobody consumed the
      // return value (fire-and-forget). Now we pause the goal and
      // signal the UI so the user sees the failure.
      const lastGoal = delegate.getGoal()
      if (lastGoal) {
        delegate.updateGoal((prev: GoalState) => ({
          ...prev,
          status: 'paused',
          pausedAt: Date.now(),
          pauseReason: 'goalError',
        }))
      }
      delegate.onStatusChange({
        kind: 'stopped',
        objective: lastGoal?.objective ?? '',
        reason: 'goalError',
      })
      delegate.onLog(delegate.t('goal.errorFailedBody', { message: 'Continue goal returned no session ID' }))
      return 'error'
    }
  }
}

/**
 * T2: stamp the CURRENT task of a batch goal with a terminal-ish
 * outcome ('failed' / 'blocked') inside an updateGoal write. Returns
 * an empty object for legacy goals (no tasks key) so callers can spread
 * it unconditionally without materializing the batch keys on the
 * legacy path. Pure and local: the stamp reads prev.tasks so the write
 * composes with whatever else the same update sets.
 */
function stampCurrentTask(
  goal: GoalState,
  outcome: GoalTask['status'],
  // T4: per-task evidence for the final report (failureReason / turns),
  // merged into the stamped task only.
  extra?: Partial<GoalTask>,
): { tasks?: GoalTask[] } {
  const tasks = goal.tasks
  if (!tasks || tasks.length === 0) return {}
  const taskIndex = Math.min(goal.taskIndex ?? 0, tasks.length - 1)
  return {
    tasks: tasks.map((task, index) =>
      index === taskIndex ? { ...task, status: outcome, ...extra } : task,
    ),
  }
}

function detectLoop(goal: GoalState): boolean {  // Two independent signals, either sufficient on its own:
  //   1. noProgressCount >= LOOP_FINGERPRINT_THRESHOLD — N consecutive
  //      turns whose fingerprint matched the previous turn.
  //   2. last 3 fingerprints all identical — catches the case where
  //      noProgressCount was reset by a transient error path but the
  //      ring still shows repetition.
  if (goal.noProgressCount >= LOOP_FINGERPRINT_THRESHOLD) return true
  if (goal.recentFingerprints.length < LOOP_FINGERPRINT_THRESHOLD) return false
  const last = goal.recentFingerprints.at(-1)
  const secondLast = goal.recentFingerprints.at(-2)
  const thirdLast = goal.recentFingerprints.at(-3)
  return last === secondLast && secondLast === thirdLast
}

// Re-exported for callers that need to inspect the threshold.
export { isInfraError }
