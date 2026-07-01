import { AlertTriangle, Gauge } from 'lucide-react'
import type { ContextUsageSnapshot } from '../../../shared/types'

type ContextMeterProps = {
  usage?: ContextUsageSnapshot
  contextWindow?: number
}

export function ContextMeter({ usage, contextWindow }: ContextMeterProps) {
  const maxTokens = usage?.maxTokens ?? contextWindow
  const usedTokens = usage?.usedTokens
  const hasUsedTokens = usedTokens !== undefined
  const bounded = usage?.percentage !== undefined
    ? Math.max(0, Math.min(1, usage.percentage))
    : hasUsedTokens && maxTokens
      ? Math.max(0, Math.min(1, usedTokens / maxTokens))
      : undefined
  const overLimit = Boolean(hasUsedTokens && maxTokens && usedTokens > maxTokens)
  const percentLabel = bounded === undefined ? '--%' : overLimit ? '100%+' : `${Math.round(bounded * 100)}%`
  const usageLabel = hasUsedTokens && maxTokens
    ? `${formatCompact(usedTokens)}/${formatCompact(maxTokens)}`
    : maxTokens
      ? `--/${formatCompact(maxTokens)}`
      : 'unavailable'
  const title = overLimit
    ? 'The CLI reported usage above the configured context window. This window is an auto-compact target, not a hard process limit.'
    : usage ? 'Real context usage reported by the CLI stream.' : 'Waiting for context usage from the CLI stream.'

  return (
    <div
      className={`context-meter ${overLimit ? 'over-limit' : ''}`}
      title={title}
      aria-label={`Context ${percentLabel}`}
    >
      {overLimit ? <AlertTriangle className="context-meter-icon" size={15} /> : <Gauge className="context-meter-icon" size={15} />}
      <span className="context-copy">
        <strong>Context</strong>
        <small>{usageLabel}</small>
      </span>
      <span className="context-bar" aria-hidden="true">
        <span style={{ transform: `scaleX(${bounded === undefined ? 0 : bounded})` }} />
      </span>
      <span className="context-percent">{percentLabel}</span>
    </div>
  )
}

function formatCompact(value: number): string {
  return Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}
