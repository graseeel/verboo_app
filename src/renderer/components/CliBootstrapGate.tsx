import { Check, CircleAlert, Loader2, Settings2 } from 'lucide-react'
import type { ReactNode } from 'react'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'
import type { BootstrapStage } from '../../shared/types'
import { useI18n } from '../i18n'

export type CliBootstrapGatePhase = 'checking' | 'installing' | 'error' | 'success'

/** The gate CARD alone — no fullscreen wrapper. Reused by the post-login
 *  overlay (CliBootstrapGate) and embedded on the login surface, so both
 *  presentations share one markup and one animation source. `actions` render
 *  INSIDE the card border; the busy state covers checking and installing. */
export function CliBootstrapCard({
  phase,
  stage,
  percent,
  error,
  actions,
}: {
  phase: CliBootstrapGatePhase
  stage: BootstrapStage
  percent?: number
  error?: string
  actions?: ReactNode
}) {
  const { t } = useI18n()
  const working = phase === 'installing' || phase === 'checking'
  const failed = phase === 'error'
  const progress = Math.round(Math.min(100, Math.max(0, percent ?? 0)))
  const copyPrefix = phase === 'success'
    ? 'cliBootstrap.success'
    : phase === 'checking'
      ? 'cliBootstrap.checking'
      : `cliBootstrap.${stage}.${phase}`
  const errorDetail = error && !error.includes('runtime_install_failed') && !error.includes('cli_initialization_failed')
    ? error
    : undefined

  return (
    <div className={`cli-bootstrap-card cli-bootstrap-card--${phase}`}>
      <div className="cli-bootstrap-visual" aria-hidden="true">
        <span className="cli-bootstrap-aura" />
        <span className="cli-bootstrap-mascot-wrap">
          <img src={mascotUrl} alt="" />
        </span>
        <span className="cli-bootstrap-state-icon">
          {working ? <Loader2 size={18} /> : failed ? <CircleAlert size={18} /> : <Check size={18} />}
        </span>
      </div>

      <div className="cli-bootstrap-copy">
        <h2>{t(`${copyPrefix}Title`)}</h2>
        <p>{t(`${copyPrefix}Body`)}</p>
      </div>

      {phase === 'installing' && typeof percent === 'number' && (
        <div
          className="cli-bootstrap-progress"
          role="progressbar"
          aria-label={t(`cliBootstrap.${stage}.progress`)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ transform: `scaleX(${progress / 100})` }} />
          <small>{progress}%</small>
        </div>
      )}

      {failed && errorDetail && <small className="cli-bootstrap-error-detail">{errorDetail}</small>}

      {actions}
    </div>
  )
}

export function CliBootstrapGate({
  phase,
  stage,
  percent,
  error,
  onRetry,
  onOpenSettings,
}: {
  phase: CliBootstrapGatePhase
  stage: BootstrapStage
  percent?: number
  error?: string
  onRetry: () => void
  onOpenSettings: () => void
}) {
  const { t } = useI18n()
  const failed = phase === 'error'

  return (
    <section
      className={`cli-bootstrap-gate cli-bootstrap-gate--${phase}`}
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? 'assertive' : 'polite'}
      aria-busy={phase === 'installing' || phase === 'checking'}
    >
      <CliBootstrapCard
        phase={phase}
        stage={stage}
        percent={percent}
        error={error}
        actions={phase !== 'success' && (
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
      />
    </section>
  )
}
