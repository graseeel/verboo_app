import type { CSSProperties } from 'react'
import type { ContextUsageSnapshot } from '../../../shared/types'
import { formatCompactNumber, useI18n } from '../../i18n'

type ContextMeterProps = {
  usage?: ContextUsageSnapshot
  contextWindow?: number
}

/**
 * Ring-only context meter for the composer toolbar.
 *
 * Design (Codex-like): a single filled ring that grows with context usage —
 * no rotation, no dropdown, no panel on click. The percent label sits in the
 * ring center; the full `used/max` breakdown is exposed via the native
 * `title` tooltip so it stays discoverable without adding composer chrome.
 *
 * The previous `onClick` / ContextPanel popover was disconnected from the
 * composer (panel file retained for future Settings reuse). Pruning actions
 * (clear attachments / skills) remain available in their own surfaces.
 */
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
  // '~' marks a local estimate — shown when the router reports no real usage.
  const estimatePrefix = usage?.source === 'estimated' ? '~' : ''
  const percentLabel = bounded === undefined ? '--%' : overLimit ? '100%+' : `${estimatePrefix}${Math.round(bounded * 100)}%`
  const usageLabel = hasUsedTokens && maxTokens
    ? `${formatCompactNumber(usedTokens, language)}/${formatCompactNumber(maxTokens, language)}`
    : maxTokens
      ? t('context.window', { value: formatCompactNumber(maxTokens, language) })
      : t('context.noWindow')
  const title = overLimit
    ? t('context.overLimitTitle')
    : usage ? t('context.usageTitle') : t('context.waitingTitle')
  // Compose a single informative tooltip: title + usage breakdown.
  const tooltip = `${title} · ${usageLabel} · ${percentLabel}`

  return (
    <div
      className={`context-meter context-meter--ring-only ${overLimit ? 'over-limit' : ''}`}
      role="status"
      aria-label={t('context.aria', { value: percentLabel })}
      title={tooltip}
      style={{ '--context-progress': bounded ?? 0 } as CSSProperties}
    >
      <span className="context-ring" aria-hidden="true">
        <span>{percentLabel}</span>
      </span>
    </div>
  )
}
