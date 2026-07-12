import type { GoalEvaluationResult, GoalState } from '../../../shared/types'
import type { GoalStatusBarState } from './GoalStatusBar'
import type { Translator } from '../../i18n'
import { buildContinuePrompt, buildCompletionMessage } from './goalPrompt'
import { isInfraError } from './goalReason'

/**
 * Maximum consecutive evaluator failures before the scheduler pauses the
 * goal with `pauseReason: 'infra_error'`. Prevents burning budget on a
 * broken evaluator (CLI timeout, parse error, network).
 */
export const MAX_EVALUATION_ERRORS = 3

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
        delegate.updateGoal((prev: GoalState) => ({
          ...prev,
          status: 'paused',
          pausedAt: Date.now(),
          pauseReason: 'infraError',
          errorCount,
        }))
        delegate.onStatusChange({
          kind: 'stopped',
          objective: currentGoal.objective,
          reason: 'infraError',
        })
        delegate.onLog(delegate.t('goal.errorPausedTitle', { count: errorCount }) + ': ' + message)
        return 'paused'
      }

      // Transient error — record and retry next cycle (budget still consumed).
      delegate.updateGoal((prev: GoalState) => ({ ...prev, errorCount }))
      continue
    }

    // Successful evaluation — reset error counter.
    if ((currentGoal.errorCount ?? 0) > 0) {
      delegate.updateGoal((prev: GoalState) => ({ ...prev, errorCount: 0 }))
    }

    // Persist the evaluation on the goal for UI hydration.
    delegate.updateGoal((prev: GoalState) => ({ ...prev, lastEvaluation: evaluation }))

    if (evaluation.decision === 'complete') {
      const completionMessage = buildCompletionMessage(evaluation)
      delegate.updateGoal((prev: GoalState) => ({
        ...prev,
        status: 'completed',
        completedAt: Date.now(),
        lastEvaluation: evaluation,
      }))
      delegate.onStatusChange({ kind: 'completed', objective: currentGoal.objective })
      delegate.onLog(delegate.t('goal.completedHeading') + (completionMessage ? ': ' + completionMessage : ''))
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
      return 'error'
    }
  }
}

function detectLoop(goal: GoalState): boolean {
  if (goal.noProgressCount >= 3) return true
  if (goal.recentFingerprints.length < 3) return false
  const last = goal.recentFingerprints.at(-1)
  const secondLast = goal.recentFingerprints.at(-2)
  const thirdLast = goal.recentFingerprints.at(-3)
  return last === secondLast && secondLast === thirdLast
}

// Re-exported for callers that need to inspect the threshold.
export { isInfraError }
