import { Check, CircleAlert, Loader2, Settings2 } from 'lucide-react'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'
import { useI18n } from '../i18n'

export type CliBootstrapGatePhase = 'installing' | 'error' | 'success'

export function CliBootstrapGate({
  phase,
  percent,
  error,
  onRetry,
  onOpenSettings,
}: {
  phase: CliBootstrapGatePhase
  percent?: number
  error?: string
  onRetry: () => void
  onOpenSettings: () => void
}) {
  const { t } = useI18n()
  const installing = phase === 'installing'
  const failed = phase === 'error'
  const progress = Math.round(Math.min(100, Math.max(0, percent ?? 0)))

  return (
    <section
      className={`cli-bootstrap-gate cli-bootstrap-gate--${phase}`}
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? 'assertive' : 'polite'}
      aria-busy={installing}
    >
      <div className="cli-bootstrap-card">
        <div className="cli-bootstrap-visual" aria-hidden="true">
          <span className="cli-bootstrap-aura" />
          <span className="cli-bootstrap-mascot-wrap">
            <img src={mascotUrl} alt="" />
          </span>
          <span className="cli-bootstrap-state-icon">
            {installing ? <Loader2 size={18} /> : failed ? <CircleAlert size={18} /> : <Check size={18} />}
          </span>
        </div>

        <div className="cli-bootstrap-copy">
          <h2>{t(`cliBootstrap.${phase}Title`)}</h2>
          <p>{t(`cliBootstrap.${phase}Body`)}</p>
        </div>

        {installing && typeof percent === 'number' && (
          <div
            className="cli-bootstrap-progress"
            role="progressbar"
            aria-label={t('cliBootstrap.progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <span style={{ transform: `scaleX(${progress / 100})` }} />
            <small>{progress}%</small>
          </div>
        )}

        {failed && error && <small className="cli-bootstrap-error-detail">{error}</small>}

        {phase !== 'success' && (
          <div className="cli-bootstrap-actions">
            <button type="button" className="button secondary" onClick={onOpenSettings}>
              <Settings2 size={15} aria-hidden="true" />
              {t('cliBootstrap.openSettings')}
            </button>
            {failed && (
              <button type="button" className="button primary" onClick={onRetry}>
                {t('cliBootstrap.retry')}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
