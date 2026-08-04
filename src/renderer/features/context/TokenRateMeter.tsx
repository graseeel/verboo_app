import { Activity } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TokenRateSnapshot } from '../../../shared/types'
import { formatCompactNumber, useI18n } from '../../i18n'

type TokenRateMeterProps = {
  active: boolean
  rate?: TokenRateSnapshot
}

const HIDE_TOKEN_RATE_AT = 520

export function TokenRateMeter({ active, rate }: TokenRateMeterProps) {
  const { language, t } = useI18n()
  const hostRef = useRef<HTMLSpanElement>(null)
  const [narrow, setNarrow] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    const composer = host?.closest<HTMLElement>('.composer')
    if (!composer) return

    const update = (width: number) => setNarrow(width <= HIDE_TOKEN_RATE_AT)
    update(composer.getBoundingClientRect().width)

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? composer.getBoundingClientRect().width
      update(width)
    })
    observer.observe(composer)
    return () => observer.disconnect()
  }, [])

  const tokenValue = rate?.tokensPerSecond
  const tokenLabel = tokenValue === undefined ? '--' : formatCompactNumber(tokenValue, language)
  const title = active ? t('tokens.rateActiveTitle') : t('tokens.rateIdleTitle')

  return (
    <span ref={hostRef} className="token-rate-meter-slot">
      {!narrow && (
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
      )}
    </span>
  )
}
