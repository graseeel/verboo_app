import { AlertTriangle, Gauge } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { ContextUsageSnapshot } from '../../../shared/types'
import { formatCompactNumber, useI18n } from '../../i18n'

type ContextMeterProps = {
  usage?: ContextUsageSnapshot
  contextWindow?: number
}

export function ContextMeter({ usage, contextWindow }: ContextMeterProps) {
  const { language, t } = useI18n()
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
    ? `${formatCompactNumber(usedTokens, language)}/${formatCompactNumber(maxTokens, language)}`
    : maxTokens
      ? t('context.window', { value: formatCompactNumber(maxTokens, language) })
      : t('context.noWindow')
  const title = overLimit
    ? t('context.overLimitTitle')
    : usage ? t('context.usageTitle') : t('context.waitingTitle')

  return (
    <div
      className={`context-meter ${overLimit ? 'over-limit' : ''}`}
      title={title}
      aria-label={t('context.aria', { value: percentLabel })}
      style={{ '--context-progress': bounded ?? 0 } as CSSProperties}
    >
      {overLimit ? <AlertTriangle className="context-meter-icon" size={15} /> : <Gauge className="context-meter-icon" size={15} />}
      <span className="context-copy">
        <strong>{t('context.label')}</strong>
        <small>{usageLabel}</small>
      </span>
      <span className="context-ring" aria-hidden="true">
        <span>{percentLabel}</span>
      </span>
    </div>
  )
}
