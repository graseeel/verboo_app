import type { AgentResultSnapshot, GoalEvaluationInput, GoalEvaluationResult, GoalState, TokenUsage, TranscriptItem } from '../../shared/types'

type EvaluateGoalInput = {
  goal: GoalState
  conversationItems: TranscriptItem[]
  latestResult?: AgentResultSnapshot
  workingDirectory: string
}

type EvaluateGoalOutput = {
  evaluation: GoalEvaluationResult
  userMessage?: string
}

export async function evaluateGoal(input: EvaluateGoalInput): Promise<EvaluateGoalOutput> {
  const { goal, conversationItems, latestResult, workingDirectory } = input

  const recentItems = conversationItems.slice(-30)

  const evaluationPrompt = buildEvaluationPrompt(goal, recentItems, latestResult)
  const cliPath = process.env.VERBOO_CLI_PATH ?? 'verboo'

  return runGoalEvaluation(cliPath, evaluationPrompt, workingDirectory, goal)
}

function buildEvaluationPrompt(
  goal: GoalState,
  items: TranscriptItem[],
  latestResult?: AgentResultSnapshot,
): string {
  const transcript = items
    .filter(item => item.role !== 'system' || item.id.startsWith('goal-system:'))
    .map(item => `[${item.role}] ${item.text}`)
    .join('\n\n')

  const budgetInfo = [
    `Turns used: ${goal.turnsRun}/${goal.maxTurns}`,
    `Elapsed: ${Math.floor((Date.now() - (goal.startedAt ?? Date.now())) / 1000)}s / ${Math.floor(goal.maxElapsedMs / 1000)}s`,
    `Input tokens: ${goal.usedInputTokens}`,
    `Output tokens: ${goal.usedOutputTokens}`,
  ].join('\n')

  return [
    '# Goal Evaluation',
    '',
    `## Objective: ${goal.objective}`,
    '',
    '## Budget Status',
    budgetInfo,
    '',
    latestResult
      ? [
          '## Latest Result',
          `Exit code: ${latestResult.exitCode}`,
          latestResult.stopReason ? `Stop reason: ${latestResult.stopReason}` : '',
          latestResult.isError ? 'ERROR: The last turn ended with an error.' : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    '',
    '## Conversation Transcript (last 30 messages)',
    transcript || '(empty conversation)',
    '',
    '## Evaluation Task',
    '',
    'Assess whether the objective has been met. Output a JSON object with this structure:',
    '{',
    '  "decision": "complete" | "continue" | "blocked",',
    '  "confidence": 0.0-1.0,',
    '  "reason": "brief justification",',
    '  "evidence": ["list of evidence items"],',
    '  "missing": ["what is still needed if not complete"],',
    '  "nextMessage": "optional suggested next instruction if continuing"',
    '}',
    '',
    'Rules:',
    '- COMPLETE only when you see clear evidence the objective is met.',
    '- CONTINUE when progress is being made but not done yet.',
    '- BLOCKED when the agent is stuck, looping, or needs user input.',
    '- Budget exhaustion is NOT completion.',
    '- Be strict: the goal is only complete when the evidence is unambiguous.',
  ].join('\n')
}

async function runGoalEvaluation(
  cliPath: string,
  prompt: string,
  workingDirectory: string,
  goal: GoalState,
): Promise<EvaluateGoalOutput> {
  const { execa } = await import('execa')

  const result = await execa(cliPath, ['--print', prompt, '--output-format', 'json'], {
    cwd: workingDirectory,
    timeout: 30_000,
    reject: false,
  })

  const stdout = result.stdout ?? ''

  const parsed = parseJsonFromOutput(stdout)
  if (!parsed || !isValidEvaluation(parsed)) {
    return {
      evaluation: {
        decision: 'continue',
        confidence: 0,
        reason: 'Evaluator could not parse response, defaulting to continue.',
        evidence: [],
        missing: ['Evaluator output was unparseable'],
      },
    }
  }

  const evaluation: GoalEvaluationResult = {
    decision: parsed.decision as GoalEvaluationResult['decision'],
    confidence: parsed.confidence ?? 0,
    reason: parsed.reason ?? '',
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((e: unknown): e is string => typeof e === 'string') : [],
    missing: Array.isArray(parsed.missing) ? parsed.missing.filter((e: unknown): e is string => typeof e === 'string') : [],
    nextMessage: typeof parsed.nextMessage === 'string' ? parsed.nextMessage : undefined,
  }

  return {
    evaluation,
    userMessage: evaluation.decision === 'complete' ? undefined : evaluation.nextMessage,
  }
}

function isValidEvaluation(value: unknown): value is {
  decision: string
  confidence?: number
  reason?: string
  evidence?: string[]
  missing?: string[]
  nextMessage?: string
} {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return candidate.decision === 'complete' || candidate.decision === 'continue' || candidate.decision === 'blocked'
}

function parseJsonFromOutput(text: string): Record<string, unknown> | undefined {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return undefined
  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // not valid JSON
  }
  return undefined
}
