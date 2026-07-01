import {
  Archive,
  ArrowLeft,
  Bell,
  Brain,
  Check,
  ChevronDown,
  Computer,
  KeyRound,
  MenuSquare,
  MessageSquare,
  Moon,
  Palette,
  RefreshCcw,
  RotateCcw,
  Shield,
  ShieldCheck,
  Trash2,
  UserCog,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  AccessMode,
  CompletionNotificationMode,
  CredentialStatus,
  ModelDiscoveryResult,
  PersonalityMode,
  SettingsTab,
  StoredConversation,
  ThemeMode,
  UserSettings,
  VerbooModel,
} from '../../../shared/types'

type SettingsViewProps = {
  credentials: CredentialStatus
  modelResult: ModelDiscoveryResult
  selectedModel?: VerbooModel
  selectedContextWindow?: number
  maxContextWindow?: number
  theme: ThemeMode
  activeTab: SettingsTab
  userSettings: UserSettings
  archivedConversations: StoredConversation[]
  onOpenDashboard: () => void
  onSaveApiKey: (apiKey: string) => Promise<void>
  onContextWindowChange: (value: number) => void
  onThemeChange: (theme: ThemeMode) => void
  onActiveTabChange: (tab: SettingsTab) => void
  onUserSettingsChange: (patch: Partial<UserSettings>) => Promise<void>
  onResetUserSettings: () => Promise<void>
  onRestoreConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
  onClose: () => void
}

const settingsTabs: Array<{ id: SettingsTab; label: string; icon: typeof Shield }> = [
  { id: 'permissions', label: 'Permissoes', icon: Shield },
  { id: 'trustedCommands', label: 'Comandos confiaveis', icon: ShieldCheck },
  { id: 'app', label: 'App', icon: Computer },
  { id: 'notifications', label: 'Notificacoes', icon: Bell },
  { id: 'personalization', label: 'Personalizacao', icon: UserCog },
  { id: 'memory', label: 'Memoria', icon: Brain },
  { id: 'archived', label: 'Chats arquivados', icon: Archive },
]

const accessOptions: Array<{ id: AccessMode; title: string; body: string; tone?: 'danger' }> = [
  {
    id: 'approval',
    title: 'Solicitar aprovacao',
    body: 'Sempre pedir aprovacao para editar arquivos externos e usar internet.',
  },
  {
    id: 'auto',
    title: 'Aprovar por mim',
    body: 'Pedir aprovacao apenas para acoes detectadas como potencialmente inseguras.',
  },
  {
    id: 'full',
    title: 'Acesso completo',
    body: 'Acesso irrestrito a internet, arquivos e comandos locais sem sua aprovacao.',
    tone: 'danger',
  },
]

export function SettingsView({
  credentials,
  modelResult,
  selectedModel,
  selectedContextWindow,
  maxContextWindow,
  theme,
  activeTab,
  userSettings,
  archivedConversations,
  onOpenDashboard,
  onSaveApiKey,
  onContextWindowChange,
  onThemeChange,
  onActiveTabChange,
  onUserSettingsChange,
  onResetUserSettings,
  onRestoreConversation,
  onDeleteConversation,
  onClose,
}: SettingsViewProps) {
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [customDraft, setCustomDraft] = useState(userSettings.customInstructions)
  const [confirmingFullAccess, setConfirmingFullAccess] = useState<'mode-selector' | 'capability' | false>(false)

  useEffect(() => {
    setCustomDraft(userSettings.customInstructions)
  }, [userSettings.customInstructions])

  async function submitApiKey() {
    setSaving(true)
    try {
      await onSaveApiKey(apiKey)
      setApiKey('')
    } finally {
      setSaving(false)
    }
  }

  async function saveCustomInstructions() {
    await onUserSettingsChange({ customInstructions: customDraft })
  }

  function requestAccessModeChange(mode: AccessMode) {
    if (mode === 'full' && !userSettings.fullAccessEnabled) {
      setConfirmingFullAccess('mode-selector')
      return
    }

    void onUserSettingsChange({ defaultAccessMode: mode })
  }

  function cancelFullAccessConfirmation() {
    setConfirmingFullAccess(false)
  }

  function confirmFullAccess() {
    const patch: Partial<UserSettings> = { fullAccessEnabled: true }
    if (confirmingFullAccess === 'mode-selector') {
      patch.defaultAccessMode = 'full'
    }
    void onUserSettingsChange(patch)
    setConfirmingFullAccess(false)
  }

  return (
    <div className="settings-shell page-surface">
      <aside className="settings-nav" aria-label="Configuracoes">
        <button className="settings-back" type="button" onClick={onClose}>
          <ArrowLeft size={14} />
          Voltar ao app
        </button>
        <div className="settings-nav-title">Configuracoes</div>
        {settingsTabs.map(tab => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              className={activeTab === tab.id ? 'active' : ''}
              type="button"
              onClick={() => onActiveTabChange(tab.id)}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          )
        })}
      </aside>

      <div className="settings-content">
        {activeTab === 'permissions' && (
          <section className="settings-section-view">
            <SettingsHeading title="Permissoes" subtitle="Defina como as acoes do Verboo devem ser aprovadas." />
            <div className="settings-panel access-settings-panel">
              {accessOptions.map(option => (
                <button
                  key={option.id}
                  className={`access-setting ${userSettings.defaultAccessMode === option.id ? 'active' : ''} ${option.tone === 'danger' ? 'danger' : ''} ${option.id === 'full' && !userSettings.fullAccessEnabled ? 'blocked' : ''}`}
                  type="button"
                  onClick={() => requestAccessModeChange(option.id)}
                >
                  <Shield size={18} />
                  <span>
                    <strong>{option.title}</strong>
                    <small>{option.id === 'full' && !userSettings.fullAccessEnabled ? 'Ative em Permissoes para liberar este modo.' : option.body}</small>
                  </span>
                  {userSettings.defaultAccessMode === option.id && <Check size={18} />}
                </button>
              ))}
            </div>

            <section className="settings-panel settings-permission-card settings-permission-card--danger">
              <div className="settings-permission-card-header">
                <Shield size={18} />
                <div>
                  <strong>Acesso completo</strong>
                  <p>Libera execucao irrestrita no workspace e comandos locais sem novas confirmacoes.</p>
                </div>
              </div>
              <div className="settings-permission-card-status">
                <span className={userSettings.fullAccessEnabled ? 'status-enabled' : 'status-blocked'}>
                  {userSettings.fullAccessEnabled ? 'Ativado' : 'Bloqueado'}
                </span>
                <button
                  type="button"
                  disabled={userSettings.fullAccessEnabled}
                  onClick={() => setConfirmingFullAccess('capability')}
                >
                  {userSettings.fullAccessEnabled ? 'Acesso completo ativado' : 'Ativar acesso completo'}
                </button>
              </div>
            </section>
          </section>
        )}

        {activeTab === 'trustedCommands' && (
          <section className="settings-section-view">
            <SettingsHeading
              title="Comandos confiaveis"
              subtitle="Gerencie comandos que voce marcou como Sempre permitir."
            />
            <section className="settings-panel trusted-command-panel">
              {userSettings.trustedCommands.length === 0 ? (
                <div className="trusted-command-empty">
                  Nenhum comando confiavel salvo.
                </div>
              ) : (
                <div className="trusted-command-list">
                  {userSettings.trustedCommands.map(rule => (
                    <article key={rule.id} className="trusted-command-row">
                      <ShieldCheck size={16} />
                      <span>
                        <code>{rule.command}</code>
                        <small>
                          {rule.useCount} uso{rule.useCount === 1 ? '' : 's'}
                          {' · '}
                          salvo em {formatDate(rule.createdAt)}
                        </small>
                      </span>
                      <button
                        type="button"
                        onClick={() => onUserSettingsChange({
                          trustedCommands: userSettings.trustedCommands.filter(item => item.id !== rule.id),
                        })}
                      >
                        <Trash2 size={14} />
                        Excluir
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </section>
        )}

        {activeTab === 'app' && (
          <section className="settings-section-view">
            <SettingsHeading title="App" subtitle="Aparencia, MenuBar, modelos e janela de contexto." />

            <section className="settings-panel">
              <div className="settings-row">
                <KeyRound size={16} />
                <div>
                  <strong>Chave API</strong>
                  <p>{credentials.hasApiKey ? `Configurada (${credentials.apiKeyHint})` : 'Nao configurada. O login via CLI tambem e aceito.'}</p>
                </div>
              </div>
              <div className="api-key-form">
                <input
                  value={apiKey}
                  onChange={event => setApiKey(event.target.value)}
                  placeholder="Cole sua chave API Verboo"
                  type="password"
                />
                <button type="button" onClick={submitApiKey} disabled={!apiKey.trim() || saving}>
                  {saving ? 'Salvando' : 'Salvar'}
                </button>
              </div>
              {modelResult.error && <p className="settings-warning">{modelResult.error}</p>}
              <SettingToggle
                title="Continuar logado"
                body="Usar a ultima validacao local quando a renovacao de modelos falhar temporariamente."
                checked={userSettings.staySignedIn}
                onChange={staySignedIn => onUserSettingsChange({ staySignedIn })}
              />
              <button className="dashboard-link" type="button" onClick={onOpenDashboard}>
                Abrir dashboard Verboo
              </button>
            </section>

            <section className="settings-panel">
              <div className="settings-row">
                <Palette size={16} />
                <div>
                  <strong>Tema</strong>
                  <p>Escolha como a interface do Verboo deve aparecer.</p>
                </div>
              </div>
              <div className="theme-toggle" role="group" aria-label="Tema">
                <button className={theme === 'dark' ? 'active' : ''} type="button" onClick={() => onThemeChange('dark')}>
                  <Moon size={15} />
                  Escuro
                </button>
                <button className={theme === 'light' ? 'active' : ''} type="button" onClick={() => onThemeChange('light')}>
                  <Palette size={15} />
                  Claro
                </button>
              </div>
            </section>

            <section className="settings-panel context-settings">
              <div className="settings-row">
                <MenuSquare size={16} />
                <div>
                  <strong>Janela de contexto</strong>
                  <p>
                    {selectedModel && selectedContextWindow && maxContextWindow
                      ? `${selectedModel.displayName}: ${formatTokens(selectedContextWindow)} de ${formatTokens(maxContextWindow)}`
                      : 'Carregue um modelo real da sua conta para configurar o contexto.'}
                  </p>
                </div>
              </div>
              <ContextRange
                maxContextWindow={maxContextWindow}
                selectedContextWindow={selectedContextWindow}
                disabled={!selectedModel}
                onContextWindowChange={onContextWindowChange}
              />
              <div className="context-advice">
                <div>
                  <strong>Aumentar</strong>
                  <p>Mantem mais historico, arquivos e contexto do projeto. Pode ficar mais lento, gastar mais cota e misturar informacao irrelevante.</p>
                </div>
                <div>
                  <strong>Diminuir</strong>
                  <p>Costuma deixar a sessao mais focada e economica. Aumenta o risco do Verboo perder detalhes antigos ou precisar reler arquivos.</p>
                </div>
              </div>
            </section>

            <section className="settings-panel">
              <SettingToggle
                title="Mostrar na barra de menu"
                body="Manter Verboo na MenuBar do macOS quando a janela principal estiver fechada."
                checked={userSettings.showInMenuBar}
                onChange={showInMenuBar => onUserSettingsChange({ showInMenuBar })}
              />
              <SettingToggle
                title="Expandir texto na MenuBar"
                body="Mostrar status, tempo e modelo ao lado do icone do Verboo."
                checked={userSettings.showMenuBarText}
                disabled={!userSettings.showInMenuBar}
                onChange={showMenuBarText => onUserSettingsChange({ showMenuBarText })}
              />
              <SettingToggle
                title="Impedir suspensao durante a execucao"
                body="Mantem o computador ativo enquanto o Verboo executa um chat."
                checked={userSettings.preventSleepWhileRunning}
                onChange={preventSleepWhileRunning => onUserSettingsChange({ preventSleepWhileRunning })}
              />
            </section>

            <section className="settings-panel">
              <SettingToggle
                title="Goal Mode (beta)"
                body="Permite usar /goal para executar objetivos em loop autonomo com avaliacao entre turnos."
                checked={userSettings.goalMode.enabled}
                onChange={enabled => onUserSettingsChange({ goalMode: { ...userSettings.goalMode, enabled } })}
              />
              {userSettings.goalMode.enabled && (
                <div className="settings-nested-group">
                  <SettingNumericInput
                    title="Turnos maximos"
                    body="Numero maximo de turnos de execucao por objetivo."
                    value={userSettings.goalMode.maxTurns}
                    min={1}
                    max={20}
                    onChange={maxTurns => onUserSettingsChange({ goalMode: { ...userSettings.goalMode, maxTurns } })}
                  />
                  <SettingNumericInput
                    title="Tempo maximo (minutos)"
                    body="Tempo maximo total de execucao por objetivo."
                    value={userSettings.goalMode.maxElapsedMinutes}
                    min={1}
                    max={240}
                    onChange={maxElapsedMinutes => onUserSettingsChange({ goalMode: { ...userSettings.goalMode, maxElapsedMinutes } })}
                  />
                  <SettingToggle
                    title="Auto-acesso entre turnos"
                    body="Quando ativo, o modo goal alterna para acesso automatico durante continuacoes."
                    checked={userSettings.goalMode.allowAutoAccess}
                    onChange={allowAutoAccess => onUserSettingsChange({ goalMode: { ...userSettings.goalMode, allowAutoAccess } })}
                  />
                </div>
              )}
            </section>
          </section>
        )}

        {activeTab === 'notifications' && (
          <section className="settings-section-view">
            <SettingsHeading title="Notificacoes" subtitle="Controle quando o app deve chamar sua atencao." />
            <section className="settings-panel">
              <label className="settings-select-row">
                <span>
                  <strong>Notificacoes de conclusao</strong>
                  <small>Defina quando o Verboo avisa que terminou.</small>
                </span>
                <select
                  value={userSettings.completionNotifications}
                  onChange={event => onUserSettingsChange({ completionNotifications: event.target.value as CompletionNotificationMode })}
                >
                  <option value="always">Sempre</option>
                  <option value="background">Somente em segundo plano</option>
                  <option value="never">Nunca</option>
                </select>
                <ChevronDown size={15} />
              </label>
              <SettingToggle
                title="Notificacoes de permissao"
                body="Exibir alertas quando uma aprovacao for necessaria."
                checked={userSettings.permissionNotifications}
                onChange={permissionNotifications => onUserSettingsChange({ permissionNotifications })}
              />
              <SettingToggle
                title="Notificacoes de perguntas"
                body="Exibir alertas quando o Verboo precisar de uma resposta para continuar."
                checked={userSettings.questionNotifications}
                onChange={questionNotifications => onUserSettingsChange({ questionNotifications })}
              />
            </section>
          </section>
        )}

        {activeTab === 'personalization' && (
          <section className="settings-section-view">
            <SettingsHeading title="Personalizacao" subtitle="Ajuste o tom padrao e instrucoes enviadas ao CLI." />
            <section className="settings-panel">
              <label className="settings-select-row">
                <span>
                  <strong>Personalidade</strong>
                  <small>Tom padrao das respostas do Verboo.</small>
                </span>
                <select
                  value={userSettings.personality}
                  onChange={event => onUserSettingsChange({ personality: event.target.value as PersonalityMode })}
                >
                  <option value="pragmatic">Pragmatica</option>
                  <option value="concise">Concisa</option>
                  <option value="explanatory">Explicativa</option>
                </select>
                <ChevronDown size={15} />
              </label>
              <label className="custom-instructions-field">
                <span>
                  <strong>Instrucoes personalizadas</strong>
                  <small>Esse texto e enviado como contexto extra para cada pedido.</small>
                </span>
                <textarea
                  value={customDraft}
                  onChange={event => setCustomDraft(event.target.value)}
                  placeholder="Ex.: priorize respostas curtas, cite arquivos alterados e rode testes quando possivel."
                />
              </label>
              <button type="button" onClick={saveCustomInstructions} disabled={customDraft === userSettings.customInstructions}>
                Salvar instrucoes
              </button>
            </section>
          </section>
        )}

        {activeTab === 'memory' && (
          <section className="settings-section-view">
            <SettingsHeading title="Memoria" subtitle="Use historico local para dar continuidade entre conversas do mesmo projeto." />
            <section className="settings-panel">
              <SettingToggle
                title="Ativar memorias"
                body="Inclui resumos curtos de chats anteriores do mesmo projeto no proximo pedido."
                checked={userSettings.memoriesEnabled}
                onChange={memoriesEnabled => onUserSettingsChange({ memoriesEnabled })}
              />
              <SettingToggle
                title="Previa de pesquisa local"
                body="Permite que o app considere titulos e mensagens recentes ao montar contexto local."
                checked={userSettings.chroniclePreview}
                disabled={!userSettings.memoriesEnabled}
                onChange={chroniclePreview => onUserSettingsChange({ chroniclePreview })}
              />
              <SettingToggle
                title="Ignorar chats com ferramentas"
                body="Nao usar mensagens de ferramenta/terminal dentro do contexto de memoria."
                checked={userSettings.ignoreToolChatsForMemory}
                disabled={!userSettings.memoriesEnabled}
                onChange={ignoreToolChatsForMemory => onUserSettingsChange({ ignoreToolChatsForMemory })}
              />
              <button className="danger-soft-button" type="button" onClick={onResetUserSettings}>
                <RefreshCcw size={15} />
                Redefinir preferencias do app
              </button>
            </section>
          </section>
        )}

        {activeTab === 'archived' && (
          <section className="settings-section-view">
            <SettingsHeading title="Chats arquivados" subtitle="Restaure ou apague conversas que sairam da barra lateral." />
            <section className="settings-panel archived-panel">
              {archivedConversations.length === 0 ? (
                <div className="archived-empty">Nenhum chat arquivado.</div>
              ) : (
                <div className="archived-list">
                  {archivedConversations.map(conversation => (
                    <article key={conversation.id} className="archived-chat">
                      <MessageSquare size={15} />
                      <span>
                        <strong>{conversation.title}</strong>
                        <small>{formatDate(conversation.archivedAt ?? conversation.updatedAt)}</small>
                      </span>
                      <button type="button" onClick={() => onRestoreConversation(conversation.id)}>
                        <RotateCcw size={14} />
                        Restaurar
                      </button>
                      <button type="button" onClick={() => onDeleteConversation(conversation.id)}>
                        <Trash2 size={14} />
                        Apagar
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </section>
        )}
      </div>

      {confirmingFullAccess && (
        <div className="modal-backdrop">
          <div className="confirm-modal t-modal is-open" role="dialog" aria-modal="true">
            <h2>Ativar acesso completo</h2>
            <p className="danger-copy">
              Esta acao libera acesso irrestrito ao workspace. Leia os riscos abaixo antes de continuar.
            </p>
            <ul className="risk-list">
              <li>O app podera ler, criar, modificar e apagar arquivos acessiveis ao usuario.</li>
              <li>Comandos locais podem alterar o projeto e o ambiente.</li>
              <li>Segredos, tokens e chaves podem ser expostos se o workspace os contiver.</li>
              <li>Use apenas em workspaces confiaveis.</li>
            </ul>
            <div className="modal-actions">
              <button type="button" onClick={cancelFullAccessConfirmation}>
                Cancelar
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={confirmFullAccess}
              >
                Entendo e concordo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SettingsHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="view-heading">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </header>
  )
}

function SettingToggle({
  title,
  body,
  checked,
  disabled = false,
  onChange,
}: {
  title: string
  body: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button className="settings-toggle-row" type="button" disabled={disabled} onClick={() => onChange(!checked)}>
      <span>
        <strong>{title}</strong>
        <small>{body}</small>
      </span>
      <span className={`toggle-switch ${checked ? 'on' : ''}`} aria-hidden="true">
        <span />
      </span>
    </button>
  )
}

function SettingNumericInput({
  title,
  body,
  value,
  min,
  max,
  onChange,
}: {
  title: string
  body: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <div className="settings-toggle-row" style={{ cursor: 'default' }}>
      <span>
        <strong>{title}</strong>
        <small>{body}</small>
      </span>
      <input
        className="settings-numeric-input"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
      />
    </div>
  )
}

function ContextRange({
  selectedContextWindow,
  maxContextWindow,
  disabled,
  onContextWindowChange,
}: {
  selectedContextWindow?: number
  maxContextWindow?: number
  disabled: boolean
  onContextWindowChange: (value: number) => void
}) {
  const ready = !disabled && Boolean(selectedContextWindow && maxContextWindow)
  const max = ready ? maxContextWindow! : 1
  const value = ready ? selectedContextWindow! : 0

  return (
    <>
      <input
        className="context-range"
        type="range"
        min={ready ? Math.min(4_000, max) : 0}
        max={max}
        step={ready ? contextStep(max) : 1}
        value={value}
        disabled={!ready}
        onChange={event => onContextWindowChange(Number(event.target.value))}
      />
      <div className="context-presets">
        {[0.25, 0.5, 0.75, 1].map(ratio => (
          <button
            key={ratio}
            type="button"
            disabled={!ready}
            onClick={() => onContextWindowChange(max * ratio)}
          >
            {Math.round(ratio * 100)}%
          </button>
        ))}
      </div>
    </>
  )
}

function contextStep(max: number): number {
  if (max >= 1_000_000) return 32_000
  if (max >= 128_000) return 8_000
  return 1_000
}

function formatTokens(tokens: number): string {
  return Intl.NumberFormat('pt-BR', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(tokens)
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}
