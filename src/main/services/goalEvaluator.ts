import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentResultSnapshot, GoalEvaluationResult, GoalState, TranscriptItem } from '../../shared/types'
import { createNodeRuntimeEnv, resolveExternalNodePath, resolveNodeRuntimePath } from './nodeRuntime'

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

  return runGoalEvaluation(evaluationPrompt, workingDirectory)
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
  prompt: string,
  workingDirectory: string,
): Promise<EvaluateGoalOutput> {
  // Run the bundled Verboo CLI through the resolved Node runtime — exactly the
  // path the rest of the app uses. Never assume a global `verboo` binary on
  // PATH: it only exists on machines that happen to have installed one, so
  // relying on it would break the goal evaluator for everyone else (and silently
  // fall back to "continue" forever).
  const stdout = await runEvaluationCli(['--print', prompt, '--output-format', 'json'], workingDirectory, 30_000)

  const parsed = extractEvaluationJson(stdout)
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
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((e: unknown): e is string => typeof e === 'string') : [],
    missing: Array.isArray(parsed.missing) ? parsed.missing.filter((e: unknown): e is string => typeof e === 'string') : [],
    nextMessage: typeof parsed.nextMessage === 'string' ? parsed.nextMessage : undefined,
  }

  return {
    evaluation,
    userMessage: evaluation.decision === 'complete' ? undefined : evaluation.nextMessage,
  }
}

function resolveCliPath(): string {
  const packagePath = require.resolve('@verboo/code/package.json')
  const packageJson = require(packagePath) as { bin?: string | Record<string, string> }
  const binPath = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.verboo
  return resolveExternalNodePath(join(dirname(packagePath), binPath ?? 'dist/cli.mjs'))
}

async function runEvaluationCli(args: string[], workingDirectory: string, timeoutMs: number): Promise<string> {
  const nodePath = await resolveNodeRuntimePath()
  const cliPath = resolveCliPath()
  const child = spawn(nodePath, [cliPath, ...args], {
    cwd: workingDirectory,
    env: createNodeRuntimeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return new Promise<string>(resolve => {
    const output: string[] = []
    let settled = false
    const finish = (value: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(output.join('\n'))
    }, timeoutMs)

    createInterface({ input: child.stdout }).on('line', line => output.push(line))
    child.on('error', () => finish(output.join('\n')))
    child.on('close', () => finish(output.join('\n')))
  })
}

// The CLI's --output-format json wraps the model reply in an envelope:
//   {"type":"result", ..., "result":"<the model's text>", ...}
// The evaluation JSON the model produced lives inside .result as a (stringified)
// object, so parse the envelope first and pull it out. Fall back to reading the
// top level directly in case the CLI ever emits the evaluation unwrapped.
function extractEvaluationJson(stdout: string): Record<string, unknown> | undefined {
  const envelope = parseFirstJsonObject(stdout)
  if (envelope && typeof envelope.result === 'string') {
    const inner = parseFirstJsonObject(envelope.result)
    if (inner && typeof inner.decision === 'string') return inner
  }
  if (envelope && typeof envelope.decision === 'string') return envelope
  return undefined
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

function parseFirstJsonObject(text: string): Record<string, unknown> | undefined {
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
