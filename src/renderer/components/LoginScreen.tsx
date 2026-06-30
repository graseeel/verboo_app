import { AtSign, Bug, CheckCircle2, ExternalLink, KeyRound, LogIn, Mail, Phone, RefreshCw, ShieldAlert, UserPlus } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { CliAuthStatus, CredentialStatus, LoginResult, ModelDiscoveryResult } from '../../shared/types'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'
import wordmarkUrl from '../../../assets/branding/verboo-wordmark.png'

type LoginScreenProps = {
  noticeAccepted: boolean
  checking: boolean
  authError?: string
  credentials: CredentialStatus
  cliAuth: CliAuthStatus
  modelResult: ModelDiscoveryResult
  onStartLogin: () => Promise<LoginResult> | LoginResult
  onOpenDashboard: () => void
  onOpenSignup: () => void
  onCheckExistingAuth: () => Promise<boolean>
  onSaveApiKey: (apiKey: string) => Promise<boolean>
  onAcceptNotice: () => void
  onOpenFeedback: () => void
}

export function LoginScreen({
  noticeAccepted,
  checking,
  authError,
  credentials,
  cliAuth,
  modelResult,
  onStartLogin,
  onOpenDashboard,
  onOpenSignup,
  onCheckExistingAuth,
  onSaveApiKey,
  onAcceptNotice,
  onOpenFeedback,
}: LoginScreenProps) {
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | undefined>()

  async function startLogin() {
    setStatusMessage('Abrindo login do Verboo pelo CLI...')
    const result = await onStartLogin()
    setStatusMessage(result.message)
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
        setStatusMessage('Chave API validada.')
      } else {
        setStatusMessage('Nao foi possivel validar a chave API.')
      }
    } finally {
      setSaving(false)
    }
  }

  async function checkExistingAuth() {
    setStatusMessage('Verificando sessao local do Verboo...')
    const valid = await onCheckExistingAuth()
    setStatusMessage(valid ? 'Sessao Verboo validada.' : 'Nenhuma sessao Verboo valida foi encontrada.')
  }

  if (!noticeAccepted) {
    return (
      <main className="login-screen">
        <section className="login-panel development-panel" aria-label="Aviso de desenvolvimento">
          <div className="login-brand">
            <img className="login-mascot" src={mascotUrl} alt="" />
            <img className="login-wordmark" src={wordmarkUrl} alt="Verboo" />
          </div>

          <div className="login-copy">
            <p className="login-eyebrow">Aviso importante</p>
            <h1>Versao em desenvolvimento</h1>
            <p>
              Este aplicativo esta em desenvolvimento e nao e uma versao oficial criada pela Verboo.
              Ele usa sua conta, CLI ou chave API Verboo apenas para tentar reproduzir a experiencia
              desktop do Verboo Code.
            </p>
          </div>

          <div className="development-warning">
            <ShieldAlert size={20} />
            <div>
              <strong>Use sabendo que podem existir bugs ou falhas.</strong>
              <p>
                Se encontrar qualquer problema, comportamento estranho ou falha de seguranca, fale
                diretamente com Gabriel antes de distribuir ou depender deste app em trabalho critico.
              </p>
            </div>
          </div>

          <div className="contact-list" aria-label="Contatos para suporte">
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

          <button className="primary-action wide-action" type="button" onClick={onAcceptNotice}>
            <CheckCircle2 size={18} />
            Entendi e quero continuar
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="login-screen">
      <section className="login-panel" aria-label="Entrar no Verboo Code">
        <div className="login-brand">
          <img className="login-mascot" src={mascotUrl} alt="" />
          <img className="login-wordmark" src={wordmarkUrl} alt="Verboo" />
        </div>

        <div className="login-copy">
          <h1>Entrar no Verboo Code</h1>
          <p>
            O app fica bloqueado ate validar uma sessao real do CLI Verboo ou uma chave API valida.
            A validacao precisa retornar modelos disponiveis para o seu plano.
          </p>
        </div>

        <div className="login-actions">
          <button className="primary-action" type="button" onClick={startLogin} disabled={checking}>
            <LogIn size={18} />
            Entrar pelo CLI
          </button>
          <button className="secondary-action" type="button" onClick={checkExistingAuth} disabled={checking}>
            <RefreshCw size={17} />
            Ja autentiquei
          </button>
        </div>

        <div className="login-actions secondary-grid">
          <button className="secondary-action" type="button" onClick={onOpenSignup}>
            <UserPlus size={17} />
            Criar conta ou assinar
          </button>
          <button className="secondary-action" type="button" onClick={onOpenDashboard}>
            <ExternalLink size={17} />
            Abrir dashboard
          </button>
          <button className="secondary-action login-feedback-button" type="button" onClick={onOpenFeedback}>
            <Bug size={17} />
            Reportar problema
          </button>
        </div>

        {(statusMessage || checking) && (
          <div className="login-note">{checking ? 'Validando credenciais e modelos disponiveis...' : statusMessage}</div>
        )}

        {(authError || modelResult.error) && (
          <div className="login-warning">{authError ?? modelResult.error}</div>
        )}

        <form className="api-login-form" onSubmit={submitApiKey}>
          <label htmlFor="api-key">
            <KeyRound size={16} />
            Chave API Verboo
          </label>
          <div className="api-login-row">
            <input
              id="api-key"
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
              placeholder={credentials.hasApiKey ? `Configurada (${credentials.apiKeyHint})` : 'Cole sua chave API'}
              type="password"
            />
            <button type="submit" disabled={!apiKey.trim() || saving || checking}>
              {saving ? 'Validando' : 'Salvar'}
            </button>
          </div>
          <p>
            A chave fica criptografada localmente. O app so libera o uso se ela conseguir listar os modelos
            disponiveis na sua conta Verboo.
          </p>
        </form>
      </section>
    </main>
  )
}
