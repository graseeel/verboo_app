import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserSettings } from '../../../shared/types'
import { ToastProvider } from '../../components/Toast'
import { I18nProvider } from '../../i18n'
import { SettingsView } from './SettingsView'

const originalVerboo = window.verboo

const userSettings = {
  language: 'en-US',
  theme: 'system',
  defaultAccessMode: 'approval',
  fullAccessEnabled: false,
  showInMenuBar: false,
  showMenuBarText: false,
  staySignedIn: false,
  preventSleepWhileRunning: false,
  completionNotifications: 'never',
  permissionNotifications: false,
  questionNotifications: false,
  responseEnhancementsEnabled: false,
  personality: 'pragmatic',
  customInstructions: '',
  trustedCommands: [],
  customSlashCommands: [],
  memoriesEnabled: false,
  chroniclePreview: false,
  ignoreToolChatsForMemory: false,
  goalMode: { allowAutoAccess: false },
  updates: { channel: 'stable', autoCheck: false, autoDownload: false },
  visionFallbackConsent: 'ask',
  trustedSkills: [],
  includeVerbooCoAuthor: false,
  computerUse: {
    enabled: true,
    selfTestEnabled: false,
    allowlist: [],
    denylist: ['com.example.Blocked'],
    preferredVisualExecutorId: 'vision-model',
    restoreHiddenApps: true,
    auditRetentionDays: 90,
    auditStorageCapMb: 200,
    idleTimeoutSeconds: 900,
    telemetryOptOut: false,
    showInMenuBar: false,
  },
} as UserSettings

beforeEach(() => {
  ;(window as unknown as { verboo: unknown }).verboo = {
    getComputerUsePermissions: vi.fn().mockResolvedValue({
      accessibility: 'granted',
      screenRecording: 'granted',
    }),
    getComputerUseHelperPath: vi.fn().mockResolvedValue('/tmp/computer-use-helper'),
    requestComputerUsePermissions: vi.fn().mockResolvedValue({
      accessibility: 'granted',
      screenRecording: 'granted',
    }),
    openComputerUsePermissionSettings: vi.fn().mockResolvedValue(undefined),
    revealComputerUseHelper: vi.fn().mockResolvedValue(undefined),
  }
})

afterEach(() => {
  cleanup()
  ;(window as unknown as { verboo: unknown }).verboo = originalVerboo
})

function renderSettings(
  activeTab: 'app' | 'computerUse',
  onUserSettingsChange = vi.fn().mockResolvedValue(undefined),
  language: 'en-US' | 'pt-BR' = 'en-US',
  platform: NodeJS.Platform = 'darwin',
) {
  render(
    <I18nProvider language={language}>
      <ToastProvider>
        <SettingsView
          credentials={{ hasApiKey: false }}
          modelResult={{
            models: [{ id: 'vision-model', displayName: 'Vision Model', supportsVision: true, raw: {} }],
            source: 'cache',
            stale: false,
          }}
          selectedModel={{ id: 'vision-model', displayName: 'Vision Model', supportsVision: true, raw: {} }}
          theme="system"
          activeTab={activeTab}
          platform={platform}
          userSettings={userSettings}
          archivedConversations={[]}
          petEnabled={false}
          petSize={120}
          workingDirectory="/tmp/project"
          onPetToggle={vi.fn()}
          onPetSizeChange={vi.fn()}
          onOpenDashboard={vi.fn()}
          onSaveApiKey={vi.fn().mockResolvedValue(undefined)}
          onThemeChange={vi.fn()}
          onActiveTabChange={vi.fn()}
          onUserSettingsChange={onUserSettingsChange}
          onResetUserSettings={vi.fn().mockResolvedValue(undefined)}
          onRestoreConversation={vi.fn()}
          onDeleteConversation={vi.fn()}
          onCheckForUpdates={vi.fn()}
          onDownloadUpdate={vi.fn()}
          onInstallUpdate={vi.fn().mockResolvedValue(undefined)}
          onClose={vi.fn()}
        />
      </ToastProvider>
    </I18nProvider>,
  )
}

describe('SettingsView computer-use settings placement', () => {
  it('does not duplicate computer-use executor, isolation, or denylist controls in App settings', () => {
    renderSettings('app')

    expect(screen.queryByRole('button', { name: 'Preferred visual executor' })).not.toBeInTheDocument()
    expect(screen.queryByText('Restore hidden apps when finished')).not.toBeInTheDocument()
    expect(screen.queryByText('Denied apps')).not.toBeInTheDocument()
  })

  it('shows computer-use executor, isolation, denylist, and audit controls in Computer Use settings', () => {
    renderSettings('computerUse')

    expect(screen.getAllByRole('button', { name: 'Preferred visual executor' })).toHaveLength(1)
    expect(screen.getAllByText('Restore hidden apps when finished')).toHaveLength(1)
    expect(screen.getAllByText('Denied apps')).toHaveLength(1)
    expect(screen.getByText('com.example.Blocked')).toBeInTheDocument()
    expect(screen.getByText('Local audit storage (MB)')).toBeInTheDocument()
  })

  it.each(['win32', 'linux'] as const)(
    'shows an explicit macOS-only notice and hides native controls on %s',
    platform => {
      renderSettings('computerUse', undefined, 'en-US', platform)

      expect(screen.getByText('Computer Use is currently available only on macOS.')).toBeInTheDocument()
      expect(screen.queryByText('Accessibility')).not.toBeInTheDocument()
      expect(screen.queryByText('Screen Recording')).not.toBeInTheDocument()
      expect(window.verboo.getComputerUsePermissions).not.toHaveBeenCalled()
    },
  )

  it('keeps the moved controls wired to the existing computer-use settings', () => {
    const onUserSettingsChange = vi.fn().mockResolvedValue(undefined)
    renderSettings('computerUse', onUserSettingsChange)

    expect(screen.getByRole('button', { name: /Restore hidden apps when finished/i })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Preferred visual executor' }))
    fireEvent.click(screen.getByRole('option', { name: 'Automatic' }))
    expect(onUserSettingsChange).toHaveBeenCalledWith({
      computerUse: { ...userSettings.computerUse, preferredVisualExecutorId: undefined },
    })

    fireEvent.change(screen.getByRole('textbox', { name: /Bundle ID/i }), {
      target: { value: 'com.example.NewBlocked' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Block app' }))
    expect(onUserSettingsChange).toHaveBeenCalledWith({
      computerUse: {
        ...userSettings.computerUse,
        denylist: [...userSettings.computerUse.denylist, 'com.example.NewBlocked'],
      },
    })

    fireEvent.change(screen.getByDisplayValue('200'), { target: { value: '350' } })
    expect(onUserSettingsChange).toHaveBeenCalledWith({
      computerUse: { ...userSettings.computerUse, auditStorageCapMb: 350 },
    })
  })

  it('gives every numeric field and TCC settings button a distinct accessible name', () => {
    renderSettings('computerUse')

    expect(screen.getByRole('spinbutton', { name: 'Idle timeout (minutes)' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Audit retention (days)' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Local audit storage (MB)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Accessibility settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Screen Recording settings' })).toBeInTheDocument()
  })

  it('shows localized controlled copy instead of a raw permission error', async () => {
    const rawError = new Error('private backend detail')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ;(window.verboo.requestComputerUsePermissions as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(rawError)
    renderSettings('computerUse', undefined, 'pt-BR')

    fireEvent.click(screen.getByRole('button', { name: 'Autorizar no macOS' }))

    expect(await screen.findByText('Não foi possível verificar as permissões do macOS.')).toBeInTheDocument()
    expect(screen.queryByText(/private backend detail/i)).not.toBeInTheDocument()
    expect(consoleError).toHaveBeenCalledWith(
      '[computer-use] request macOS permissions',
      rawError,
    )
  })
})
