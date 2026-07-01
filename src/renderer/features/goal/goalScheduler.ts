import type { AgentEvent, GoalState } from '../../../shared/types'
import type { GoalStatusBarState } from './GoalStatusBar'

export type GoalSchedulerDelegate = {
  getGoal: () => GoalState | undefined
  updateGoal: (update: ((prev: GoalState) => GoalState) | GoalState) => void
  evaluateGoal: (goal: GoalState) => Promise<{ status: GoalState['status']; nextMessage?: string }>
  continueGoal: (goal: GoalState, nextMessage: string) => Promise<string | undefined>
  abortTurn: () => void
  onStatusChange: (status: GoalStatusBarState) => void
  onLog: (message: string) => void
}

export type ScheduleResult = 'completed' | 'cancelled' | 'budget_limited' | 'blocked' | 'error'

export async function runGoalCycle(delegate: GoalSchedulerDelegate): Promise<ScheduleResult> {
  const goal = delegate.getGoal()
  if (!goal) return 'cancelled'

  delegate.onStatusChange({ kind: 'active', objective: goal.objective, turn: goal.turnsRun, maxTurns: goal.maxTurns })

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

    if (isBudgetExhausted(currentGoal)) {
      delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'budget_limited' }))
      delegate.onStatusChange({ kind: 'budget_limited', objective: currentGoal.objective, reason: budgetExhaustedReason(currentGoal) })
      delegate.onLog('Budget exhausted: stopping goal cycle.')
      return 'budget_limited'
    }

    if (detectLoop(currentGoal)) {
      delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'blocked' }))
      delegate.onStatusChange({ kind: 'stopped', objective: currentGoal.objective, reason: 'Detected possible loop (repeated output fingerprints)' })
      delegate.onLog('Loop detected: identical output fingerprints.')
      return 'blocked'
    }

    delegate.onLog(`Evaluating goal progress (turn ${currentGoal.turnsRun})...`)
    delegate.onStatusChange({ kind: 'evaluating', objective: currentGoal.objective, turn: currentGoal.turnsRun, maxTurns: currentGoal.maxTurns })
    delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'evaluating' }))

    const evaluation = await delegate.evaluateGoal(currentGoal)

    if (evaluation.status === 'completed') {
      delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'completed', completedAt: Date.now() }))
      delegate.onStatusChange({ kind: 'completed', objective: currentGoal.objective })
      delegate.onLog('Goal completed!')
      return 'completed'
    }

    if (evaluation.status === 'blocked' || evaluation.status === 'budget_limited' || evaluation.status === 'cancelled') {
      delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'blocked' }))
      delegate.onStatusChange({ kind: 'stopped', objective: currentGoal.objective, reason: evaluation.nextMessage ?? 'Goal is blocked' })
      delegate.onLog(`Goal blocked: ${evaluation.nextMessage ?? 'unknown reason'}`)
      return 'blocked'
    }

    if (!evaluation.nextMessage) {
      delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'blocked' }))
      delegate.onStatusChange({ kind: 'stopped', objective: currentGoal.objective, reason: 'Evaluator did not provide next instruction' })
      delegate.onLog('No next instruction from evaluator.')
      return 'blocked'
    }

    delegate.updateGoal((prev: GoalState) => ({ ...prev, status: 'continuing' }))
    delegate.onStatusChange({ kind: 'continuing', objective: currentGoal.objective, turn: currentGoal.turnsRun, maxTurns: currentGoal.maxTurns })

    delegate.onLog(`Continuing goal with message: "${evaluation.nextMessage.slice(0, 80)}..."`)
    const nextSessionId = await delegate.continueGoal(currentGoal, evaluation.nextMessage)

    if (!nextSessionId) {
      delegate.onLog('Continue goal returned no session ID (interrupted/error).')
      if (delegate.getGoal()?.status === 'cancelled') return 'cancelled'
      return 'error'
    }
  }
}

function isBudgetExhausted(goal: GoalState): boolean {
  if (goal.turnsRun >= goal.maxTurns) return true
  const elapsed = goal.startedAt ? Date.now() - goal.startedAt : 0
  if (elapsed >= goal.maxElapsedMs) return true
  return false
}

function budgetExhaustedReason(goal: GoalState): string {
  if (goal.turnsRun >= goal.maxTurns) return `Max turns reached (${goal.turnsRun}/${goal.maxTurns})`
  return `Max time elapsed`
}

function detectLoop(goal: GoalState): boolean {
  if (goal.noProgressCount >= 3) return true
  if (goal.recentFingerprints.length < 3) return false
  const last = goal.recentFingerprints.at(-1)
  const secondLast = goal.recentFingerprints.at(-2)
  const thirdLast = goal.recentFingerprints.at(-3)
  return last === secondLast && secondLast === thirdLast
}
