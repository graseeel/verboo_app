import { Check, Copy, ExternalLink, KeyRound, LogIn } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { BootstrapStage, CliAuthStatus, CredentialStatus, LanguageCode, LoginEvent, LoginResult, ModelDiscoveryResult } from '../../shared/types'
import wordmarkUrl from '../../../assets/branding/verboo-wordmark.png'
import { LanguageSelector } from '../features/language/LanguageSelector'
import { useI18n } from '../i18n'
import { CliBootstrapCard } from './CliBootstrapGate'
import { credentialStoreI18nKey, invokeErrorText } from '../features/auth/credentialStoreMessage'

/** authoritative CLI bootstrap state as seen by THIS surface. While
 *  it is not 'ready', CLI login actions are latched (the runtime may not
 *  exist yet — a healthy first-boot download must never surface as an
 *  error) and the preparation card replaces the CLI controls. Non-CLI
 *  paths (API key, language, signup/dashboard/feedback) stay available. */
export type LoginCliBootstrap = {
  phase: 'checking' | 'installing' | 'error' | 'success' | 'ready'
  stage: BootstrapStage
  percent?: number
  error?: string
}

/**
 * PA-37g: stable auth-error contract. The PRODUCER (App.validateAccess /
 * logout) classifies the failure once with a stable `kind`; the UI never
 * pattern-matches the rendered (translated) text — a language switch
 * materializes `message` in the old language, and any text equality check
 * breaks (the Sonda's counterfactual). `kind` is the only discriminator.
 *   no-session → the EMPTY STATE: nothing to validate against. Neutral
 *                note, never a red banner.
 *   error      → a REAL failure (expired token, network, rejected
 *                validation, failed logout). The single inline banner.
 */
export type AuthErrorState = {
  kind: 'no-session' | 'error'
  /** Display-only text, materialized in the language active WHEN the error
   *  was produced — may lag a language switch; never use as a discriminator. */
  message: string
}

type LoginScreenProps = {
  language: LanguageCode
  checking: boolean
  authError?: AuthErrorState
  /** T5: raw cause of a rejected validateAccess, shown behind a
   *  "Show technical details" toggle inside the login warning. */
  authErrorDetail?: string
  credentials: CredentialStatus
  cliAuth: CliAuthStatus
  modelResult: ModelDiscoveryResult
  staySignedIn: boolean
  onStartLogin: (flowId?: number) => Promise<LoginResult> | LoginResult
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
  onLoginComplete?: (event: LoginEvent) => Promise<boolean> | boolean
  /** REQUIRED. Authoritative CLI bootstrap state derived by App from the
   *  update snapshot; while it is not 'ready', the CLI login actions are
   *  latched and the preparation card replaces them. */
  cliBootstrap: LoginCliBootstrap
  /** REQUIRED. Invoked by the card's Retry button on a bootstrap error. */
  onCliBootstrapRetry: () => void
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

type UserAuthAction = 'existing-session' | 'cli-login' | 'api-key'
type UserAuthActionState =
  | { id: number; source: UserAuthAction; phase: 'pending' }
  | { id: number; source: UserAuthAction; phase: 'failed'; detail?: string }

// PA-45b: flow ids must outlive LoginScreen mounts because a cancelled
// native CLI process can emit after auth unmounts this screen and logout
// mounts it again. Date.now() seeds reloads; the module counter keeps ids
// strictly monotonic across mounts while remaining a JS-safe Rust u64.
let lastUserAuthActionId = Date.now()

function allocateUserAuthActionId(): number {
  lastUserAuthActionId = Math.max(Date.now(), lastUserAuthActionId + 1)
  return lastUserAuthActionId
}

/**
 * Issue #71: Windows Git onboarding gate. The CLI login needs Git for
 * Windows (git-bash); when check_windows_login_prereqs reports
 * gitAvailable=false the login is HELD and this dialog flow opens:
 *   hidden        → no gate open.
 *   prompt        → why + the two contract options (install
 *                   automatically / manual instructions).
 *   installing    → install_git_windows in flight (winget, up to 10min
 *                   by contract — the dialog cannot be dismissed).
 *   installFailed → install or the post-install re-check failed;
 *                   summarized log + the manual path.
 *   manual        → manual install instructions.
 */
type GitGateFlow =
  | { phase: 'hidden' }
  | { phase: 'prompt' }
  | { phase: 'installing' }
  | { phase: 'installFailed'; log: string }
  | { phase: 'manual' }

/** Issue #71 fallback: the CLI's raw cause names git-bash when Git for
 *  Windows is missing. Those causes map to the onboarding dialog
 *  instead of the bare error banner. */
function isGitBashCause(message: string | undefined): boolean {
  return typeof message === 'string' && message.toLowerCase().includes('git-bash')
}

/** The winget log can hold minutes of output — the dialog shows the
 *  TAIL (last non-empty lines), where the actual failure reason lives. */
function summarizeGitInstallLog(log: string): string {
  const lines = log
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
  return lines.slice(-6).join('\n')
}

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
  cliBootstrap,
  onCliBootstrapRetry,
}: LoginScreenProps) {
  const { t } = useI18n()
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | undefined>()
  const [userAction, setUserAction] = useState<UserAuthActionState | undefined>()
  const cliUserActionIdRef = useRef<number | undefined>(undefined)
  // PA-37: progressive disclosure — the API key path SWAPS the central
  // block instead of stacking under it.
  const [apiMode, setApiMode] = useState(false)
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null)
  const useApiKeyButtonRef = useRef<HTMLButtonElement | null>(null)
  const wasApiModeRef = useRef(false)
  // A1: CLI login flow, event-driven (see CliLoginFlow above).
  const [cliLogin, setCliLogin] = useState<CliLoginFlow>({ phase: 'idle' })
  // Issue #71: Windows Git onboarding gate (see GitGateFlow above).
  const [gitGate, setGitGate] = useState<GitGateFlow>({ phase: 'hidden' })
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
  // undefined: treat absence, not null. flowId is also optional so an
  // older native build can keep using the legacy uncorrelated channel.
  useEffect(() => {
    let unlistenFn: (() => void) | undefined
    const unlistenPromise = listen<LoginEvent>('login:event', (event) => {
      const payload = event.payload
      // PA-45b: identified events belong only to the active CLI action.
      // Absence stays backward-compatible with older native builds.
      if (payload.flowId !== undefined && payload.flowId !== cliUserActionIdRef.current) return
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
            const message = payload.message ?? tRef.current('login.cliStartFailed')
            // Failure completion: the SPECIFIC cause (CLI stdout/stderr)
            // must reach the screen — never a bare generic. Guarded to
            // in-flight phases so a late completion after the user
            // cancelled can't resurrect an error on an idle screen.
            setCliLogin(current =>
              current.phase === 'idle'
                ? current
                : { phase: 'failed', message },
            )
            if (isGitBashCause(message)) finishUserAction(cliUserActionIdRef.current)
            else failUserAction(cliUserActionIdRef.current, 'cli-login', message)
            cliUserActionIdRef.current = undefined
          } else {
            // Success: hand off to the parent, which re-validates the
            // real backend state and unlocks the app. Return to idle —
            // the `checking` prop shows the validation progress.
            setCliLogin({ phase: 'idle' })
            const actionId = cliUserActionIdRef.current
            cliUserActionIdRef.current = undefined
            try {
              const validation = onLoginCompleteRef.current?.(payload)
              if (validation === undefined) {
                finishUserAction(actionId)
              } else {
                void Promise.resolve(validation).then(valid => {
                  if (valid) finishUserAction(actionId)
                  else failUserAction(actionId, 'cli-login')
                }).catch(error => {
                  failUserAction(actionId, 'cli-login', error)
                })
              }
            } catch (error) {
              failUserAction(actionId, 'cli-login', error)
            }
          }
          break
        case 'error':
          const message = payload.message ?? tRef.current('login.cliStartFailed')
          setCliLogin(current =>
            current.phase === 'idle'
              ? current
              : { phase: 'failed', message },
          )
          if (isGitBashCause(message)) finishUserAction(cliUserActionIdRef.current)
          else failUserAction(cliUserActionIdRef.current, 'cli-login', message)
          cliUserActionIdRef.current = undefined
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

  // PA-37: focus follows the central-block swap — into the key field on
  // entry, back to the "Use an API key" button on exit (keyboard users
  // must never lose their place when the block they used disappears).
  useEffect(() => {
    if (apiMode) {
      apiKeyInputRef.current?.focus()
    } else if (wasApiModeRef.current) {
      useApiKeyButtonRef.current?.focus()
    }
    wasApiModeRef.current = apiMode
  }, [apiMode])

  // Issue #71 fallback: a git-bash cause arriving over login:event (the
  // pre-flight detection missed) maps to the SAME onboarding dialog
  // instead of the raw banner — the banner render below also suppresses
  // git-bash causes, so the raw message never paints.
  useEffect(() => {
    if (cliLogin.phase === 'failed' && isGitBashCause(cliLogin.message)) {
      setCliLogin({ phase: 'idle' })
      setGitGate({ phase: 'prompt' })
    }
  }, [cliLogin])

  // Escape dismisses the gate dialog except while winget is running —
  // a half-watched install is worse than a wait (same dismissal rule as
  // the plugin install modal).
  useEffect(() => {
    if (gitGate.phase === 'hidden' || gitGate.phase === 'installing') return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setGitGate({ phase: 'hidden' })
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [gitGate.phase])

  // Issue #71: ask the native side whether Git is usable BEFORE spawning
  // the CLI login. Fail-OPEN on any detection hiccup (older backend,
  // bridge absent, invoke rejection): a broken detector must never block
  // sign-in — the git-bash fallback above still catches a real failure.
  async function gitAvailableForLogin(): Promise<boolean> {
    try {
      const prereqs = await window.verboo?.checkWindowsLoginPrereqs?.()
      return prereqs?.gitAvailable ?? true
    } catch {
      return true
    }
  }

  function beginUserAction(source: UserAuthAction): number {
    const id = allocateUserAuthActionId()
    cliUserActionIdRef.current = undefined
    setCliLogin({ phase: 'idle' })
    setStatusMessage(undefined)
    setUserAction({ id, source, phase: 'pending' })
    return id
  }

  function finishUserAction(id: number | undefined) {
    if (id === undefined) return
    setUserAction(current => current?.id === id ? undefined : current)
  }

  function failUserAction(id: number | undefined, source: UserAuthAction, error?: unknown) {
    if (id === undefined) return
    const detail = invokeErrorText(error)
    setUserAction(current => current?.id === id ? { id, source, phase: 'failed', detail } : current)
  }

  function clearUserAction() {
    allocateUserAuthActionId()
    cliUserActionIdRef.current = undefined
    setCliLogin({ phase: 'idle' })
    setStatusMessage(undefined)
    setUserAction(undefined)
  }

  /** Routes a login failure: git-bash causes open the Git onboarding
   *  dialog (issue #71); everything else keeps the specific-cause banner. */
  function failCliLogin(message: string) {
    const actionId = cliUserActionIdRef.current
    if (isGitBashCause(message)) {
      setCliLogin({ phase: 'idle' })
      finishUserAction(actionId)
      cliUserActionIdRef.current = undefined
      setGitGate({ phase: 'prompt' })
    } else {
      setCliLogin({ phase: 'failed', message })
      failUserAction(actionId, 'cli-login', message)
    }
  }

  async function installGitAutomatically() {
    setGitGate({ phase: 'installing' })
    try {
      const result = await window.verboo.installGitWindows()
      // Contract: after the installer exits, RE-CHECK — only git truly
      // resolvable moves on and the login proceeds automatically. A green
      // exit with git still missing (e.g. PATH not refreshed) falls
      // through to the failure state with the log tail.
      const prereqs = await window.verboo.checkWindowsLoginPrereqs()
      if (result.success && prereqs.gitAvailable) {
        setGitGate({ phase: 'hidden' })
        void startLogin()
      } else {
        setGitGate({ phase: 'installFailed', log: result.log })
      }
    } catch (err) {
      const log =
        typeof err === 'string' ? err : err instanceof Error ? err.message : ''
      setGitGate({ phase: 'installFailed', log })
    }
  }

  function closeGitGate() {
    setGitGate({ phase: 'hidden' })
  }

  async function startLogin() {
    // Latched exactly like checkExistingAuth: a bootstrap window that opens
    // mid-flow (banner Retry, Git onboarding finish) cannot spawn the CLI.
    if (cliBootstrap.phase !== 'ready') return
    const actionId = beginUserAction('cli-login')
    cliUserActionIdRef.current = actionId
    setCopied(false)
    setCliLogin({ phase: 'starting' })
    // Issue #71: on Windows the CLI needs Git — gate BEFORE spawning.
    // Off-Windows the check reports gitAvailable=true, so the flow below
    // is byte-identical to before.
    if (!(await gitAvailableForLogin())) {
      setCliLogin({ phase: 'idle' })
      finishUserAction(actionId)
      cliUserActionIdRef.current = undefined
      setGitGate({ phase: 'prompt' })
      return
    }
    try {
      const result = await onStartLogin(actionId)
      // A1: result.ok means "spawned in background" (the invoke returns
      // in <1s by Rust contract), NOT "authenticated". Progress arrives
      // via login:event. The url event may already have arrived on a
      // fast CLI — only advance from 'starting', never clobber a phase
      // set by an event.
      if (result.ok) {
        setCliLogin(current => (current.phase === 'starting' ? { phase: 'awaitingBrowser' } : current))
      } else {
        failCliLogin(result.message || t('login.cliStartFailed'))
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
      failCliLogin(message)
    }
  }

  function cancelCliLogin() {
    // UI-only cancel: we cannot kill the CLI process from the renderer
    // (no such command), but the user gets an escape hatch out of the
    // waiting state. Identified late events are ignored once another
    // flow starts; events without flowId keep the legacy behavior for
    // compatibility with older native builds.
    setCliLogin({ phase: 'idle' })
    clearUserAction()
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
    const actionId = beginUserAction('api-key')
    setStatusMessage(undefined)
    setSaving(true)
    try {
      const valid = await onSaveApiKey(trimmed)
      if (valid) {
        setApiKey('')
        finishUserAction(actionId)
        setStatusMessage(t('login.apiKeyValidated'))
      } else {
        failUserAction(actionId, 'api-key')
      }
    } catch (error) {
      failUserAction(actionId, 'api-key', error)
    } finally {
      setSaving(false)
    }
  }

  async function checkExistingAuth() {
    // same latch as startLogin — a CLI re-validation during the
    // bootstrap window cannot succeed and must not surface as an error.
    if (cliBootstrap.phase !== 'ready') return
    const actionId = beginUserAction('existing-session')
    setStatusMessage(t('login.checkingSession'))
    try {
      const valid = await onCheckExistingAuth()
      if (valid) {
        finishUserAction(actionId)
        setStatusMessage(t('login.sessionValid'))
      } else {
        failUserAction(actionId, 'existing-session')
        setStatusMessage(undefined)
      }
    } catch (error) {
      failUserAction(actionId, 'existing-session', error)
      setStatusMessage(undefined)
    }
  }

  // ── PA-37 state rules (the heart of the redesign) ──────────────────────
  // 'No valid session' on first load is the EMPTY STATE, not an error — it
  // renders as a neutral note, never as a red banner. A REAL failure
  // renders ONE banner at a time, inline above the primary action, with a
  // retry; a long technical cause collapses to a summary + details toggle.
  // PA-37g: the discriminator is the STABLE `kind` from the producer —
  // never the translated message text (a language switch would break it).
  const cliFailureMessage =
    cliLogin.phase === 'failed' && !isGitBashCause(cliLogin.message) ? cliLogin.message : undefined
  const emptyStateNote =
    !cliFailureMessage && !userAction && authError?.kind === 'no-session'
      ? authError.message
      : undefined
  const failedUserAction = userAction?.phase === 'failed' ? userAction : undefined
  const actionStoreKey = credentialStoreI18nKey(failedUserAction?.detail)
  const userActionHeadline = failedUserAction
    ? failedUserAction.source === 'cli-login'
      ? t('login.cliLoginFailed')
      : failedUserAction.source === 'api-key'
        ? (actionStoreKey ? t(actionStoreKey) : t('login.apiKeyInvalid'))
        : actionStoreKey
          ? t(actionStoreKey)
          : authError?.kind === 'error'
            ? authError.message
            : t('login.sessionCheckFailed')
    : undefined
  // PA-47: the modelResult.error fallback (raw first-failure text) must
  // NEVER paint while a passive verification is in flight (`checking`) —
  // the boot retry clears the structured authError first, so during that
  // window the fallback would flash a red banner for ~1s on every cold
  // start (field video). The fallback only applies to CONCLUDED checks
  // without a structured authError; no-session never reaches it (the
  // emptyStateNote above owns that state).
  const authHeadline = !cliFailureMessage && !userAction && !emptyStateNote
    ? authError?.kind === 'error'
      ? authError.message
      : authError
        ? undefined
        : !checking
          ? modelResult.error
          : undefined
    : undefined
  const banner = cliFailureMessage
    ? { key: `cli:${cliFailureMessage}`, headline: t('login.cliLoginFailed'), detail: cliFailureMessage, retry: () => void startLogin() }
    : failedUserAction && userActionHeadline
      ? {
          key: `action:${failedUserAction.id}`,
          headline: userActionHeadline,
          detail: actionStoreKey ? undefined : (failedUserAction.detail ?? (authError?.kind === 'error' ? authErrorDetail : undefined)),
          retry: failedUserAction.source === 'api-key'
            ? undefined
            : failedUserAction.source === 'cli-login'
              ? () => void startLogin()
              : () => void checkExistingAuth(),
        }
      : authHeadline
      ? { key: `auth:${authHeadline}`, headline: authHeadline, detail: authErrorDetail, retry: () => void checkExistingAuth() }
      : undefined

  return (
    <main className="login-screen">
      {/* T-C: window drag lives on this dedicated top strip, NOT on the
          whole screen — the screen is a scroll container now, and a full-
          surface drag region swallows the scroll gesture and clicks.
          PA-47: the strip is the ONLY drag surface on this screen — App.tsx
          returns LoginScreen early, so the TopBar (data-tauri-drag-region
          deep) never exists here. The attribute (not the legacy
          -webkit-app-region) is what Tauri's bundled drag.js honors; the
          strip is 28px < the 32px screen padding, so it never covers the
          panel, the language selector, or the native traffic lights. */}
      <div className="login-drag-strip" data-tauri-drag-region="deep" aria-hidden="true" />
      <section className="login-panel" aria-label={t('login.mainAria')}>
        <div className="login-language-row">
          <LanguageSelector value={language} onChange={next => void onLanguageChange(next)} compact />
        </div>

        {/* PA-37: ONE logo — the wordmark already carries the mascot. */}
        <div className="login-brand">
          <img className="login-wordmark" src={wordmarkUrl} alt="Verboo" />
        </div>

        <div className="login-copy">
          <h1>{t('login.title')}</h1>
          <p>{t('login.subtitle')}</p>
        </div>

        {/* PA-37: the empty state is a neutral note — NEVER a red banner. */}
        {emptyStateNote && <p className="login-empty">{emptyStateNote}</p>}
        {credentialStoreI18nKey(credentials.warning) && (
          <p className="login-note" role="status">{t(credentialStoreI18nKey(credentials.warning)!)}</p>
        )}

        {/* PA-37/A1: ONE real failure at a time, inline above the primary,
            with a retry. The raw technical cause lives behind a details
            toggle — never bare on the surface. The shake (transitions-dev
            #12) replays per new failure via key remount; the auto-revert is
            deliberately NOT installed — the cause persists until the user
            retries. Issue #71: git-bash causes NEVER paint here — they open
            the Git onboarding dialog instead. */}
        {banner && (
          <div className="login-warning t-input is-shaking" key={banner.key} role="alert">
            <span className="login-warning-headline">{banner.headline}</span>
            {banner.detail && (
              <details className="login-warning-details">
                <summary>{t('transcript.showTechnicalDetails')}</summary>
                <pre>{banner.detail}</pre>
              </details>
            )}
            {banner.retry && (
              <button className="login-retry" type="button" onClick={banner.retry} disabled={checking}>
                {t('login.tryAgain')}
              </button>
            )}
          </div>
        )}

        {(statusMessage || checking) && (
          <div className="login-note" role="status">{checking ? t('login.checking') : statusMessage}</div>
        )}

        {/* PA-37: progressive disclosure — the API key path SWAPS the
            central block (it does not stack), with a way back. */}
        {apiMode ? (
          <form className="api-login-form" onSubmit={submitApiKey}>
            <label htmlFor="api-key">
              <KeyRound size={16} />
              {t('login.apiKeyLabel')}
            </label>
            <div className="api-login-row">
              <input
                ref={apiKeyInputRef}
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
            <button className="login-text-button login-back" type="button" onClick={() => setApiMode(false)}>
              {t('login.backToSignIn')}
            </button>
          </form>
        ) : (
          <>
            {/* while the CLI bootstrap is pending, the preparation
                card (same markup/animation as the post-login gate) replaces
                the CLI controls. Retry exists only on a real bootstrap
                error; API key and tertiary paths stay below, untouched. */}
            {cliBootstrap.phase !== 'ready' ? (
              <div
                className="login-cli-bootstrap"
                role={cliBootstrap.phase === 'error' ? 'alert' : 'status'}
                aria-live={cliBootstrap.phase === 'error' ? 'assertive' : 'polite'}
                aria-busy={cliBootstrap.phase === 'checking' || cliBootstrap.phase === 'installing'}
              >
                <CliBootstrapCard
                  phase={cliBootstrap.phase}
                  stage={cliBootstrap.stage}
                  percent={cliBootstrap.percent}
                  error={cliBootstrap.error}
                  actions={cliBootstrap.phase === 'error' && (
                    <button className="button primary" type="button" onClick={onCliBootstrapRetry}>
                      {t('cliBootstrap.retry')}
                    </button>
                  )}
                />
              </div>
            ) : (
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
              </div>
            )}

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

            {/* PA-37: the "Stay signed in" preference is a plain checkbox —
                no card, no description (the help text still lives in
                Settings, where the preference also exists). */}
            <label className="login-remember">
              <input
                type="checkbox"
                checked={staySignedIn}
                onChange={event => {
                  void onStaySignedInChange(event.target.checked)
                }}
              />
              <span>{t('login.staySignedIn')}</span>
            </label>

            <div className="login-secondary-row">
              <button
                className="login-text-button"
                type="button"
                onClick={checkExistingAuth}
                disabled={checking || cliBootstrap.phase !== 'ready'}
              >
                {t('login.alreadyAuthenticated')}
              </button>
              <span className="login-sep" aria-hidden="true">·</span>
              <button
                ref={useApiKeyButtonRef}
                className="login-text-button"
                type="button"
                onClick={() => {
                  clearUserAction()
                  setApiMode(true)
                }}
              >
                {t('login.useApiKey')}
              </button>
            </div>
          </>
        )}

        {/* PA-37: tertiary paths live in a quiet footer, out of the way of
            the sign-in decision. */}
        <footer className="login-footer">
          <button className="login-footer-link" type="button" onClick={onOpenSignup}>
            {t('login.createAccount')}
          </button>
          <span className="login-sep" aria-hidden="true">·</span>
          <button className="login-footer-link" type="button" onClick={onOpenDashboard}>
            {t('login.openDashboard')}
          </button>
          <span className="login-sep" aria-hidden="true">·</span>
          <button className="login-footer-link" type="button" onClick={onOpenFeedback}>
            {t('login.reportIssue')}
          </button>
        </footer>
      </section>

      {/* Issue #71: Windows Git onboarding dialog. Reuses the
          confirm-modal family (modal-backdrop + t-modal) so it matches
          the app's other overlays. While winget runs ('installing') the
          dialog can NOT be dismissed — backdrop, Escape and buttons all
          hold until the installer settles. */}
      {gitGate.phase !== 'hidden' && (
        <div
          className="modal-backdrop"
          onPointerDown={event => {
            if (event.target === event.currentTarget && gitGate.phase !== 'installing') closeGitGate()
          }}
        >
          <div
            className="confirm-modal t-modal is-open git-gate-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('login.gitRequiredTitle')}
          >
            <h2>{t('login.gitRequiredTitle')}</h2>
            <p>{t('login.gitRequiredBody')}</p>

            {gitGate.phase === 'prompt' && (
              <div className="modal-actions">
                <button type="button" className="confirm-primary" onClick={() => void installGitAutomatically()}>
                  {t('login.gitInstallAuto')}
                </button>
                <button type="button" onClick={() => setGitGate({ phase: 'manual' })}>
                  {t('login.gitInstallManual')}
                </button>
                <button type="button" onClick={closeGitGate}>
                  {t('common.cancel')}
                </button>
              </div>
            )}

            {gitGate.phase === 'installing' && (
              <div className="login-progress" role="status">
                <span className="t-shimmer" data-text={t('login.gitInstalling')}>
                  {t('login.gitInstalling')}
                </span>
              </div>
            )}

            {gitGate.phase === 'installFailed' && (
              <>
                <div className="login-warning" role="alert">
                  {t('login.gitInstallFailed')}
                  {gitGate.log.trim().length > 0 && (
                    <details className="login-warning-details">
                      <summary>{t('transcript.showTechnicalDetails')}</summary>
                      <pre>{summarizeGitInstallLog(gitGate.log)}</pre>
                    </details>
                  )}
                </div>
                <div className="modal-actions">
                  <button type="button" className="confirm-primary" onClick={() => setGitGate({ phase: 'manual' })}>
                    {t('login.gitInstallManual')}
                  </button>
                  <button type="button" onClick={closeGitGate}>
                    {t('common.close')}
                  </button>
                </div>
              </>
            )}

            {gitGate.phase === 'manual' && (
              <>
                <ol className="git-gate-steps">
                  <li>
                    {t('login.gitManualStepDownload')}{' '}
                    <a href="https://git-scm.com/downloads/win" target="_blank" rel="noreferrer">
                      git-scm.com/downloads/win
                    </a>
                  </li>
                  <li>{t('login.gitManualStepDefaults')}</li>
                  <li>{t('login.gitManualStepReopen')}</li>
                </ol>
                <div className="modal-actions">
                  <button type="button" className="confirm-primary" onClick={closeGitGate}>
                    {t('common.close')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
