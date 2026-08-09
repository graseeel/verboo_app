import { Bug, Check, Copy, ExternalLink, KeyRound, LogIn, RefreshCw, UserPlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { CliAuthStatus, CredentialStatus, LanguageCode, LoginEvent, LoginResult, ModelDiscoveryResult } from '../../shared/types'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'
import wordmarkUrl from '../../../assets/branding/verboo-wordmark.png'
import { LanguageSelector } from '../features/language/LanguageSelector'
import { useI18n } from '../i18n'

type LoginScreenProps = {
  language: LanguageCode
  checking: boolean
  authError?: string
  /** T5: raw cause of a rejected validateAccess, shown behind a
   *  "Show technical details" toggle inside the login warning. */
  authErrorDetail?: string
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
  onOpenFeedback: () => void
  /**
   * A1: called when a `login:event` with kind `complete` reports success
   * (`ok !== false`). The parent re-validates against the real backend
   * state and unlocks the app. Failure completions (`ok === false`) are
   * rendered locally with their specific cause and do NOT bubble.
   */
  onLoginComplete?: (event: LoginEvent) => void
}

/**
 * A1: CLI login progress, driven by the `login:event` Tauri channel —
 * NOT by the start_cli_login invoke return. The Rust command is
 * non-blocking (returns in <1s after spawn; cli_service.rs A1), so the
 * invoke result only means "spawned". Progress states:
 *   idle            → no login in flight; button enabled.
 *   starting        → invoke in flight (<1s by contract).
 *   awaitingBrowser → spawned; waiting for the `url` event / browser.
 *   urlReady        → `url` event arrived; URL visible + copyable (the
 *                     Linux fix: the browser may never open by itself).
 *   failed          → error kind / spawn failure / ok:false completion;
 *                     carries the SPECIFIC cause, button re-enabled.
 */
type CliLoginFlow =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'awaitingBrowser' }
  | { phase: 'urlReady'; url: string }
  | { phase: 'failed'; message: string }

export function LoginScreen({
  language,
  checking,
  authError,
  authErrorDetail,
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
  onOpenFeedback,
  onLoginComplete,
}: LoginScreenProps) {
  const { t } = useI18n()
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | undefined>()
  // A1: CLI login flow, event-driven (see CliLoginFlow above).
  const [cliLogin, setCliLogin] = useState<CliLoginFlow>({ phase: 'idle' })
  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Latest-value refs so the login:event listener subscribes ONCE and
  // still sees the current translator/callback (App recreates both per
  // render; resubscribing every render would leak listeners).
  const tRef = useRef(t)
  tRef.current = t
  const onLoginCompleteRef = useRef(onLoginComplete)
  onLoginCompleteRef.current = onLoginComplete

  // A1: the `login:event` Tauri channel (name literally `login:event`,
  // colon included). Payload LoginEvent: kind arrives LOWERCASE
  // ('url' | 'complete' | 'error' — LoginEventKind uses serde
  // rename_all = "lowercase", types.rs:609, a DIFFERENT attribute from
  // the struct family's camelCase), and url/message/ok/status use
  // skip_serializing_if Option::is_none — absent keys arrive as
  // undefined: treat absence, not null.
  useEffect(() => {
    let unlistenFn: (() => void) | undefined
    const unlistenPromise = listen<LoginEvent>('login:event', (event) => {
      const payload = event.payload
      switch (payload.kind) {
        case 'url':
          // Absent url key (skip_serializing_if): keep waiting — never
          // render a fake/empty link.
          if (payload.url) {
            setCopied(false)
            setCliLogin({ phase: 'urlReady', url: payload.url })
          }
          break
        case 'complete':
          if (payload.ok === false) {
            // Failure completion: the SPECIFIC cause (CLI stdout/stderr)
            // must reach the screen — never a bare generic. Guarded to
            // in-flight phases so a late completion after the user
            // cancelled can't resurrect an error on an idle screen.
            setCliLogin(current =>
              current.phase === 'idle'
                ? current
                : { phase: 'failed', message: payload.message ?? tRef.current('login.cliStartFailed') },
            )
          } else {
            // Success: hand off to the parent, which re-validates the
            // real backend state and unlocks the app. Return to idle —
            // the `checking` prop shows the validation progress.
            setCliLogin({ phase: 'idle' })
            onLoginCompleteRef.current?.(payload)
          }
          break
        case 'error':
          setCliLogin(current =>
            current.phase === 'idle'
              ? current
              : { phase: 'failed', message: payload.message ?? tRef.current('login.cliStartFailed') },
          )
          break
      }
    })
    unlistenPromise.then(fn => { unlistenFn = fn }).catch(() => {})
    return () => {
      unlistenFn?.()
      // Same drain as usePlugins: if setup hasn't resolved when cleanup
      // runs, drop the listener as soon as it attaches so nothing
      // dangles after unmount.
      unlistenPromise.then(fn => fn()).catch(() => {})
    }
  }, [])

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
    }
  }, [])

  async function startLogin() {
    setCopied(false)
    setCliLogin({ phase: 'starting' })
    try {
      const result = await onStartLogin()
      // A1: result.ok means "spawned in background" (the invoke returns
      // in <1s by Rust contract), NOT "authenticated". Progress arrives
      // via login:event. The url event may already have arrived on a
      // fast CLI — only advance from 'starting', never clobber a phase
      // set by an event.
      if (result.ok) {
        setCliLogin(current => (current.phase === 'starting' ? { phase: 'awaitingBrowser' } : current))
      } else {
        setCliLogin({ phase: 'failed', message: result.message || t('login.cliStartFailed') })
      }
    } catch (err) {
      // Tauri invoke rejections carry the Rust Err string — the SPECIFIC
      // cause (e.g. "Falha ao iniciar login do CLI Verboo: spawn
      // ENOENT"). Surface it so the user can act instead of watching an
      // infinite spinner — the button must NEVER get stuck on
      // "opening login".
      const message =
        typeof err === 'string'
          ? err
          : err instanceof Error
            ? err.message
            : t('login.cliStartFailed')
      setCliLogin({ phase: 'failed', message })
    }
  }

  function cancelCliLogin() {
    // UI-only cancel: we cannot kill the CLI process from the renderer
    // (no such command), but the user gets an escape hatch out of the
    // waiting state. A late ok:false completion is ignored while idle
    // (guarded in the listener); a late success still unlocks — if the
    // user did authenticate, that is the truth.
    setCliLogin({ phase: 'idle' })
  }

  async function copyLoginUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
      copyResetRef.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard unavailable (permission / context): the URL stays in
      // a selectable read-only input, so manual copy still works.
      // Never fake a success.
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
    try {
      const valid = await onCheckExistingAuth()
      // The parent owns the FAILURE message (authError prop → .login-warning):
      // setting the same session-invalid text locally rendered it TWICE,
      // stacked (field photo). Success keeps its local confirmation.
      setStatusMessage(valid ? t('login.sessionValid') : undefined)
    } catch {
      // T5: if validateAccess rejects, the parent's catch surfaces the
      // banner (authError + authErrorDetail). Locally we must END the
      // "verificando" state regardless — without this, the pre-await
      // setStatusMessage is the last line that ran and "Verificando
      // sessão local…" sticks forever (field photo M4).
      setStatusMessage(undefined)
    }
  }

  return (
    <main className="login-screen">
      {/* T-C: window drag lives on this dedicated top strip, NOT on the
          whole screen — the screen is a scroll container now, and a full-
          surface drag region swallows the scroll gesture and clicks. */}
      <div className="login-drag-strip" aria-hidden="true" />
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
          <button
            className="primary-action"
            type="button"
            onClick={startLogin}
            // A1: disabled while a CLI login is in flight (spawning a
            // second CLI would double the flow) — but ALWAYS re-enabled
            // on idle/failed so the button can never get stuck.
            disabled={
              checking ||
              cliLogin.phase === 'starting' ||
              cliLogin.phase === 'awaitingBrowser' ||
              cliLogin.phase === 'urlReady'
            }
          >
            <LogIn size={18} />
            {t('login.cliLogin')}
          </button>
          <button className="secondary-action" type="button" onClick={checkExistingAuth} disabled={checking}>
            <RefreshCw size={17} />
            {t('login.alreadyAuthenticated')}
          </button>
        </div>

        {/* A1: in-flight progress — shimmer text (transitions-dev #15),
            a live "still working" signal without a spinner. The URL
            block is the Linux fix (issue #59): when the browser does
            not open by itself, the user copies the link by hand. */}
        {(cliLogin.phase === 'starting' || cliLogin.phase === 'awaitingBrowser') && (
          <div className="login-progress" role="status">
            <span className="t-shimmer" data-text={cliLogin.phase === 'starting' ? t('login.openingCli') : t('login.awaitingBrowser')}>
              {cliLogin.phase === 'starting' ? t('login.openingCli') : t('login.awaitingBrowser')}
            </span>
            {cliLogin.phase === 'awaitingBrowser' && (
              <button className="login-cancel" type="button" onClick={cancelCliLogin}>
                {t('login.cancelLogin')}
              </button>
            )}
          </div>
        )}

        {cliLogin.phase === 'urlReady' && (
          <div className="login-url-block" role="status">
            <p className="login-url-help">{t('login.urlReadyHelp')}</p>
            <div className="login-url-row">
              <input
                className="login-url-input"
                readOnly
                value={cliLogin.url}
                aria-label={t('login.urlAria')}
                onFocus={event => event.target.select()}
                onClick={event => event.currentTarget.select()}
              />
              <button
                className="secondary-action login-copy-button"
                type="button"
                onClick={() => void copyLoginUrl(cliLogin.url)}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? t('login.copied') : t('login.copyLink')}
              </button>
            </div>
            <a className="login-open-link" href={cliLogin.url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} />
              {t('login.openLink')}
            </a>
            <div className="login-progress">
              <span className="t-shimmer" data-text={t('login.waitingForAuth')}>
                {t('login.waitingForAuth')}
              </span>
              <button className="login-cancel" type="button" onClick={cancelCliLogin}>
                {t('login.cancelLogin')}
              </button>
            </div>
          </div>
        )}

        {/* A1: failure with the SPECIFIC cause. The shake
            (transitions-dev #12) is the percussive "this failed" hint;
            key={message} remounts the block per new failure so the
            animation replays without JS reflow. The snippet's
            auto-revert is deliberately NOT installed — the cause must
            persist until the user retries. */}
        {cliLogin.phase === 'failed' && (
          <div className="login-warning t-input is-shaking" key={cliLogin.message} role="alert">
            {cliLogin.message}
          </div>
        )}

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
          <div className="login-warning">
            {authError ?? modelResult.error}
            {authErrorDetail && (
              <details className="login-warning-details">
                <summary>{t('transcript.showTechnicalDetails')}</summary>
                <pre>{authErrorDetail}</pre>
              </details>
            )}
          </div>
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
