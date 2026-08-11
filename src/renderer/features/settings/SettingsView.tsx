import {
  ArrowLeft,
  Blocks,
  Brain,
  Check,
  ChevronDown,
  Computer,
  Ghost,
  KeyRound,
  Languages,
  Moon,
  Palette,
  RefreshCcw,
  Shield,
  ShieldCheck,
  Trash2,
  UserCog,
} from 'lucide-react'
import { ChromeLogoIcon } from '../../components/ChromeLogoIcon'
import { type ComponentType, useEffect, useRef, useState } from 'react'
import type {
  AccessMode,
  AvatarSettings,
  CompletionNotificationMode,
  CredentialStatus,
  ModelDiscoveryResult,
  PersonalityMode,
  ProfileResult,
  ProviderAuthStatus,
  SettingsTab,
  ThemeMode,
  UpdateSettings,
  UpdateSnapshot,
  UserSettings,
  VerbooModel,
} from '../../../shared/types'
import { ProjectInstructionsEditor } from './ProjectInstructionsEditor'
import { CustomCommandsManager } from './CustomCommandsManager'
import { ChromeIntegrationSettings } from './ChromeIntegrationSettings'
import { ProviderIntegrations } from './ProviderIntegrations'
import { VideoUnderstandingSettings } from './VideoUnderstandingSettings'
import { LanguageSelector } from '../language/LanguageSelector'
import { ProfileView } from '../profile/ProfileView'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { useToast } from '../../components/Toast'
import { AVATAR_PALETTE, AVATAR_PRESETS, renderPreset } from '../profile/avatarPresets'
import { AvatarIcon } from '../../components/AvatarIcon'
import { formatDateTime, useI18n } from '../../i18n'
import type { ProviderAccountsController } from './useProviderAccounts'
import type { ExternalProviderId } from '../../../shared/types'

export type SettingsViewProps = {
  credentials: CredentialStatus
  modelResult: ModelDiscoveryResult
  selectedModel?: VerbooModel
  theme: ThemeMode
  activeTab: SettingsTab
  userSettings: UserSettings
  browserAvailable: boolean
  petEnabled: boolean
  petSize: number
  profile: ProfileResult
  profileLoading: boolean
  /** F4: the login bridge universe — one entry per supported provider,
   *  connected=false included (provider_auth_status). */
  providerStatuses: ProviderAuthStatus[]
  /** Provider whose login flow is active (its card shows live progress). */
  connectingProvider?: string
  /** Stage of the active login flow, driven by provider-login:event. */
  providerLoginStage?: 'starting' | 'awaiting_browser'
  onProviderConnect: (providerId: string, reconnectAccountId?: string) => void
  /** Aborts the active login flow (provider_login_cancel). */
  onProviderLoginCancel: () => void
  providerAccounts?: ProviderAccountsController
  conversationProviderBindings?: Partial<Record<ExternalProviderId, string>>
  providerSwitchLocked?: boolean
  onProviderAccountUse?: (provider: ExternalProviderId, accountId: string) => void
  onProviderAccountRemoved?: (provider: ExternalProviderId, accountId: string) => void
  updateSnapshot?: UpdateSnapshot
  workingDirectory: string
  onPetToggle: () => void
  onPetSizeChange: (size: number) => void
  onOpenDashboard: () => void
  onRefreshProfile: () => void
  onManagePlan: () => void
  onUpdateAvatar: (settings: AvatarSettings) => void
  onSaveApiKey: (apiKey: string) => Promise<void>
  onThemeChange: (theme: ThemeMode) => void
  onActiveTabChange: (tab: SettingsTab) => void
  onUserSettingsChange: (patch: Partial<UserSettings>) => Promise<void>
  /** Master switch for the app's TWO sounds (notification + conclusion).
   *  Renderer-persisted (localStorage) — deliberately NOT in
   *  UserSettings: that contract crosses the Rust bridge (PERISCOPIO). */
  soundsEnabled: boolean
  onSoundsEnabledChange: (enabled: boolean) => void
  onResetUserSettings: () => Promise<void>
  onCheckForUpdates: (userInitiated?: boolean) => Promise<UpdateSnapshot>
  onDownloadUpdate: () => Promise<UpdateSnapshot>
  onInstallUpdate: () => Promise<void>
  onClose: () => void
}

export function SettingsView({
  credentials,
  modelResult,
  selectedModel,
  theme,
  activeTab,
  userSettings,
  browserAvailable,
  petEnabled,
  petSize,
  profile,
  profileLoading,
  providerStatuses,
  connectingProvider,
  providerLoginStage,
  onProviderConnect,
  onProviderLoginCancel,
  providerAccounts,
  conversationProviderBindings = {},
  providerSwitchLocked = false,
  onProviderAccountUse = () => {},
  onProviderAccountRemoved = () => {},
  updateSnapshot,
  workingDirectory,
  onPetToggle,
  onPetSizeChange,
  onOpenDashboard,
  onRefreshProfile,
  onManagePlan,
  onUpdateAvatar,
  onSaveApiKey,
  onThemeChange,
  onActiveTabChange,
  onUserSettingsChange,
  soundsEnabled,
  onSoundsEnabledChange,
  onResetUserSettings,
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
  const settingsTabs: Array<{ id: SettingsTab; label: string; icon: ComponentType<{ size?: number }> }> = [
    { id: 'general', label: t('settings.general'), icon: Computer },
    { id: 'account', label: t('settings.account'), icon: UserCog },
    { id: 'context', label: t('settings.context'), icon: Brain },
    { id: 'security', label: t('settings.security'), icon: Shield },
    // T11 (owner's order): AI providers get their OWN tab — they sat inside
    // Integrations (the Chrome tab, browser icon), a subject they don't
    // belong to. Icon is lucide Blocks, NOT the browser logo.
    { id: 'providers', label: t('settings.providers'), icon: Blocks },
    { id: 'integrations', label: t('settings.integrations'), icon: ChromeLogoIcon },
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
        {activeTab === 'security' && (
          <section className="settings-section-view">
            <SettingsHeading title={t('settings.security')} subtitle={t('settings.securitySubtitle')} />
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
            <section className="settings-panel trusted-command-panel">
              <div>
                <h2>{t('settings.trustedCommands')}</h2>
                <p>{t('settings.trustedCommandsSubtitle')}</p>
              </div>
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

        {activeTab === 'general' && (
          <section className="settings-section-view">
            <SettingsHeading title={t('settings.general')} subtitle={t('settings.generalSubtitle')} />

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
                <button className={theme === 'system' ? 'active' : ''} type="button" onClick={() => onThemeChange('system')}>
                  <Computer size={15} />
                  {t('settings.system')}
                </button>
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
              <SettingToggle
                title={t('settings.includeVerbooCoAuthor')}
                body={t('settings.includeVerbooCoAuthorBody')}
                checked={userSettings.includeVerbooCoAuthor}
                onChange={includeVerbooCoAuthor => onUserSettingsChange({ includeVerbooCoAuthor })}
              />
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
                      aria-label={t('settings.petSize')}
                      min={72}
                      max={260}
                      value={petSize}
                      onChange={event => onPetSizeChange(Number(event.target.value))}
                    />
                  </div>
                </div>
              )}
            </section>

            <section className="settings-panel">
              <div>
                <h2>{t('settings.notifications')}</h2>
                <p>{t('settings.notificationsSubtitle')}</p>
              </div>
              <label className="settings-select-row">
                <span>
                  <strong>{t('settings.completionNotifications')}</strong>
                  <small>{t('settings.completionNotificationsBody')}</small>
                </span>
                <SettingsSelect
                  value={userSettings.completionNotifications}
                  ariaLabel={t('settings.completionNotifications')}
                  options={[
                    { value: 'always', label: t('settings.always') },
                    { value: 'background', label: t('settings.backgroundOnly') },
                    { value: 'never', label: t('settings.never') },
                  ]}
                  onChange={mode => onUserSettingsChange({ completionNotifications: mode as CompletionNotificationMode })}
                />
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
              <SettingToggle
                title={t('settings.sounds')}
                body={t('settings.soundsBody')}
                checked={soundsEnabled}
                onChange={onSoundsEnabledChange}
              />
            </section>

            <section className="settings-panel">
              <div>
                <h2>{t('updates.title')}</h2>
                <p>{t('updates.channelBody')}</p>
              </div>
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
                    disabled={!updateSnapshot?.stableChannelAvailable}
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
                {!updateSnapshot?.stableChannelAvailable && (
                  <p className="settings-hint" style={{ marginTop: 6, color: 'var(--text-muted)' }}>
                    {t('updates.stableDisabled')}
                  </p>
                )}
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
                      {t(updateSnapshot.target === 'both'
                        ? 'updates.downloadBoth'
                        : updateSnapshot.target === 'cli'
                          ? 'updates.downloadCli'
                          : 'updates.download')}
                    </button>
                  )}
                  {updateSnapshot?.status === 'downloaded' && (
                    <button className="button button-sm button-primary" onClick={() => onInstallUpdate()}>
                      {t(updateSnapshot.target === 'both'
                        ? 'updates.restartBoth'
                        : updateSnapshot.target === 'cli'
                          ? 'updates.restartCli'
                          : 'updates.restart')}
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
            </section>

            <section className="settings-panel">
              <button className="danger-soft-button" type="button" onClick={onResetUserSettings}>
                <RefreshCcw size={15} />
                {t('settings.resetPreferences')}
              </button>
            </section>
          </section>
        )}

        {activeTab === 'account' && (
          <section className="settings-section-view">
            <SettingsHeading title={t('settings.account')} subtitle={t('settings.accountSubtitle')} />
            <ProfileView
              profile={profile}
              loading={profileLoading}
              avatarSettings={userSettings.avatar}
              onRefresh={onRefreshProfile}
              onManagePlan={onManagePlan}
              onUpdateAvatar={onUpdateAvatar}
            />
            <section className="settings-panel">
              <div className="settings-row">
                <KeyRound size={16} />
                <div>
                  <strong>{t('settings.apiKey')}</strong>
                  <p>{credentials.hasApiKey
                    ? t('settings.apiKeyConfigured', { hint: credentials.apiKeyHint ?? '' })
                    : t('settings.apiKeyMissing')}</p>
                </div>
              </div>
              <div className="api-key-form">
                <input
                  aria-label={t('settings.apiKey')}
                  type="password"
                  value={apiKey}
                  placeholder={t('settings.apiKeyPlaceholder')}
                  onChange={event => setApiKey(event.target.value)}
                />
                <button type="button" onClick={() => void submitApiKey()} disabled={saving || !apiKey.trim()}>
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
              <button className="button button-sm button-secondary" type="button" onClick={onOpenDashboard}>
                {t('settings.openDashboard')}
              </button>
            </section>
          </section>
        )}

        {activeTab === 'context' && (
          <section className="settings-section-view">
            <SettingsHeading title={t('settings.context')} subtitle={t('settings.contextSubtitle')} />
            <div className="settings-group-heading">
              <h2>{t('settings.personalization')}</h2>
              <p>{t('settings.personalizationSubtitle')}</p>
            </div>
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
                <SettingsSelect
                  value={userSettings.personality}
                  ariaLabel={t('settings.personality')}
                  disabled={!userSettings.responseEnhancementsEnabled}
                  options={[
                    { value: 'pragmatic', label: t('settings.personalityPragmatic') },
                    { value: 'concise', label: t('settings.personalityConcise') },
                    { value: 'explanatory', label: t('settings.personalityExplanatory') },
                  ]}
                  onChange={mode => onUserSettingsChange({ personality: mode as PersonalityMode })}
                />
              </label>
              <label className="custom-instructions-field">
                <span>
                  <strong>{t('settings.customInstructions')}</strong>
                  <small>{t('settings.customInstructionsBody')}</small>
                </span>
                <textarea
                  aria-label={t('settings.customInstructions')}
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

            <div className="settings-group-heading">
              <h2>{t('settings.memory')}</h2>
              <p>{t('settings.memorySubtitle')}</p>
            </div>
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
            </section>

            <div className="settings-group-heading">
              <h2>{t('settings.projectInstructions')}</h2>
              <p>{t('settings.projectInstructionsSubtitle')}</p>
            </div>
            <ProjectInstructionsEditor workingDirectory={workingDirectory} />
          </section>
        )}

        {activeTab === 'providers' && (
          <section className="settings-section-view settings-providers-view">
            <SettingsHeading title={t('settings.providers')} subtitle={t('settings.providers.subtitle')} />
            {/* The risk-consent dialog rides the connect flow and is rendered
                at App level. Account discovery must finish before choosing
                between the multi-account surface and the legacy CLI fallback. */}
            <ProviderIntegrations
              statuses={providerStatuses}
              onConnect={onProviderConnect}
              connectingProvider={connectingProvider}
              loginStage={providerLoginStage}
              onCancelLogin={onProviderLoginCancel}
              capabilities={providerAccounts?.capabilities}
              accountRows={providerAccounts?.rows}
              accountsLoaded={providerAccounts ? providerAccounts.accountsLoaded : true}
              conversationBindings={conversationProviderBindings}
              switchLocked={providerSwitchLocked}
              onSetDefault={(provider, accountId) => {
                void providerAccounts?.setDefault(provider, accountId).catch(error => {
                  toast(t('settings.provider.connectError', { message: error instanceof Error ? error.message : String(error) }), 'error')
                })
              }}
              onUse={onProviderAccountUse}
              onRemove={onProviderAccountRemoved}
              onRefreshAccount={(provider, accountId) => {
                void providerAccounts?.refreshAccount(provider, accountId).catch(error => {
                  toast(t('settings.provider.connectError', { message: error instanceof Error ? error.message : String(error) }), 'error')
                })
              }}
            />
          </section>
        )}

        {activeTab === 'integrations' && (
          <section className="settings-section-view">
            <SettingsHeading title={t('settings.integrations')} subtitle={t('settings.integrationsSubtitle')} />
            <div className="settings-group-heading">
              <h2>{t('chrome.title')}</h2>
              <p>{t('chrome.subtitle')}</p>
            </div>
            <ChromeIntegrationSettings />
            <VideoUnderstandingSettings
              consent={userSettings.videoFallbackConsent}
              onConsentChange={videoFallbackConsent => onUserSettingsChange({ videoFallbackConsent })}
            />
            <div className="settings-group-heading">
              <h2>{t('settings.customCommands')}</h2>
              <p>{t('settings.customCommandsSubtitle')}</p>
            </div>
            <CustomCommandsManager
              commands={userSettings.customSlashCommands}
              onSave={customSlashCommands => onUserSettingsChange({ customSlashCommands })}
            />
            <section className="settings-panel">
              {browserAvailable && (
                <SettingToggle
                  title={t('settings.browserVerification')}
                  body={t('settings.browserVerificationBody')}
                  checked={userSettings.browserVerificationEnabled}
                  onChange={browserVerificationEnabled => onUserSettingsChange({ browserVerificationEnabled })}
                />
              )}
              <SettingToggle
                title={t('settings.loadWebIcons')}
                body={t('settings.loadWebIconsBody')}
                checked={userSettings.loadWebIcons}
                onChange={loadWebIcons => onUserSettingsChange({ loadWebIcons })}
              />
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
      return snapshot.target === 'both'
        ? t('updates.statusBothAvailable', {
            appVersion: snapshot.availableVersion,
            cliVersion: snapshot.cliAvailableVersion,
          })
        : snapshot.target === 'cli'
          ? t('updates.statusCliAvailable', { version: snapshot.cliAvailableVersion })
          : t('updates.statusAvailable', { version: snapshot.availableVersion })
    case 'downloading':
      return t('updates.statusDownloading', { percent: Math.round(snapshot.percent ?? 0) })
    case 'downloaded':
      return snapshot.target === 'both'
        ? t('updates.statusBothDownloaded', {
            appVersion: snapshot.availableVersion,
            cliVersion: snapshot.cliAvailableVersion,
          })
        : snapshot.target === 'cli'
          ? t('updates.statusCliDownloaded', { version: snapshot.cliAvailableVersion })
          : t('updates.statusDownloaded', { version: snapshot.availableVersion })
    case 'error':
      return t('updates.statusError')
    default:
      return t('updates.statusUnknown')
  }
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

// Custom select mirroring LanguageSelector's trigger + popover pattern, so
// settings dropdowns match the app-styled dropdown used for language picking
// (instead of falling back to the OS-native <select> popover). Reused by
// completion-notifications and personality modes; right-aligns with the
// sibling toggle-switch thanks to the shared .settings-toggle-row grid.
function SettingsSelect<T extends string>({
  value,
  options,
  ariaLabel,
  disabled = false,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  ariaLabel: string
  disabled?: boolean
  onChange: (value: T) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useOutsideDismiss(rootRef, open, () => setOpen(false))

  const current = options.find(option => option.value === value) ?? options[0]

  return (
    <div ref={rootRef} className="settings-select">
      <button
        type="button"
        className="settings-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen(isOpen => !isOpen)}
      >
        <span>{current?.label}</span>
        <ChevronDown size={13} className={`settings-select-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="settings-select-menu popover-panel t-dropdown is-open" role="listbox" aria-label={ariaLabel}>
          {options.map(option => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`settings-select-option ${option.value === value ? 'selected' : ''}`}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              <span className="settings-select-check" aria-hidden="true">
                {option.value === value && <Check size={13} />}
              </span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
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

function modelSettingsMessage(error: string, t: (key: string) => string): string {
  if (/401|expired token|invalid.*token/i.test(error)) {
    return t('model.expired')
  }
  if (/network|fetch|timeout|tempo limite/i.test(error)) {
    return t('model.networkError')
  }
  return t('model.genericError')
}
