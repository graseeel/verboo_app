import { GitBranch, LoaderCircle, X } from 'lucide-react'
import type { SubagentThread } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { subagentThreadCounts } from './subagentThreads'

export function SubagentIndicator({
  threads,
  open,
  onOpen,
  onDismiss,
}: {
  threads: SubagentThread[]
  open: boolean
  onOpen: () => void
  /** Hides the floating chip until new subagent activity arrives. */
  onDismiss?: () => void
}) {
  const { t } = useI18n()
  const counts = subagentThreadCounts(threads)
  if (counts.total === 0) return null

  return (
    <div className={`subagent-indicator ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="subagent-indicator-main"
        onClick={onOpen}
        aria-expanded={open}
        aria-label={t('subagent.indicatorAria', { count: counts.total })}
      >
        {counts.working > 0
          ? <LoaderCircle className="subagent-indicator-spinner" size={14} aria-hidden="true" />
          : <GitBranch size={14} aria-hidden="true" />}
        <span>{t('subagent.summaryTitle')}</span>
        <strong>{counts.total}</strong>
      </button>
      {onDismiss && (
        <button
          type="button"
          className="subagent-indicator-close"
          onClick={onDismiss}
          aria-label={t('subagent.dismiss')}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
