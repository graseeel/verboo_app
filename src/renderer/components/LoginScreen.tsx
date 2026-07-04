import { AtSign, Bug, CheckCircle2, ExternalLink, KeyRound, LogIn, Mail, Phone, RefreshCw, ShieldAlert, UserPlus } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { CliAuthStatus, CredentialStatus, LanguageCode, LoginResult, ModelDiscoveryResult } from '../../shared/types'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'
import wordmarkUrl from '../../../assets/branding/verboo-wordmark.png'
import { LanguageSelector } from '../features/language/LanguageSelector'
import { useI18n } from '../i18n'

type LoginScreenProps = {
  language: LanguageCode
  noticeAccepted: boolean
  checking: boolean
  authError?: string
  credentials: CredentialStatus
  cliAuth: CliAuthStatus
  modelResult: ModelDiscoveryResult
  staySignedIn: boolean
  onStartLogin: () => Promise<LoginResult> | LoginResult
  onOpenDashboard: () => void
  onOpenSignup: () => void
  onCheckExistingAuth: () => Promise<boolean>
  onSaveApiKey: (apiKey: string) => Promise<boolean>
  onLanguageChange: (language: LanguageCode) => Promise<void> | void
  onStaySignedInChange: (staySignedIn: boolean) => Promise<void> | void
  onAcceptNotice: () => void
  onOpenFeedback: () => void
}

export function LoginScreen({
  language,
  noticeAccepted,
  checking,
  authError,
  credentials,
  cliAuth,
  modelResult,
  staySignedIn,
  onStartLogin,
  onOpenDashboard,
  onOpenSignup,
  onCheckExistingAuth,
  onSaveApiKey,
  onLanguageChange,
  onStaySignedInChange,
  onAcceptNotice,
  onOpenFeedback,
}: LoginScreenProps) {
  const { t } = useI18n()
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | undefined>()

  async function startLogin() {
    setStatusMessage(t('login.openingCli'))
    try {
      const result = await onStartLogin()
      setStatusMessage(result.ok ? t('login.cliStarted') : t('login.cliStartFailed'))
    } catch {
      // Never leave the button stuck on "opening login": surface the failure so
      // the user can act on it instead of watching an infinite spinner.
      setStatusMessage(t('login.cliStartFailed'))
    }
  }

  async function submitApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = apiKey.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const valid = await onSaveApiKey(trimmed)
      if (valid) {
        setApiKey('')
        setStatusMessage(t('login.apiKeyValidated'))
      } else {
        setStatusMessage(t('login.apiKeyInvalid'))
      }
    } finally {
      setSaving(false)
    }
  }

  async function checkExistingAuth() {
    setStatusMessage(t('login.checkingSession'))
    const valid = await onCheckExistingAuth()
    setStatusMessage(valid ? t('login.sessionValid') : t('login.sessionInvalid'))
  }

  if (!noticeAccepted) {
    return (
      <main className="login-screen">
        <section className="login-panel development-panel" aria-label={t('login.developmentAria')}>
          <div className="login-language-row">
            <LanguageSelector value={language} onChange={next => void onLanguageChange(next)} compact />
          </div>
          <div className="login-brand">
            <img className="login-mascot" src={mascotUrl} alt="" />
            <img className="login-wordmark" src={wordmarkUrl} alt="Verboo" />
          </div>

          <div className="login-copy">
            <p className="login-eyebrow">{t('login.importantNotice')}</p>
            <h1>{t('login.developmentTitle')}</h1>
            <p>{t('login.developmentBody')}</p>
          </div>

          <div className="development-warning">
            <ShieldAlert size={20} />
            <div>
              <strong>{t('login.warningTitle')}</strong>
              <p>{t('login.warningBody')}</p>
            </div>
          </div>

          <div className="contact-list" aria-label={t('login.supportContacts')}>
            <a href="mailto:grasel.moura05@gmail.com">
              <Mail size={16} />
              grasel.moura05@gmail.com
            </a>
            <a href="tel:+5547999479438">
              <Phone size={16} />
              +55 (47) 9 9947-9438
            </a>
            <a href="https://x.com/grrL_" target="_blank" rel="noreferrer">
              <AtSign size={16} />
              @grrL_
            </a>
          </div>

          <button className="secondary-action wide-action development-feedback-button" type="button" onClick={onOpenFeedback}>
            <Bug size={17} />
            {t('login.reportIssue')}
          </button>

          <button className="primary-action wide-action" type="button" onClick={onAcceptNotice}>
            <CheckCircle2 size={18} />
            {t('login.acceptNotice')}
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="login-screen">
      <section className="login-panel" aria-label={t('login.mainAria')}>
        <div className="login-language-row">
          <LanguageSelector value={language} onChange={next => void onLanguageChange(next)} compact />
        </div>
        <div className="login-brand">
          <img className="login-mascot" src={mascotUrl} alt="" />
          <img className="login-wordmark" src={wordmarkUrl} alt="Verboo" />
        </div>

        <div className="login-copy">
          <h1>{t('login.title')}</h1>
          <p>{t('login.body')}</p>
        </div>

        <label className="login-remember">
          <input
            type="checkbox"
            checked={staySignedIn}
            onChange={event => {
              void onStaySignedInChange(event.target.checked)
            }}
          />
          <span>
            <strong>{t('login.staySignedIn')}</strong>
            <small>{t('login.staySignedInHelp')}</small>
          </span>
        </label>

        <div className="login-actions">
          <button className="primary-action" type="button" onClick={startLogin} disabled={checking}>
            <LogIn size={18} />
            {t('login.cliLogin')}
          </button>
          <button className="secondary-action" type="button" onClick={checkExistingAuth} disabled={checking}>
            <RefreshCw size={17} />
            {t('login.alreadyAuthenticated')}
          </button>
        </div>

        <div className="login-actions secondary-grid">
          <button className="secondary-action" type="button" onClick={onOpenSignup}>
            <UserPlus size={17} />
            {t('login.createAccount')}
          </button>
          <button className="secondary-action" type="button" onClick={onOpenDashboard}>
            <ExternalLink size={17} />
            {t('login.openDashboard')}
          </button>
          <button className="secondary-action login-feedback-button" type="button" onClick={onOpenFeedback}>
            <Bug size={17} />
            {t('login.reportIssue')}
          </button>
        </div>

        {(statusMessage || checking) && (
          <div className="login-note">{checking ? t('login.checking') : statusMessage}</div>
        )}

        {(authError || modelResult.error) && (
          <div className="login-warning">{authError ?? modelResult.error}</div>
        )}

        <form className="api-login-form" onSubmit={submitApiKey}>
          <label htmlFor="api-key">
            <KeyRound size={16} />
            {t('login.apiKeyLabel')}
          </label>
          <div className="api-login-row">
            <input
              id="api-key"
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
              placeholder={credentials.hasApiKey ? t('login.apiKeyConfigured', { hint: credentials.apiKeyHint }) : t('login.apiKeyPlaceholder')}
              type="password"
            />
            <button type="submit" disabled={!apiKey.trim() || saving || checking}>
              {saving ? t('common.validating') : t('common.save')}
            </button>
          </div>
          <p>{t('login.apiKeyHelp')}</p>
        </form>
      </section>
    </main>
  )
}
