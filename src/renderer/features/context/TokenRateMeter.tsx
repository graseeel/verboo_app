import { Activity } from 'lucide-react'
import type { TokenRateSnapshot } from '../../../shared/types'
import { formatCompactNumber, useI18n } from '../../i18n'

type TokenRateMeterProps = {
  active: boolean
  rate?: TokenRateSnapshot
  /** Plan concurrent-request limit from the account (real value, live-refreshed
      with the profile). The service now limits by concurrency, not req/min. */
  concurrentRequests?: number
}

export function TokenRateMeter({ active, rate, concurrentRequests }: TokenRateMeterProps) {
  const { language, t } = useI18n()
  const tokenValue = rate?.tokensPerSecond
  const tokenLabel = tokenValue === undefined ? '--' : formatCompactNumber(tokenValue, language)
  const concurrentLabel = concurrentRequests === undefined ? '--' : formatCompactNumber(concurrentRequests, language)
  const title = active ? t('tokens.rateActiveTitle') : t('tokens.rateIdleTitle')

  return (
    <div
      className={`token-rate-meter ${active ? 'active' : ''}`}
      title={title}
      aria-label={t('tokens.rateAria', {
        value: `${tokenLabel} ${t('tokens.rateUnit')}, ${concurrentLabel} ${t('tokens.concurrentUnit')}`,
      })}
    >
      <Activity className="token-rate-icon" size={15} />
      <span className="token-rate-copy">
        <strong>{tokenLabel}</strong>
        <small>{t('tokens.rateUnit')}</small>
      </span>
      <span className="token-rate-divider" aria-hidden="true" />
      <span className="token-rate-copy">
        <strong>{concurrentLabel}</strong>
        <small>{t('tokens.concurrentUnit')}</small>
      </span>
    </div>
  )
}
