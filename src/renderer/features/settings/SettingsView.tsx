import {
  Archive,
  ArrowLeft,
  Bell,
  Brain,
  Check,
  ChevronDown,
  Computer,
  Download,
  Ghost,
  KeyRound,
  Languages,
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
  UpdateSettings,
  UpdateSnapshot,
  UserSettings,
  VerbooModel,
} from '../../../shared/types'
import { LanguageSelector } from '../language/LanguageSelector'
import { useToast } from '../../components/Toast'
import { formatCompactNumber, formatDateTime, useI18n } from '../../i18n'
import { DEFAULT_CONVERSATION_TITLE } from '../../state/chatStore'

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
  petEnabled: boolean
  petSize: number
  updateSnapshot?: UpdateSnapshot
  onPetToggle: () => void
  onPetSizeChange: (size: number) => void
  onOpenDashboard: () => void
  onSaveApiKey: (apiKey: string) => Promise<void>
  onContextWindowChange: (value: number) => void
  onThemeChange: (theme: ThemeMode) => void
  onActiveTabChange: (tab: SettingsTab) => void
  onUserSettingsChange: (patch: Partial<UserSettings>) => Promise<void>
  onResetUserSettings: () => Promise<void>
  onRestoreConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
  onCheckForUpdates: (userInitiated?: boolean) => Promise<UpdateSnapshot>
  onDownloadUpdate: () => Promise<UpdateSnapshot>
  onInstallUpdate: () => Promise<void>
  onClose: () => void
}

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
  petEnabled,
  petSize,
  updateSnapshot,
  onPetToggle,
  onPetSizeChange,
  onOpenDashboard,
  onSaveApiKey,
  onContextWindowChange,
  onThemeChange,
  onActiveTabChange,
  onUserSettingsChange,
  onResetUserSettings,
  onRestoreConversation,
  onDeleteConversation,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onClose,
}: SettingsViewProps) {
  const { language, t } = useI18n()
  const { toast } = useToast()
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [customDraft, setCustomDraft] = useState(userSettings.customInstructions)
  const [confirmingFullAccess, setConfirmingFullAccess] = useState<'mode-selector' | 'capability' | false>(false)
  const settingsTabs: Array<{ id: SettingsTab; label: string; icon: typeof Shield }> = [
    { id: 'permissions', label: t('settings.permissions'), icon: Shield },
    { id: 'trustedCommands', label: t('settings.trustedCommands'), icon: ShieldCheck },
    { id: 'app', label: t('settings.app'), icon: Computer },
    { id: 'notifications', label: t('settings.notifications'), icon: Bell },
    { id: 'personalization', label: t('settings.personalization'), icon: UserCog },
    { id: 'memory', label: t('settings.memory'), icon: Brain },
    { id: 'updates', label: t('updates.title'), icon: Download },
    { id: 'archived', label: t('settings.archived'), icon: Archive },
  ]
  const accessOptions: Array<{ id: AccessMode; title: string; body: string; tone?: 'danger' }> = [
    {
      id: 'approval',
      title: t('access.approval.title'),
      body: t('access.approval.description'),
    },
    {
      id: 'auto',
      title: t('access.auto.title'),
      body: t('access.auto.description'),
    },
    {
      id: 'full',
      title: t('access.full.title'),
      body: t('access.full.description'),
      tone: 'danger',
    },
  ]

  useEffect(() => {
    setCustomDraft(userSettings.customInstructions)
  }, [userSettings.customInstructions])

  async function submitApiKey() {
    setSaving(true)
    try {
      await onSaveApiKey(apiKey)
      setApiKey('')
      toast(t('toast.apiKeySaved'))
    } catch {
      toast(t('toast.apiKeyInvalid'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function saveCustomInstructions() {
    await onUserSettingsChange({ customInstructions: customDraft })
    toast(t('toast.instructionsSaved'))
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
      <aside className="settings-nav" aria-label={t('settings.navAria')}>
        <button className="settings-back" type="button" onClick={onClose}>
          <ArrowLeft size={14} />
          {t('settings.back')}
        </button>
        <div className="settings-nav-title">{t('settings.title')}</div>
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
            <SettingsHeading title={t('settings.permissions')} subtitle={t('settings.permissionsSubtitle')} />
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
                    <small>{option.id === 'full' && !userSettings.fullAccessEnabled ? t('access.fullLocked') : option.body}</small>
                  </span>
                  {userSettings.defaultAccessMode === option.id && <Check size={18} />}
                </button>
              ))}
            </div>

            <section className="settings-panel settings-permission-card settings-permission-card--danger">
              <div className="settings-permission-card-header">
                <Shield size={18} />
                <div>
                  <strong>{t('settings.fullModeCardTitle')}</strong>
                  <p>{t('settings.fullModeCardBody')}</p>
                </div>
              </div>
              <div className="settings-permission-card-status">
                <span className={userSettings.fullAccessEnabled ? 'status-enabled' : 'status-blocked'}>
                  {userSettings.fullAccessEnabled ? t('settings.enabled') : t('settings.blocked')}
                </span>
                <button
                  type="button"
                  disabled={userSettings.fullAccessEnabled}
                  onClick={() => setConfirmingFullAccess('capability')}
                >
                  {userSettings.fullAccessEnabled ? t('settings.fullModeEnabled') : t('settings.enableFullMode')}
                </button>
              </div>
            </section>
          </section>
        )}

        {activeTab === 'trustedCommands' && (
          <section className="settings-section-view">
            <SettingsHeading
              title={t('settings.trustedCommands')}
              subtitle={t('settings.trustedCommandsSubtitle')}
            />
            <section className="settings-panel trusted-command-panel">
              {userSettings.trustedCommands.length === 0 ? (
                <div className="trusted-command-empty">
                  {t('settings.noTrustedCommands')}
                </div>
              ) : (
                <div className="trusted-command-list">
                  {userSettings.trustedCommands.map(rule => (
                    <article key={rule.id} className="trusted-command-row">
                      <ShieldCheck size={16} />
                      <span>
                        <code>{rule.command}</code>
                        <small>
                          {rule.useCount} {rule.useCount === 1 ? t('settings.usageSingular') : t('settings.usagePlural')}
                          {' · '}
                          {t('settings.savedOn', { date: formatDateTime(rule.createdAt, language) })}
                        </small>
                      </span>
                      <button
                        type="button"
                        onClick={() => onUserSettingsChange({
                          trustedCommands: userSettings.trustedCommands.filter(item => item.id !== rule.id),
                        })}
                      >
                        <Trash2 size={14} />
                        {t('settings.delete')}
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
            <SettingsHeading title={t('settings.app')} subtitle={t('settings.appSubtitle')} />

            <section className="settings-panel">
              <div className="settings-row settings-row--control">
                <Languages size={16} />
                <div>
                  <strong>{t('language.label')}</strong>
                  <p>{t('language.description')}</p>
                </div>
                <LanguageSelector
                  value={userSettings.language}
                  onChange={language => {
                    void onUserSettingsChange({ language })
                  }}
                />
              </div>
            </section>

            <section className="settings-panel">
              <div className="settings-row">
                <KeyRound size={16} />
                <div>
                  <strong>{t('settings.apiKey')}</strong>
                  <p>{credentials.hasApiKey ? t('settings.apiKeyConfigured', { hint: credentials.apiKeyHint }) : t('settings.apiKeyMissing')}</p>
                </div>
              </div>
              <div className="api-key-form">
                <input
                  value={apiKey}
                  onChange={event => setApiKey(event.target.value)}
                  placeholder={t('settings.apiKeyPlaceholder')}
                  type="password"
                />
                <button type="button" onClick={submitApiKey} disabled={!apiKey.trim() || saving}>
                  {saving ? t('common.saving') : t('common.save')}
                </button>
              </div>
              {modelResult.error && <p className="settings-warning">{modelSettingsMessage(modelResult.error, t)}</p>}
              <SettingToggle
                title={t('login.staySignedIn')}
                body={t('login.staySignedInHelp')}
                checked={userSettings.staySignedIn}
                onChange={staySignedIn => onUserSettingsChange({ staySignedIn })}
              />
              <button className="dashboard-link" type="button" onClick={onOpenDashboard}>
                {t('settings.openDashboard')}
              </button>
            </section>

            <section className="settings-panel">
              <div className="settings-row">
                <Palette size={16} />
                <div>
                  <strong>{t('settings.theme')}</strong>
                  <p>{t('settings.themeDescription')}</p>
                </div>
              </div>
              <div className="theme-toggle" role="group" aria-label={t('settings.theme')}>
                <button className={theme === 'dark' ? 'active' : ''} type="button" onClick={() => onThemeChange('dark')}>
                  <Moon size={15} />
                  {t('settings.dark')}
                </button>
                <button className={theme === 'light' ? 'active' : ''} type="button" onClick={() => onThemeChange('light')}>
                  <Palette size={15} />
                  {t('settings.light')}
                </button>
              </div>
            </section>

            <section className="settings-panel context-settings">
              <div className="settings-row">
                <MenuSquare size={16} />
                <div>
                  <strong>{t('settings.contextWindow')}</strong>
                  <p>
                    {selectedModel && selectedContextWindow && maxContextWindow
                      ? t('settings.contextReady', {
                          model: selectedModel.displayName,
                          selected: formatCompactNumber(selectedContextWindow, language),
                          max: formatCompactNumber(maxContextWindow, language),
                        })
                      : t('settings.contextUnavailable')}
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
                  <strong>{t('settings.increase')}</strong>
                  <p>{t('settings.increaseBody')}</p>
                </div>
                <div>
                  <strong>{t('settings.decrease')}</strong>
                  <p>{t('settings.decreaseBody')}</p>
                </div>
              </div>
            </section>

            <section className="settings-panel">
              <SettingToggle
                title={t('settings.showMenuBar')}
                body={t('settings.showMenuBarBody')}
                checked={userSettings.showInMenuBar}
                onChange={showInMenuBar => onUserSettingsChange({ showInMenuBar })}
              />
              <SettingToggle
                title={t('settings.showMenuBarText')}
                body={t('settings.showMenuBarTextBody')}
                checked={userSettings.showMenuBarText}
                disabled={!userSettings.showInMenuBar}
                onChange={showMenuBarText => onUserSettingsChange({ showMenuBarText })}
              />
              <SettingToggle
                title={t('settings.preventSleep')}
                body={t('settings.preventSleepBody')}
                checked={userSettings.preventSleepWhileRunning}
                onChange={preventSleepWhileRunning => onUserSettingsChange({ preventSleepWhileRunning })}
              />
            </section>

            <section className="settings-panel">
              <SettingToggle
                title={t('settings.goalMode')}
                body={t('settings.goalModeBody')}
                checked={userSettings.goalMode.enabled}
                onChange={enabled => onUserSettingsChange({ goalMode: { ...userSettings.goalMode, enabled } })}
              />
              {userSettings.goalMode.enabled && (
                <div className="settings-nested-group">
                  <SettingNumericInput
                    title={t('settings.maxTurns')}
                    body={t('settings.maxTurnsBody')}
                    value={userSettings.goalMode.maxTurns}
                    min={1}
                    max={20}
                    onChange={maxTurns => onUserSettingsChange({ goalMode: { ...userSettings.goalMode, maxTurns } })}
                  />
                  <SettingNumericInput
                    title={t('settings.maxTime')}
                    body={t('settings.maxTimeBody')}
                    value={userSettings.goalMode.maxElapsedMinutes}
                    min={1}
                    max={240}
                    onChange={maxElapsedMinutes => onUserSettingsChange({ goalMode: { ...userSettings.goalMode, maxElapsedMinutes } })}
                  />
                  <SettingToggle
                    title={t('settings.autoAccess')}
                    body={t('settings.autoAccessBody')}
                    checked={userSettings.goalMode.allowAutoAccess}
                    onChange={allowAutoAccess => onUserSettingsChange({ goalMode: { ...userSettings.goalMode, allowAutoAccess } })}
                  />
                </div>
              )}
            </section>

            <section className="settings-panel">
              <div className="settings-row">
                <Ghost size={16} />
                <div>
                  <strong>{t('settings.petSection')}</strong>
                  <p>{t('settings.petSectionBody')}</p>
                </div>
              </div>
              <SettingToggle
                title={t('settings.petEnabled')}
                body={t('settings.petEnabledBody')}
                checked={petEnabled}
                onChange={() => onPetToggle()}
              />
              {petEnabled && (
                <div className="settings-nested-group">
                  <div className="settings-toggle-row" style={{ cursor: 'default' }}>
                    <span>
                      <strong>{t('settings.petSize')}</strong>
                      <small>{t('settings.petSizeBody')}</small>
                    </span>
                    <input
                      className="settings-numeric-input"
                      type="number"
                      min={72}
                      max={260}
                      value={petSize}
                      onChange={event => onPetSizeChange(Number(event.target.value))}
                    />
                  </div>
                </div>
              )}
            </section>
          </section>
        )}

        {activeTab === 'notifications' && (
          <section className="settings-section-view">
            <SettingsHeading title={t('settings.notifications')} subtitle={t('settings.notificationsSubtitle')} />
            <section className="settings-panel">
              <label className="settings-select-row">
                <span>
                  <strong>{t('settings.completionNotifications')}</strong>
                  <small>{t('settings.completionNotificationsBody')}</small>
                </span>
                <select
                  value={userSettings.completionNotifications}
                  onChange={event => onUserSettingsChange({ completionNotifications: event.target.value as CompletionNotificationMode })}
                >
                  <option value="always">{t('settings.always')}</option>
                  <option value="background">{t('settings.backgroundOnly')}</option>
                  <option value="never">{t('settings.never')}</option>
                </select>
                <ChevronDown size={15} />
              </label>
              <SettingToggle
                title={t('settings.permissionNotifications')}
                body={t('settings.permissionNotificationsBody')}
                checked={userSettings.permissionNotifications}
                onChange={permissionNotifications => onUserSettingsChange({ permissionNotifications })}
              />
              <SettingToggle
                title={t('settings.questionNotifications')}
                body={t('settings.questionNotificationsBody')}
                checked={userSettings.questionNotifications}
                onChange={questionNotifications => onUserSettingsChange({ questionNotifications })}
              />
            </section>
          </section>
        )}

        {activeTab === 'personalization' && (
          <section className="settings-section-view">
            <SettingsHeading title={t('settings.personalization')} subtitle={t('settings.personalizationSubtitle')} />
            <section className="settings-panel">
              <SettingToggle
                title={t('settings.responseEnhancements')}
                body={t('settings.responseEnhancementsBody')}
                checked={userSettings.responseEnhancementsEnabled}
                onChange={responseEnhancementsEnabled => onUserSettingsChange({ responseEnhancementsEnabled })}
              />
              <label className="settings-select-row">
                <span>
                  <strong>{t('settings.personality')}</strong>
                  <small>{t('settings.personalityBody')}</small>
                </span>
                <select
                  value={userSettings.personality}
                  disabled={!userSettings.responseEnhancementsEnabled}
                  onChange={event => onUserSettingsChange({ personality: event.target.value as PersonalityMode })}
                >
                  <option value="pragmatic">{t('settings.personalityPragmatic')}</option>
                  <option value="concise">{t('settings.personalityConcise')}</option>
                  <option value="explanatory">{t('settings.personalityExplanatory')}</option>
                </select>
                <ChevronDown size={15} />
              </label>
              <label className="custom-instructions-field">
                <span>
                  <strong>{t('settings.customInstructions')}</strong>
                  <small>{t('settings.customInstructionsBody')}</small>
                </span>
                <textarea
                  value={customDraft}
                  onChange={event => setCustomDraft(event.target.value)}
                  placeholder={t('settings.customInstructionsPlaceholder')}
                  disabled={!userSettings.responseEnhancementsEnabled}
                />
              </label>
              <button className="settings-primary-action" type="button" onClick={saveCustomInstructions} disabled={!userSettings.responseEnhancementsEnabled || customDraft === userSettings.customInstructions}>
                {t('settings.saveInstructions')}
              </button>
            </section>
          </section>
        )}

        {activeTab === 'memory' && (
          <section className="settings-section-view">
            <SettingsHeading title={t('settings.memory')} subtitle={t('settings.memorySubtitle')} />
            <section className="settings-panel">
              <SettingToggle
                title={t('settings.enableMemories')}
                body={t('settings.enableMemoriesBody')}
                checked={userSettings.memoriesEnabled}
                onChange={memoriesEnabled => onUserSettingsChange({ memoriesEnabled })}
              />
              <SettingToggle
                title={t('settings.localSearchPreview')}
                body={t('settings.localSearchPreviewBody')}
                checked={userSettings.chroniclePreview}
                disabled={!userSettings.memoriesEnabled}
                onChange={chroniclePreview => onUserSettingsChange({ chroniclePreview })}
              />
              <SettingToggle
                title={t('settings.ignoreToolChats')}
                body={t('settings.ignoreToolChatsBody')}
                checked={userSettings.ignoreToolChatsForMemory}
                disabled={!userSettings.memoriesEnabled}
                onChange={ignoreToolChatsForMemory => onUserSettingsChange({ ignoreToolChatsForMemory })}
              />
              <button className="danger-soft-button" type="button" onClick={onResetUserSettings}>
                <RefreshCcw size={15} />
                {t('settings.resetPreferences')}
              </button>
            </section>
          </section>
        )}

        {activeTab === 'updates' && (
          <section>
            <SettingsHeading title={t('updates.title')} subtitle={t('updates.channelBody')} />
            <div className="settings-panel">
              <SettingToggle
                title={t('updates.autoCheck')}
                body={t('updates.autoCheckBody')}
                checked={userSettings.updates.autoCheck}
                onChange={checked => onUserSettingsChange({ updates: { ...userSettings.updates, autoCheck: checked } })}
              />
              <SettingToggle
                title={t('updates.autoDownload')}
                body={t('updates.autoDownloadBody')}
                checked={userSettings.updates.autoDownload}
                onChange={checked => onUserSettingsChange({ updates: { ...userSettings.updates, autoDownload: checked } })}
              />
              <div className="settings-field">
                <label className="settings-label">{t('updates.channel')}</label>
                <p className="settings-hint">{t('updates.channelBody')}</p>
                <div className="settings-choice-row">
                  <ChoiceChip
                    selected={userSettings.updates.channel === 'stable'}
                    onClick={() => onUserSettingsChange({ updates: { ...userSettings.updates, channel: 'stable' } })}
                    disabled
                  >
                    {t('updates.stable')}
                  </ChoiceChip>
                  <ChoiceChip
                    selected={userSettings.updates.channel === 'beta'}
                    onClick={() => onUserSettingsChange({ updates: { ...userSettings.updates, channel: 'beta' } })}
                  >
                    {t('updates.beta')}
                  </ChoiceChip>
                </div>
                <p className="settings-hint" style={{ marginTop: 6, color: 'var(--text-muted)' }}>
                  {t('updates.stableDisabled')}
                </p>
              </div>
              <div className="settings-field" style={{ border: 0, marginBottom: 0 }}>
                <div className="settings-action-row">
                  <button
                    className="button button-sm button-secondary"
                    onClick={() => onCheckForUpdates(true)}
                    disabled={updateSnapshot?.status === 'checking'}
                  >
                    {updateSnapshot?.status === 'checking' ? t('updates.checking') : t('updates.check')}
                  </button>
                  {updateSnapshot?.status === 'available' && updateSnapshot.channel === userSettings.updates.channel && (
                    <button className="button button-sm" onClick={() => onDownloadUpdate()}>
                      {t('updates.download')}
                    </button>
                  )}
                  {updateSnapshot?.status === 'downloaded' && (
                    <button className="button button-sm button-primary" onClick={() => onInstallUpdate()}>
                      {t('updates.restart')}
                    </button>
                  )}
                </div>
                {updateSnapshot && updateSnapshot.status !== 'idle' && updateSnapshot.status !== 'unsupported' && (
                  <p className="settings-hint" style={{ marginTop: 8, marginBottom: 2 }}>
                    {updateSummary(updateSnapshot, t)}
                  </p>
                )}
                {updateSnapshot?.status === 'downloading' && updateSnapshot.percent != null && (
                  <div className="update-progress" style={{ marginTop: 6 }}>
                    <span style={{ width: `${updateSnapshot.percent}%` }} />
                  </div>
                )}
                {updateSnapshot?.error && (
                  <p className="settings-hint" style={{ marginTop: 6, color: 'var(--text-danger)' }}>
                    {updateSnapshot.error}
                  </p>
                )}
                {updateSnapshot?.status === 'unsupported' && (
                  <p className="settings-hint" style={{ marginTop: 8 }}>
                    {t('updates.unsupported')}
                  </p>
                )}
              </div>
            </div>
          </section>
        )}
        {activeTab === 'archived' && (
          <section className="settings-section-view">
            <SettingsHeading title={t('settings.archived')} subtitle={t('settings.archivedSubtitle')} />
            <section className="settings-panel archived-panel">
              {archivedConversations.length === 0 ? (
                <div className="archived-empty">{t('settings.noArchived')}</div>
              ) : (
                <div className="archived-list">
                  {archivedConversations.map(conversation => (
                    <article key={conversation.id} className="archived-chat">
                      <MessageSquare size={15} />
                      <span>
                        <strong>{displayConversationTitle(conversation.title, t)}</strong>
                        <small>{formatDateTime(conversation.archivedAt ?? conversation.updatedAt, language)}</small>
                      </span>
                      <button type="button" onClick={() => onRestoreConversation(conversation.id)}>
                        <RotateCcw size={14} />
                        {t('common.restore')}
                      </button>
                      <button type="button" onClick={() => onDeleteConversation(conversation.id)}>
                        <Trash2 size={14} />
                        {t('common.delete')}
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
            <h2>{t('settings.confirmFreeMode')}</h2>
            <p className="danger-copy">
              {t('settings.confirmFreeModeCopy')}
            </p>
            <ul className="risk-list">
              <li>{t('settings.riskFiles')}</li>
              <li>{t('settings.riskCommands')}</li>
              <li>{t('settings.riskSecrets')}</li>
              <li>{t('settings.riskTrusted')}</li>
            </ul>
            <div className="modal-actions">
              <button type="button" onClick={cancelFullAccessConfirmation}>
                {t('common.cancel')}
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={confirmFullAccess}
              >
                {t('settings.agree')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function updateSummary(snapshot: UpdateSnapshot, t: (key: string, vars?: Record<string, string | number | undefined>) => string): string {
  switch (snapshot.status) {
    case 'checking':
      return t('updates.statusChecking')
    case 'not-available':
      return t('updates.statusCurrent', { version: snapshot.currentVersion })
    case 'available':
      return t('updates.statusAvailable', { version: snapshot.availableVersion })
    case 'downloading':
      return t('updates.statusDownloading', { percent: Math.round(snapshot.percent ?? 0) })
    case 'downloaded':
      return t('updates.statusDownloaded', { version: snapshot.availableVersion })
    case 'error':
      return t('updates.statusError')
    default:
      return t('updates.statusUnknown')
  }
}

function displayConversationTitle(title: string, t: (key: string) => string): string {
  return title === DEFAULT_CONVERSATION_TITLE ? t('sidebar.newChat') : title
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

function ChoiceChip({ selected, onClick, children, disabled }: { selected: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={`choice-chip ${selected ? 'active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'disabled' : undefined}
    >
      {children}
    </button>
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

function modelSettingsMessage(error: string, t: (key: string) => string): string {
  if (/401|expired token|invalid.*token/i.test(error)) {
    return t('model.expired')
  }
  if (/network|fetch|timeout|tempo limite/i.test(error)) {
    return t('model.networkError')
  }
  return t('model.genericError')
}
