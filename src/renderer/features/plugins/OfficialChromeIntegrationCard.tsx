import { CheckCircle2, CircleAlert, CircleDashed, PanelsTopLeft } from 'lucide-react'
import type { ChromeIntegrationAggregate } from '../../../shared/types'
import verbooIconUrl from '../../../../assets/branding/verboo-mascot.png'
import { useI18n } from '../../i18n'
import { useChromeIntegration } from '../settings/useChromeIntegration'

export function OfficialChromeIntegrationCard({ onManage }: { onManage: () => void }) {
  const { t } = useI18n()
  const { status, loading } = useChromeIntegration()
  const aggregate = status?.aggregate ?? 'notConfigured'
  const configured = aggregate !== 'notConfigured'

  return (
    <article className="official-chrome-card" aria-label={t('plugins.chrome.title')}>
      <div className="official-chrome-icon" aria-hidden="true">
        <img src={verbooIconUrl} alt="" />
        <span><PanelsTopLeft size={13} /></span>
      </div>
      <div className="official-chrome-body">
        <div className="official-chrome-title-row">
          <strong>{t('plugins.chrome.title')}</strong>
          <span className="official-plugin-badge">{t('plugins.chrome.official')}</span>
        </div>
        <p>{t('plugins.chrome.description')}</p>
        <div className={`official-chrome-status is-${aggregate}`}>
          <AggregateIcon aggregate={aggregate} />
          <span>{loading && !status ? t('plugins.chrome.checking') : t(`plugins.chrome.${aggregate}`)}</span>
        </div>
      </div>
      <button type="button" className="official-chrome-action" onClick={onManage}>
        {configured ? t('plugins.chrome.manage') : t('plugins.chrome.configure')}
      </button>
    </article>
  )
}

function AggregateIcon({ aggregate }: { aggregate: ChromeIntegrationAggregate }) {
  if (aggregate === 'connected' || aggregate === 'ready') {
    return <CheckCircle2 size={13} aria-hidden="true" />
  }
  if (aggregate === 'incomplete') return <CircleAlert size={13} aria-hidden="true" />
  return <CircleDashed size={13} aria-hidden="true" />
}
