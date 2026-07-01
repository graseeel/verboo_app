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
  const overLimit = Boolean(usage?.usedTokens && maxTokens && usage.usedTokens > maxTokens)
  const percentLabel = bounded === undefined ? '--%' : overLimit ? '100%+' : `${Math.round(bounded * 100)}%`
  const usageLabel = usage?.usedTokens && maxTokens
    ? `${formatCompact(usage.usedTokens)}/${formatCompact(maxTokens)}`
    : maxTokens
      ? `--/${formatCompact(maxTokens)}`
      : 'contexto indisponivel'

  return (
    <div
      className={`context-meter ${overLimit ? 'over-limit' : ''}`}
      title={
        overLimit
          ? 'O CLI reportou uso acima da janela configurada. A janela enviada ao CLI e uma meta de autocompactacao, nao um limite duro garantido.'
          : usage ? 'Uso real de contexto recebido do stream do CLI.' : 'Aguardando uso real de contexto do CLI.'
      }
      aria-label={`Contexto ${percentLabel}`}
    >
      <span className="context-percent">{percentLabel}</span>
      <span className="context-bar" aria-hidden="true">
        <span style={{ transform: `scaleX(${bounded === undefined ? 0 : bounded})` }} />
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
