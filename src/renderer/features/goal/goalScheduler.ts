import type { GoalEvaluationResult, GoalState } from '../../../shared/types'
import type { GoalStatusBarState } from './GoalStatusBar'
import type { Translator } from '../../i18n'
import { buildContinuePrompt, buildCompletionMessage, buildUsageSummary } from './goalPrompt'
import { isInfraError } from './goalReason'

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
   */
  onComplete?: (goal: GoalState, evaluation: GoalEvaluationResult) => void
  /** i18n translator for system messages emitted by the scheduler. */
  t: Translator
}

export type ScheduleResult = 'completed' | 'cancelled' | 'paused' | 'blocked' | 'error'

export async function runGoalCycle(delegate: GoalSchedulerDelegate): Promise<ScheduleResult> {
  const goal = delegate.getGoal()
  if (!goal) return 'cancelled'

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
    // Only loop detection (identical output fingerprints) can block the cycle.
    if (detectLoop(currentGoal)) {
      delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'blocked' }))
      delegate.onStatusChange({ kind: 'stopped', objective: currentGoal.objective, reason: 'loop' })
      delegate.onLog('Loop detected: identical output fingerprints.')
      return 'blocked'
    }

    delegate.onLog(`Evaluating goal progress (turn ${currentGoal.turnsRun})...`)
    delegate.onStatusChange({ kind: 'evaluating', objective: currentGoal.objective, turn: currentGoal.turnsRun })
    delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'evaluating' }))

    let evaluation: GoalEvaluationResult
    try {
      evaluation = await delegate.evaluateGoal(currentGoal)
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
        delegate.updateGoal((prev: GoalState) => ({
          ...prev,
          status: 'paused',
          pausedAt: Date.now(),
          pauseReason: 'infraError',
          errorCount,
          lastEvaluation: syntheticEvaluation,
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

    // Persist the evaluation on the goal for UI hydration.
    delegate.updateGoal((prev: GoalState) => ({ ...prev, lastEvaluation: evaluation }))

    // Update loop-detection state. The fingerprint is computed from the
    // evaluation we just received; if it matches the previous turn's
    // fingerprint, the agent is repeating itself and noProgressCount
    // increments. Otherwise it resets — a structural change means the
    // agent is making progress even if the decision is still 'continue'.
    // See `computeFingerprint` for the textual-vs-semantic limitation.
    const fingerprint = computeFingerprint(evaluation)
    delegate.updateGoal((prev: GoalState) => {
      const prevFp = prev.recentFingerprints.at(-1)
      const isRepeat = prevFp !== undefined && fingerprint === prevFp
      const nextNoProgress = isRepeat ? prev.noProgressCount + 1 : 0
      const nextRing = [...prev.recentFingerprints, fingerprint].slice(-FINGERPRINT_RING_CAP)
      return { ...prev, recentFingerprints: nextRing, noProgressCount: nextNoProgress }
    })

    if (evaluation.decision === 'complete') {
      const completionMessage = buildCompletionMessage(evaluation)
      // G-C10 item 3: stamp completedAt BEFORE building the usage
      // summary, so the elapsed time is computed from the real
      // completion instant. The updateGoal below writes the same
      // completedAt to the persisted goal; the local stamp is only
      // used to build the summary string for the log line.
      const completedAt = Date.now()
      const goalForSummary: GoalState = { ...currentGoal, completedAt }
      const usageSummary = buildUsageSummary(goalForSummary)
      delegate.updateGoal((prev: GoalState) => ({
        ...prev,
        status: 'completed',
        completedAt,
        lastEvaluation: evaluation,
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
        delegate.updateGoal((prev: GoalState) => ({
          ...prev,
          status: 'paused',
          pausedAt: Date.now(),
          pauseReason: reasonId,
          lastEvaluation: evaluation,
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

    // decision === 'continue'
    const nextMessage = buildContinuePrompt({
      objective: currentGoal.objective,
      evaluation,
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

function detectLoop(goal: GoalState): boolean {
  // Two independent signals, either sufficient on its own:
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
