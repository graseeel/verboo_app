import type { ContextUsageSnapshot } from '../../../shared/types'

type ContextMeterProps = {
  usage?: ContextUsageSnapshot
  contextWindow?: number
}

export function ContextMeter({ usage, contextWindow }: ContextMeterProps) {
  const maxTokens = usage?.maxTokens ?? contextWindow
  const bounded = usage?.percentage !== undefined
    ? Math.max(0, Math.min(1, usage.percentage))
    : usage?.usedTokens && maxTokens
      ? Math.max(0, Math.min(1, usage.usedTokens / maxTokens))
      : undefined
  const percentLabel = bounded === undefined ? '--%' : `${Math.round(bounded * 100)}%`
  const usageLabel = usage?.usedTokens && maxTokens
    ? `${formatCompact(usage.usedTokens)}/${formatCompact(maxTokens)}`
    : maxTokens
      ? `--/${formatCompact(maxTokens)}`
      : 'contexto indisponivel'

  return (
    <div
      className="context-meter"
      title={usage ? 'Uso real de contexto recebido do stream do CLI.' : 'Aguardando uso real de contexto do CLI.'}
      aria-label={`Contexto ${percentLabel}`}
    >
      <span className="context-percent">{percentLabel}</span>
      <span className="context-bar" aria-hidden="true">
        <span style={{ width: bounded === undefined ? '0%' : `${bounded * 100}%` }} />
      </span>
      <span>{usageLabel}</span>
    </div>
  )
}

function formatCompact(value: number): string {
  return Intl.NumberFormat('pt-BR', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}
