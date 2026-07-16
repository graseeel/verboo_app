import type { SkillSummary } from '../../../shared/types'
import type { ComputerUseApp } from '../../verboo-bridge'

export type ComputerUseIntent = {
  source: 'explicit' | 'selected-skill'
  goal: string
}

export function detectComputerUseIntent(
  message: string,
  selectedSkills: SkillSummary[],
): ComputerUseIntent | undefined {
  const goal = message.trim()
  const asksForExplanation = /^(?:explain|describe|what\s+is|how\s+does|explique|descreva|o\s+que\s+[ée]|como\s+funciona)\b/i.test(goal)
  if (
    !asksForExplanation && (
      /^computer[- ]use\s*[:,\-]/i.test(goal)
      || /\b(?:use|control|operate)\b.{0,48}\b(?:computer[- ]use|the\s+computer|computer\s+control|desktop\s+control)\b/i.test(goal)
      || /\b(?:use|usar|utilize|controle|controlar|opere)\b.{0,48}\b(?:computer[- ]use|computador|controle\s+(?:do\s+)?computador|desktop)\b/i.test(goal)
    )
  ) {
    return { source: 'explicit', goal }
  }
  if (selectedSkills.some(skill => (
    skill.id.trim().toLowerCase() === 'computer-use'
    || skill.name.trim().toLowerCase().replace(/\s+/g, '-') === 'computer-use'
    || /(?:^|\/)computer-use(?:\/SKILL\.md)?$/i.test(skill.path.trim())
  ))) {
    return { source: 'selected-skill', goal }
  }
  return undefined
}

export function resolveComputerUseTarget(
  goal: string,
  apps: ComputerUseApp[],
  explicitSelector?: string,
): ComputerUseApp | undefined {
  const haystack = normalizeForMatch(explicitSelector || goal)
  const matches = apps
    .flatMap(app => appAliases(app).map(alias => ({ app, alias })))
    .filter(({ alias }) => containsTerm(haystack, alias))
    .sort((left, right) => right.alias.length - left.alias.length)
  return matches[0]?.app
}

export function extractComputerUseAppSelector(goal: string): string | undefined {
  const match = goal.match(
    /\b(?:app|aplicativo|application)\s+["“”']?([\p{L}\p{N}][\p{L}\p{N} ._-]*?)["“”']?(?=\s+(?:e|and|para|to|que|then)\b|[,;.!?]|$)/iu,
  )
  return match?.[1]?.trim() || undefined
}

export function countHiddenComputerUseApps(
  apps: ComputerUseApp[],
  targetBundleId: string,
  approvedBundleIds: string[] = [],
): number {
  const excludedBundleIds = new Set([
    targetBundleId.trim().toLocaleLowerCase(),
    'ai.verboo.code.desktop',
    ...approvedBundleIds.map(bundleId => bundleId.trim().toLocaleLowerCase()),
  ])
  const visibleBundleIds = new Set<string>()

  for (const app of apps) {
    const bundleId = app.bundleId.trim().toLocaleLowerCase()
    if (!bundleId || excludedBundleIds.has(bundleId)) continue
    if (!Number.isFinite(app.visibleWindowCount) || (app.visibleWindowCount ?? 0) <= 0) continue
    visibleBundleIds.add(bundleId)
  }

  return visibleBundleIds.size
}

/**
 * True when CU intent is present (skill or explicit NL). Callers may pre-bind
 * `resolvedApp` when known; absence of an app never blocks start (goal-first).
 * `resolvedApp` is accepted for API clarity / tests; it does not change the result.
 */
export function shouldStartGoalDirectedComputerUse(
  intent: ComputerUseIntent | undefined,
  _resolvedApp?: ComputerUseApp | undefined,
): boolean {
  return Boolean(intent)
}

function appAliases(app: ComputerUseApp): string[] {
  const aliases = new Set<string>([normalizeForMatch(app.name)])
  const known: Record<string, string[]> = {
    'com.apple.notes': ['notes', 'notas'],
    'com.google.chrome': ['google chrome', 'chrome'],
    'ai.verboo.code.desktop': ['verboo code', 'verboo'],
    'com.apple.textedit': ['textedit', 'text edit'],
    'com.apple.preview': ['preview', 'pre visualizacao'],
  }
  for (const alias of known[app.bundleId.toLowerCase()] ?? []) aliases.add(alias)

  const generic = new Set(['app', 'application', 'desktop', 'code', 'google', 'microsoft', 'apple'])
  const meaningfulTokens = normalizeForMatch(app.name)
    .split(' ')
    .filter(token => token.length >= 4 && !generic.has(token))
  if (meaningfulTokens.length === 1) aliases.add(meaningfulTokens[0])
  return [...aliases].filter(Boolean)
}

function containsTerm(haystack: string, term: string): boolean {
  return (` ${haystack} `).includes(` ${term} `)
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
