import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../../i18n'
import { ToastProvider } from '../../components/Toast'
import { SettingsView } from './SettingsView'
import type { SettingsViewProps } from './SettingsView'
import type { UserSettings } from '../../../shared/types'

/**
 * SettingsView render test — the sound master switch. The user ordered
 * a GUARANTEED off switch ("som que não se desliga vira tortura"), so
 * what is proven here is EXHIBITION in the real DOM and the toggle's
 * effect — not that a handler merely exists (the montagem-vs-exibição
 * lesson this project paid for six times).
 *
 * The heavy prop list is stubbed with casts; the low-level bridge double
 * only makes real child components mountable. The assertions exercise the
 * rendered controls rather than a mocked settings surface.
 */

afterEach(cleanup)

beforeEach(() => {
  ;(window as unknown as { verboo: unknown }).verboo = {
    getVideoComponentState: vi.fn(async () => ({ asrModel: 'absent' })),
    onVideoTranscriberProgress: vi.fn(() => () => {}),
    chromeIntegrationStatus: vi.fn(async () => ({
      extension: 'managed',
      bridge: 'managed',
      mcp: 'managed',
      connection: 'waitingForChrome',
      panelState: 'notApplicable',
      aggregate: 'ready',
      installedVersion: '0.5.2',
      availableVersion: '0.5.2',
      canConfigure: false,
      canRepair: false,
      canRemove: false,
      storeUrlAvailable: false,
      developmentBuild: false,
      extensionIdSource: 'release',
    })),
    readProjectInstructionFile: vi.fn(async () => ({ exists: false, content: '' })),
    writeProjectInstructionFile: vi.fn(async () => {}),
  }
})

function buildProps(overrides: Partial<SettingsViewProps> = {}): SettingsViewProps {
  const userSettings = {
    language: 'en-US',
    theme: 'system',
    defaultAccessMode: 'approval',
    fullAccessEnabled: false,
    showInMenuBar: true,
    showMenuBarText: true,
    staySignedIn: true,
    preventSleepWhileRunning: true,
    customInstructions: '',
    completionNotifications: 'background',
    permissionNotifications: true,
    questionNotifications: true,
    responseEnhancementsEnabled: true,
    personality: 'pragmatic',
    trustedCommands: [{ id: 'trusted-1', command: 'npm test', createdAt: 1, useCount: 1 }],
    customSlashCommands: [],
    memoriesEnabled: true,
    chroniclePreview: true,
    ignoreToolChatsForMemory: true,
    updates: { channel: 'stable', autoCheck: true, autoDownload: false },
    videoFallbackConsent: 'ask',
    includeVerbooCoAuthor: false,
    browserVerificationEnabled: true,
    loadWebIcons: true,
    avatar: { kind: 'preset', presetId: 'cat', presetColor: '#6B7280' },
  } as unknown as UserSettings
  return {
    credentials: { hasApiKey: true, apiKeyHint: '…1234' },
    modelResult: {} as SettingsViewProps['modelResult'],
    theme: 'system',
    activeTab: 'general' as SettingsViewProps['activeTab'],
    userSettings,
    browserAvailable: true,
    petEnabled: false,
    petSize: 32,
    profile: {
      status: 'ready',
      user: { name: 'Ada' },
      summary: { totalTokens: 42, tokensInTotal: 16, tokensOutTotal: 26, reqTotal: 3 },
      plan: { name: 'Pro', status: 'active' },
    },
    profileLoading: false,
    updateSnapshot: {
      status: 'not-available',
      channel: 'stable',
      currentVersion: '0.6.2',
      stableChannelAvailable: true,
    },
    workingDirectory: '/tmp',
    onPetToggle: () => {},
    onPetSizeChange: () => {},
    onOpenDashboard: () => {},
    onSaveApiKey: async () => {},
    onThemeChange: () => {},
    onActiveTabChange: () => {},
    onUserSettingsChange: async () => {},
    onRefreshProfile: () => {},
    onManagePlan: () => {},
    onUpdateAvatar: () => {},
    soundsEnabled: true,
    onSoundsEnabledChange: () => {},
    onResetUserSettings: async () => {},
    onCheckForUpdates: async () => ({} as Awaited<ReturnType<SettingsViewProps['onCheckForUpdates']>>),
    onDownloadUpdate: async () => ({} as Awaited<ReturnType<SettingsViewProps['onDownloadUpdate']>>),
    onInstallUpdate: async () => {},
    onClose: () => {},
    ...overrides,
  }
}

function SettingsTestView({ props, language = 'en-US' }: { props: SettingsViewProps; language?: 'en-US' | 'pt-BR' }) {
  return (
    <I18nProvider language={language}>
      <ToastProvider>
        <SettingsView {...props} />
      </ToastProvider>
    </I18nProvider>
  )
}

function renderSettings(props: SettingsViewProps) {
  return render(<SettingsTestView props={props} />)
}

describe('SettingsView → Notifications: the sound master switch REACHES THE SCREEN', () => {
  it('renders the Sounds toggle with its explanation inside the notifications section', () => {
    renderSettings(buildProps())
    expect(screen.getByText('Sounds')).toBeTruthy()
    expect(
      screen.getByText('Play a gentle sound when Verboo finishes or needs your attention.'),
    ).toBeTruthy()
  })

  it('there is EXACTLY ONE sounds toggle — no duplicated switch (the noise class)', () => {
    renderSettings(buildProps())
    expect(screen.getAllByText('Sounds')).toHaveLength(1)
  })

  it('the toggle reflects the persisted state and FIRES the change with the negated value', () => {
    const onSoundsEnabledChange = vi.fn()
    const { container } = renderSettings(buildProps({ soundsEnabled: true, onSoundsEnabledChange }))
    const row = screen.getByText('Sounds').closest('button')!
    expect(row.querySelector('.toggle-switch.on')).not.toBeNull()
    fireEvent.click(row)
    expect(onSoundsEnabledChange).toHaveBeenCalledTimes(1)
    expect(onSoundsEnabledChange).toHaveBeenCalledWith(false)
  })

  it('renders pt-BR copy when the locale is pt-BR (both locales, never an orphan key)', () => {
    render(
      <I18nProvider language="pt-BR">
        <ToastProvider>
          <SettingsView {...buildProps()} />
        </ToastProvider>
      </I18nProvider>,
    )
    expect(screen.getByText('Sons')).toBeTruthy()
    expect(
      screen.getByText('Tocar um som suave quando o Verboo terminar ou precisar da sua atenção.'),
    ).toBeTruthy()
  })
})

describe('SettingsView redesign → the five grouped tabs keep their real controls', () => {
  it('renders General with app behavior, notifications, updates, and the global reset', () => {
    renderSettings(buildProps({ activeTab: 'general' as SettingsViewProps['activeTab'], petEnabled: true }))

    expect(screen.getByRole('heading', { name: 'General', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Show in menu bar/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Expand MenuBar text/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Prevent sleep while running/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Co-author commits as Verboo Code/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Show the pet/ })).toBeInTheDocument()
    expect(screen.getByLabelText('Pet size')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Completion notifications' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Permission notifications/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Question notifications/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Sounds/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Check automatically/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Download automatically/ })).toBeInTheDocument()
    expect(screen.getByText('Update channel')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeInTheDocument()
    expect(screen.getByText('Version 0.6.2 is current.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset app preferences' })).toBeInTheDocument()
  })

  it('renders Account with avatar, credentials, consumption, and plan controls', () => {
    renderSettings(buildProps({ activeTab: 'account' as SettingsViewProps['activeTab'] }))

    expect(screen.getByRole('heading', { name: 'Account', level: 1 })).toBeInTheDocument()
    expect(screen.getByLabelText('Upload photo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '#6B7280' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset to initials' })).toBeInTheDocument()
    expect(screen.getByLabelText('API key')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Stay signed in/ })).toBeInTheDocument()
    expect(screen.getByText('Total tokens')).toBeInTheDocument()
    expect(screen.getByText('Input')).toBeInTheDocument()
    expect(screen.getByText('Output')).toBeInTheDocument()
    expect(screen.getByText('Requests')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Manage plan' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Verboo dashboard' })).toBeInTheDocument()
  })

  it('loads Account profile data on opening without reloading fresh data after a tab switch', async () => {
    const onRefreshProfile = vi.fn()
    const unavailableProfile = { status: 'unauthenticated' as const }
    const freshProfile = {
      status: 'ready' as const,
      user: { name: 'Ada' },
      summary: { totalTokens: 42, tokensInTotal: 16, tokensOutTotal: 26, reqTotal: 3 },
      plan: { name: 'Pro', status: 'active' },
    }
    const { rerender } = renderSettings(buildProps({
      activeTab: 'general' as SettingsViewProps['activeTab'],
      profile: unavailableProfile,
      onRefreshProfile,
    }))

    expect(onRefreshProfile).not.toHaveBeenCalled()

    rerender(<SettingsTestView props={buildProps({
      activeTab: 'account' as SettingsViewProps['activeTab'],
      profile: unavailableProfile,
      onRefreshProfile,
    })} />)

    await waitFor(() => expect(onRefreshProfile).toHaveBeenCalledTimes(1))

    rerender(<SettingsTestView props={buildProps({
      activeTab: 'general' as SettingsViewProps['activeTab'],
      profile: freshProfile,
      onRefreshProfile,
    })} />)
    rerender(<SettingsTestView props={buildProps({
      activeTab: 'account' as SettingsViewProps['activeTab'],
      profile: freshProfile,
      onRefreshProfile,
    })} />)

    expect(onRefreshProfile).toHaveBeenCalledTimes(1)
  })

  it('points unavailable Account data to the API key field below in Portuguese', () => {
    render(<SettingsTestView
      language="pt-BR"
      props={buildProps({
        activeTab: 'account' as SettingsViewProps['activeTab'],
        profile: { status: 'unauthenticated' },
      })}
    />)

    expect(screen.getByText('Configure ou atualize a chave de API abaixo para carregar o consumo e os detalhes do plano.')).toBeInTheDocument()
  })

  it('renders an unavailable model notice as a warning', () => {
    renderSettings(buildProps({
      activeTab: 'account' as SettingsViewProps['activeTab'],
      modelResult: {
        models: [],
        source: 'none',
        stale: false,
        error: 'network unavailable',
      },
    }))

    expect(screen.getByText('Could not refresh models right now.')).toHaveClass('settings-warning')
  })

  it('renders Context with personalization, memory, and project instructions', async () => {
    renderSettings(buildProps({ activeTab: 'context' as SettingsViewProps['activeTab'] }))

    expect(screen.getByRole('heading', { name: 'Context', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^App response improvements/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Personality' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Custom instructions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save instructions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Enable memories/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Local search preview/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Ignore tool chats/ })).toBeInTheDocument()
    expect(await screen.findByRole('tab', { name: 'AGENTS.md' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'CLAUDE.md' })).toBeInTheDocument()
  })

  it('renders Security with approval modes and trusted commands', () => {
    renderSettings(buildProps({ activeTab: 'security' as SettingsViewProps['activeTab'] }))

    expect(screen.getByRole('heading', { name: 'Security', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Ask for approval/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Approve for me/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Free mode/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enable free mode' })).toBeInTheDocument()
    expect(screen.getByText('npm test')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('renders Integrations with Chrome, video understanding, custom commands, and browser options', async () => {
    renderSettings(buildProps({ activeTab: 'integrations' as SettingsViewProps['activeTab'] }))

    expect(screen.getByRole('heading', { name: 'Integrations', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Verboo in Chrome', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Ask every time' })).toBeInTheDocument()
    expect(screen.getByText('Local audio transcription model')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add command' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Post-edit visual verification/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Load plugin icons from the web/ })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Refresh integration status' })).toBeInTheDocument()
  })

  it('does not render Archived chats as a Settings tab', () => {
    renderSettings(buildProps({ activeTab: 'general' as SettingsViewProps['activeTab'] }))

    expect(screen.queryByRole('button', { name: 'Archived chats' })).not.toBeInTheDocument()
  })

  it('uses the accented Portuguese labels for the five grouped tabs', () => {
    render(
      <I18nProvider language="pt-BR">
        <ToastProvider>
          <SettingsView {...buildProps({ activeTab: 'general' as SettingsViewProps['activeTab'] })} />
        </ToastProvider>
      </I18nProvider>,
    )

    expect(screen.getByRole('button', { name: 'Geral' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Conta' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Contexto' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Segurança' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Integrações' })).toBeInTheDocument()
  })
})
