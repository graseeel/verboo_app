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
  const title = active ? t('tokens.rateActiveTitle') : t('tokens.rateIdleTitle')

  return (
    <div
      className={`token-rate-meter ${active ? 'active' : ''}`}
      title={title}
      aria-label={t('tokens.rateAria', {
        value: `${tokenLabel} ${t('tokens.rateUnit')}`,
      })}
    >
      <Activity className="token-rate-icon" size={15} />
      <span className="token-rate-copy">
        <strong>{tokenLabel}</strong>
        <small>{t('tokens.rateUnit')}</small>
      </span>
    </div>
  )
}
