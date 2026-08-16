import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  LoaderCircle,
  PanelRightOpen,
  PlugZap,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  UserRound,
} from 'lucide-react'
import { ChromeLogoIcon } from '../../components/ChromeLogoIcon'
import { useState } from 'react'
import type {
  ChromeComponentState,
  ChromeConnectionState,
  ChromeIntegrationAggregate,
} from '../../../shared/types'
import { useI18n, type Translator } from '../../i18n'
import { useChromeIntegration } from './useChromeIntegration'

export function ChromeIntegrationSettings() {
  const { t } = useI18n()
  const integration = useChromeIntegration()
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  const status = integration.status

  if (integration.loading && !status) {
    return (
      <section className="settings-panel chrome-integration-loading" aria-busy="true">
        <LoaderCircle size={18} />
        <span>{t('chrome.loading')}</span>
      </section>
    )
  }

  if (!status) {
    return (
      <section className="settings-panel chrome-integration-empty">
        <CircleAlert size={18} />
        <div>
          <strong>{t('chrome.statusUnavailable')}</strong>
          <p>{localizedError(integration.error, t)}</p>
        </div>
        <button type="button" onClick={() => void integration.refresh()}>
          <RefreshCcw size={14} />
          {t('common.refresh')}
        </button>
      </section>
    )
  }

  const canTest = status.bridge === 'managed' || status.bridge === 'outdated'
  const busy = integration.activeAction !== undefined

  return (
    <>
      <section className="settings-panel chrome-integration-summary">
        <div className={`chrome-integration-mark chrome-integration-mark--${status.aggregate}`}>
          <ChromeLogoIcon size={20} />
        </div>
        <div>
          <strong>{aggregateLabel(status.aggregate, status.connection, t)}</strong>
          <p>{aggregateDescription(status.aggregate, t)}</p>
        </div>
        <button
          className="chrome-refresh-button"
          type="button"
          aria-label={t('chrome.refreshStatus')}
          disabled={busy}
          onClick={() => void integration.refresh()}
        >
          <RefreshCcw size={14} />
        </button>
      </section>

      <section className="settings-panel chrome-integration-status-grid" aria-label={t('chrome.components')}>
        <StatusRow label={t('chrome.extension')} state={status.extension} t={t} />
        <StatusRow label={t('chrome.bridge')} state={status.bridge} t={t} />
        <StatusRow label={t('chrome.cliMcp')} state={status.mcp} t={t} />
        <ConnectionRow label={t('chrome.connection')} state={status.connection} t={t} />
      </section>

      {status.panelState === 'unknown' && (
        <section className="settings-panel chrome-panel-notice" role="note">
          <PanelRightOpen size={16} aria-hidden="true" />
          <div>
            <strong>{t('chrome.panel.noticeTitle')}</strong>
            <p>{t('chrome.panel.noticeBody')}</p>
            <p className="chrome-panel-notice-steps">{t('chrome.panel.noticeSteps')}</p>
          </div>
        </section>
      )}

      <section
        className="settings-panel chrome-identity-panel"
        aria-label={t('chrome.identityAndCli')}
      >
        <div className="settings-row chrome-identity-row">
          <UserRound size={16} />
          <div>
            <strong>{t('chrome.accountLogin')}</strong>
            <p>{t('chrome.accountLoginBody')}</p>
          </div>
        </div>
        <div className="settings-row chrome-identity-row">
          <PlugZap size={16} />
          <div>
            <strong>{t('chrome.cliConnection')}</strong>
            <p>{t('chrome.cliConnectionBody')}</p>
          </div>
        </div>
      </section>

      <section className="settings-panel chrome-integration-actions-panel">
        <div className="settings-row">
          <PlugZap size={16} />
          <div>
            <strong>{t('chrome.actions')}</strong>
            <p>{t('chrome.actionsBody')}</p>
          </div>
        </div>

        <div className="settings-row chrome-development-panel">
          <ShieldCheck size={16} />
          <div style={{ flex: 1 }}>
            <strong>{t('chrome.developmentId')}</strong>
            <p>{t('chrome.developmentIdBody')}</p>
            <input
              aria-label={t('chrome.developmentId')}
              className={!integration.developmentIdValid ? 'is-invalid' : ''}
              value={integration.developmentExtensionId}
              placeholder={t('chrome.developmentIdPlaceholder')}
              spellCheck={false}
              onChange={event => integration.setDevelopmentExtensionId(event.target.value)}
            />
            {!integration.developmentIdValid && (
              <p className="chrome-integration-error">{t('chrome.error.chrome_extension_id_invalid')}</p>
            )}
          </div>
        </div>

        <div className="chrome-integration-actions">
          {status.storeUrlAvailable && (
            <button type="button" disabled={busy} onClick={() => void integration.openStore()}>
              {t('chrome.installExtension')}
            </button>
          )}
          {status.canConfigure && (
            <button
              className="button-primary"
              type="button"
              disabled={busy || !integration.developmentIdValid}
              onClick={() => void integration.configure()}
            >
              {integration.activeAction === 'configure' ? t('chrome.configuring') : t('chrome.configure')}
            </button>
          )}
          {status.canRepair && (
            <button type="button" disabled={busy || !integration.developmentIdValid} onClick={() => void integration.repair()}>
              {integration.activeAction === 'repair' ? t('chrome.repairing') : t('chrome.repair')}
            </button>
          )}
          {canTest && (
            <button type="button" disabled={busy} onClick={() => void integration.testConnection()}>
              {integration.activeAction === 'test' ? t('chrome.testing') : t('chrome.test')}
            </button>
          )}
          {status.canRemove && (
            <button className="danger-soft-button" type="button" disabled={busy} onClick={() => setConfirmingRemoval(true)}>
              <Trash2 size={14} />
              {t('chrome.remove')}
            </button>
          )}
        </div>
        {integration.lastTestPassed !== undefined && (
          <p className={integration.lastTestPassed ? 'chrome-test-result is-success' : 'chrome-test-result is-error'}>
            {integration.lastTestPassed ? t('chrome.testPassed') : t('chrome.testFailed')}
          </p>
        )}
        {integration.error && (
          <p className="chrome-integration-error">{localizedError(integration.error, t)}</p>
        )}
      </section>

      {confirmingRemoval && (
        <div className="modal-backdrop" onPointerDown={event => event.target === event.currentTarget && setConfirmingRemoval(false)}>
          <div className="confirm-modal confirm-dialog t-modal is-open" role="alertdialog" aria-modal="true">
            <div className="confirm-dialog-head">
              <span className="confirm-dialog-icon" aria-hidden="true"><CircleAlert size={17} /></span>
              <div>
                <h2>{t('chrome.removeTitle')}</h2>
                <p>{t('chrome.removeBody')}</p>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setConfirmingRemoval(false)}>{t('common.cancel')}</button>
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  setConfirmingRemoval(false)
                  void integration.remove()
                }}
              >
                {t('chrome.remove')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function StatusRow({ label, state, t }: { label: string; state: ChromeComponentState; t: Translator }) {
  return (
    <div className="chrome-status-row" data-testid="chrome-status-row">
      <StatusIcon state={state} />
      <span>{label}</span>
      <strong className={`chrome-status-value is-${state}`}>{t(`chrome.component.${state}`)}</strong>
    </div>
  )
}

function ConnectionRow({ label, state, t }: { label: string; state: ChromeConnectionState; t: Translator }) {
  return (
    <div className="chrome-status-row" data-testid="chrome-status-row">
      <StatusIcon state={state === 'connected' ? 'managed' : state === 'waitingForChrome' ? 'missing' : 'invalid'} />
      <span>{label}</span>
      <strong className={`chrome-status-value is-${state}`}>{t(`chrome.connection.${state}`)}</strong>
    </div>
  )
}

function StatusIcon({ state }: { state: ChromeComponentState }) {
  if (state === 'managed') return <CheckCircle2 size={15} aria-hidden="true" />
  if (state === 'missing') return <CircleDashed size={15} aria-hidden="true" />
  return <CircleAlert size={15} aria-hidden="true" />
}

function aggregateLabel(aggregate: ChromeIntegrationAggregate, connection: ChromeConnectionState, t: Translator) {
  if (aggregate === 'ready' && connection === 'waitingForChrome') return t('chrome.aggregate.waiting')
  return t(`chrome.aggregate.${aggregate}`)
}

function aggregateDescription(aggregate: ChromeIntegrationAggregate, t: Translator) {
  return t(`chrome.aggregate.${aggregate}Body`)
}

function localizedError(code: string | undefined, t: Translator) {
  if (!code) return t('chrome.error.generic')
  const translated = t(`chrome.error.${code}`)
  return translated === `chrome.error.${code}` ? t('chrome.error.generic') : translated
}
