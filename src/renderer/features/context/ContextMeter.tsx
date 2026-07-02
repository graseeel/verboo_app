import { AlertTriangle, Gauge } from 'lucide-react'
import type { CSSProperties } from 'react'
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
      ? `janela ${formatCompact(maxTokens)}`
      : 'sem janela'
  const title = overLimit
    ? 'O CLI reportou uso acima da janela de contexto configurada. Essa janela orienta a compactação automática, mas não é um limite rígido do processo.'
    : usage ? 'Uso real de contexto reportado pelo stream do CLI.' : 'Aguardando uso de contexto do stream do CLI.'

  return (
    <div
      className={`context-meter ${overLimit ? 'over-limit' : ''}`}
      title={title}
      aria-label={`Contexto ${percentLabel}`}
      style={{ '--context-progress': bounded ?? 0 } as CSSProperties}
    >
      {overLimit ? <AlertTriangle className="context-meter-icon" size={15} /> : <Gauge className="context-meter-icon" size={15} />}
      <span className="context-copy">
        <strong>Contexto</strong>
        <small>{usageLabel}</small>
      </span>
      <span className="context-ring" aria-hidden="true">
        <span>{percentLabel}</span>
      </span>
    </div>
  )
}

function formatCompact(value: number): string {
  return Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}
