import { Activity } from 'lucide-react'
import type { TokenRateSnapshot } from '../../../shared/types'
import { formatCompactNumber, useI18n } from '../../i18n'

type TokenRateMeterProps = {
  active: boolean
  rate?: TokenRateSnapshot
}

export function TokenRateMeter({ active, rate }: TokenRateMeterProps) {
  const { language, t } = useI18n()
  const tokenValue = rate?.tokensPerSecond
  const tokenLabel = tokenValue === undefined ? '--' : formatCompactNumber(tokenValue, language)
  const requestValue = rate?.requestsPerMinute
  const requestLabel = requestValue === undefined ? '--' : formatCompactNumber(requestValue, language)
  const title = active ? t('tokens.rateActiveTitle') : t('tokens.rateIdleTitle')

  return (
    <div
      className={`token-rate-meter ${active ? 'active' : ''}`}
      title={title}
      aria-label={t('tokens.rateAria', {
        value: `${tokenLabel} ${t('tokens.rateUnit')}, ${requestLabel} ${t('tokens.requestsUnit')}`,
      })}
    >
      <Activity className="token-rate-icon" size={15} />
      <span className="token-rate-copy">
        <strong>{tokenLabel}</strong>
        <small>{t('tokens.rateUnit')}</small>
      </span>
      <span className="token-rate-divider" aria-hidden="true" />
      <span className="token-rate-copy">
        <strong>{requestLabel}</strong>
        <small>{t('tokens.requestsUnit')}</small>
      </span>
    </div>
  )
}
