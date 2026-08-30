import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../../i18n'
import { ToastProvider } from '../../components/Toast'
import { SettingsView } from './SettingsView'
import type { SettingsViewProps } from './SettingsView'
import type { ProviderAuthStatus, UpdateSnapshot, UserSettings } from '../../../shared/types'

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
    openDiagnosticLogsDir: vi.fn(async () => ''),
    diagnosticLogStatus: vi.fn(async () => ({ active: true, degraded: false, dir: '/tmp/logs' })),
    diagnosticPackage: vi.fn(async () => 'sanitized diagnostic package'),
    clipboardWriteText: vi.fn(async () => true),
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
    modelResult: { models: [], source: 'none', stale: false } as SettingsViewProps['modelResult'],
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
    platform: 'darwin',
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
    providerStatuses: [],
    onProviderConnect: () => {},
    onProviderLoginCancel: () => {},
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
    expect(screen.getByRole('button', { name: 'Open logs folder' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset app preferences' })).toBeInTheDocument()
  })

  it('opens the local logs folder from General without sending anything over the network', async () => {
    const openDiagnosticLogsDir = vi.fn().mockResolvedValue('/tmp/logs')
    ;(window as unknown as { verboo: Record<string, unknown> }).verboo = {
      ...(window as unknown as { verboo: Record<string, unknown> }).verboo,
      openDiagnosticLogsDir,
    }
    renderSettings(buildProps({ activeTab: 'general' as SettingsViewProps['activeTab'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Open logs folder' }))
    await waitFor(() => expect(openDiagnosticLogsDir).toHaveBeenCalledTimes(1))
  })

  it('copies the sanitized diagnostic package and confirms success', async () => {
    const diagnosticPackage = vi.fn().mockResolvedValue('sanitized diagnostic package')
    const clipboardWriteText = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { verboo: Record<string, unknown> }).verboo = {
      ...(window as unknown as { verboo: Record<string, unknown> }).verboo,
      diagnosticPackage,
      clipboardWriteText,
    }

    renderSettings(buildProps({ activeTab: 'general' as SettingsViewProps['activeTab'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))

    await waitFor(() => expect(diagnosticPackage).toHaveBeenCalledWith())
    expect(clipboardWriteText).toHaveBeenCalledWith('sanitized diagnostic package')
    expect(await screen.findByText('Diagnostic package copied.')).toBeInTheDocument()
  })

  it('reports a diagnostic package failure without claiming it copied', async () => {
    const diagnosticPackage = vi.fn().mockRejectedValue(new Error('package unavailable'))
    const clipboardWriteText = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { verboo: Record<string, unknown> }).verboo = {
      ...(window as unknown as { verboo: Record<string, unknown> }).verboo,
      diagnosticPackage,
      clipboardWriteText,
    }

    renderSettings(buildProps({ activeTab: 'general' as SettingsViewProps['activeTab'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))

    expect(await screen.findByText('Could not copy the diagnostic package.')).toBeInTheDocument()
    expect(clipboardWriteText).not.toHaveBeenCalled()
    expect(screen.queryByText('Diagnostic package copied.')).not.toBeInTheDocument()
  })

  it('warns in the logs section when diagnostic logging is degraded', async () => {
    const diagnosticLogStatus = vi.fn().mockResolvedValue({
      active: true,
      degraded: true,
      dir: '/tmp/logs',
    })
    ;(window as unknown as { verboo: Record<string, unknown> }).verboo = {
      ...(window as unknown as { verboo: Record<string, unknown> }).verboo,
      diagnosticLogStatus,
    }

    renderSettings(buildProps({ activeTab: 'general' as SettingsViewProps['activeTab'] }))

    expect(await screen.findByText(
      'Diagnostic logging is degraded. Some recent events may be missing.',
    )).toHaveClass('settings-warning')
  })

  it('does not warn when diagnostic logging reports normal status', async () => {
    const diagnosticLogStatus = vi.fn().mockResolvedValue({
      active: true,
      degraded: false,
      dir: '/tmp/logs',
    })
    ;(window as unknown as { verboo: Record<string, unknown> }).verboo = {
      ...(window as unknown as { verboo: Record<string, unknown> }).verboo,
      diagnosticLogStatus,
    }

    renderSettings(buildProps({ activeTab: 'general' as SettingsViewProps['activeTab'] }))

    await waitFor(() => expect(diagnosticLogStatus).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(
      'Diagnostic logging is degraded. Some recent events may be missing.',
    )).not.toBeInTheDocument()
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

  it.each([
    [
      'en-US' as const,
      'Free mode',
      'Run without new approvals in trusted workspaces',
      'Enable it in Settings > Security to unlock this mode.',
    ],
    [
      'pt-BR' as const,
      'Modo livre',
      'Executar sem novas aprovações em workspaces confiáveis',
      'Ative em Configurações > Segurança para liberar este modo.',
    ],
  ])('uses the normal Free mode description instead of the circular hint in Security (%s)', (
    language,
    title,
    description,
    circularHint,
  ) => {
    render(<SettingsTestView
      language={language}
      props={buildProps({ activeTab: 'security' as SettingsViewProps['activeTab'] })}
    />)

    const freeModeRow = screen.getByRole('button', { name: new RegExp(`^${title}`) })
    expect(within(freeModeRow).getByText(description)).toBeInTheDocument()
    expect(within(freeModeRow).queryByText(circularHint)).not.toBeInTheDocument()
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

  it('uses the accented Portuguese labels for the six grouped tabs', () => {
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
    expect(screen.getByRole('button', { name: 'Provedores' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Integrações' })).toBeInTheDocument()
  })
})

describe('SettingsView → tray copy per platform (issue #91)', () => {
  // The tray icon exists on Win/Linux (system tray), but the title text is
  // macOS-only (`TrayIcon::set_title` is cfg-gated in lib.rs) — so "Expand
  // MenuBar text" must not render outside darwin, and the visibility toggle
  // must name the system tray instead of the macOS menu bar.
  it.each(['linux', 'win32'] as const)('on %s: system tray copy, no macOS-only controls', platform => {
    renderSettings(buildProps({ platform }))

    expect(screen.getByRole('button', { name: /^Show in system tray/ })).toBeInTheDocument()
    expect(screen.getByText('Keep Verboo in the system tray when the main window is closed.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Show in menu bar/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Expand MenuBar text/ })).not.toBeInTheDocument()
  })

  it('on darwin: keeps the macOS menu bar copy and the Expand MenuBar text toggle', () => {
    renderSettings(buildProps({ platform: 'darwin' }))

    expect(screen.getByRole('button', { name: /^Show in menu bar/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Expand MenuBar text/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Show in system tray/ })).not.toBeInTheDocument()
  })

  it('on linux in pt-BR: bandeja do sistema copy, nenhuma referência à MenuBar', () => {
    render(
      <I18nProvider language="pt-BR">
        <ToastProvider>
          <SettingsView {...buildProps({ platform: 'linux' })} />
        </ToastProvider>
      </I18nProvider>,
    )

    expect(screen.getByRole('button', { name: /^Mostrar na bandeja do sistema/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /barra de menu|MenuBar/i })).not.toBeInTheDocument()
  })

  it('the tray toggle still fires the settings change on linux', () => {
    const onUserSettingsChange = vi.fn(async () => {})
    renderSettings(buildProps({ platform: 'linux', onUserSettingsChange }))

    fireEvent.click(screen.getByRole('button', { name: /^Show in system tray/ }))
    expect(onUserSettingsChange).toHaveBeenCalledWith({ showInMenuBar: false })
  })
})

describe('SettingsView → T11: aba Provedores (ordem do dono — provedores saem de Integrações)', () => {
  const codexDisconnected: ProviderAuthStatus = { provider: 'codex', connected: false }
  const claudeDisconnected: ProviderAuthStatus = { provider: 'claude', connected: false }

  it('a aba aparece na navegação, é selecionável e mostra os cartões de provedor', () => {
    const onActiveTabChange = vi.fn()
    renderSettings(buildProps({
      activeTab: 'providers' as SettingsViewProps['activeTab'],
      providerStatuses: [codexDisconnected, claudeDisconnected],
      onActiveTabChange,
    }))

    const navTab = screen.getByRole('button', { name: 'Providers' })
    fireEvent.click(navTab)
    expect(onActiveTabChange).toHaveBeenCalledWith('providers')
    expect(screen.getByRole('heading', { name: 'Providers', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getAllByText(/billed on the provider account/i).length).toBe(2)
    // T11 boundary: NO quota counter yet — Prumo designs it later. The tab
    // must not invent a number or a placeholder that fakes one.
    expect(screen.queryByText(/quota|weekly|semanal|cota/i)).toBeNull()
  })

  it('ASSERÇÃO NEGATIVA: os cartões de provedor NÃO aparecem mais em Integrações', () => {
    const { container } = renderSettings(buildProps({
      activeTab: 'integrations' as SettingsViewProps['activeTab'],
      providerStatuses: [codexDisconnected, claudeDisconnected],
    }))

    expect(screen.getByRole('heading', { name: 'Integrations', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Verboo in Chrome', level: 2 })).toBeInTheDocument()
    expect(container.querySelector('.provider-card')).toBeNull()
    expect(screen.queryByText('Codex')).toBeNull()
    expect(screen.queryByText('Claude')).toBeNull()
    expect(screen.queryByText(/billed on the provider account/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Connect$|^Conectar$/i })).toBeNull()
  })

  it('o vazio é um estado: nenhum provedor conectado → convite à ação, e o convite funciona do zero', () => {
    const onProviderConnect = vi.fn()
    renderSettings(buildProps({
      activeTab: 'providers' as SettingsViewProps['activeTab'],
      providerStatuses: [codexDisconnected, claudeDisconnected],
      onProviderConnect,
    }))

    expect(screen.getAllByText(/^Not connected$/i)).toHaveLength(2)
    const connectButtons = screen.getAllByRole('button', { name: /^Connect$/i })
    expect(connectButtons).toHaveLength(2)
    for (const button of connectButtons) expect(button).toHaveProperty('disabled', false)
    fireEvent.click(connectButtons[0])
    expect(onProviderConnect).toHaveBeenCalledWith('codex')
  })
})

describe('SettingsView → Secret Service IPC codes (issue #83)', () => {
  it('save reject maps to the i18n toast and credentials.warning renders the fallback note', async () => {
    const onSaveApiKey = vi.fn(() => Promise.reject(new Error('secret_service_unavailable')))
    render(
      <SettingsTestView
        language="pt-BR"
        props={buildProps({
          activeTab: 'account' as SettingsViewProps['activeTab'],
          credentials: {
            hasApiKey: true,
            apiKeyHint: 'vbk_…key1',
            warning: 'secret_service_file_fallback',
          },
          onSaveApiKey,
        })}
      />,
    )

    const warning = document.querySelector('.settings-warning')
    expect(warning?.textContent).toContain('arquivo local')
    expect(warning?.textContent).not.toContain('secret_service_file_fallback')

    fireEvent.change(screen.getByLabelText('Chave API'), { target: { value: 'vbk_test_key_long' } })
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }))

    const toast = await screen.findByRole('status')
    expect(toast.textContent).toContain('coleção Default')
    expect(toast.textContent).not.toContain('secret_service_unavailable')
    expect(toast.textContent).not.toContain('Não foi possível validar a API key')
  })
})

describe('SettingsView → update check feedback (issue #94)', () => {
  // Bug: clicking "Check for updates" showed NOTHING — no spinner, no
  // perceivable result (the final text was byte-identical to the pre-click
  // one), and a rejected invoke stayed silent. These tests pin the visible
  // state machine: checking / up-to-date / error / new version, plus the
  // channel copy on a beta build.
  const snap = (over: Partial<UpdateSnapshot>): UpdateSnapshot => ({
    status: 'not-available',
    channel: 'stable',
    currentVersion: '0.6.2',
    stableChannelAvailable: true,
    ...over,
  })

  const buildUpdateProps = (
    channel: UserSettings['updates']['channel'],
    overrides: Partial<SettingsViewProps> = {},
  ): SettingsViewProps => {
    const props = buildProps(overrides)
    return {
      ...props,
      userSettings: {
        ...props.userSettings,
        updates: { ...props.userSettings.updates, channel },
      },
    }
  }

  it('checking: button gets a spinner, disables, and the status line announces the check', () => {
    renderSettings(buildProps({ updateSnapshot: snap({ status: 'checking' }) }))

    const button = screen.getByRole('button', { name: 'Checking...' })
    expect(button).toBeDisabled()
    expect(button.querySelector('.t-spin')).not.toBeNull()
    expect(screen.getByText('Checking GitHub Releases...')).toBeInTheDocument()
  })

  it('up-to-date: the result is PERCEIVABLE — the last-checked time appears under the summary', () => {
    renderSettings(buildProps({
      updateSnapshot: snap({ status: 'not-available', lastCheckedAt: Date.UTC(2026, 7, 27, 12, 0) }),
    }))

    expect(screen.getByText('Version 0.6.2 is current.')).toBeInTheDocument()
    expect(screen.getByText(/Last checked:/)).toBeInTheDocument()
  })

  it('error (network/404): the generic label AND the raw reason both render', () => {
    renderSettings(buildProps({
      updateSnapshot: snap({ status: 'error', error: 'HTTP 404 from updater endpoint' }),
    }))

    expect(screen.getByText('Could not check for updates.')).toBeInTheDocument()
    expect(screen.getByText('HTTP 404 from updater endpoint')).toHaveClass('settings-warning')
  })

  it('new version: shows the available version and the download action', () => {
    renderSettings(buildProps({
      updateSnapshot: snap({ status: 'available', availableVersion: '0.7.0', target: 'app' }),
    }))

    expect(screen.getByText('Version 0.7.0 is available.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download update' })).toBeInTheDocument()
  })

  it('a rejected check invoke is NEVER silent — the reason reaches the updates section', async () => {
    const onCheckForUpdates = vi.fn(() => Promise.reject(new Error('network unreachable')))
    renderSettings(buildProps({ onCheckForUpdates }))

    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))

    expect(await screen.findByText(/Could not check for updates\./)).toBeInTheDocument()
    expect(await screen.findByText(/network unreachable/)).toHaveClass('settings-warning')
  })

  it('a fresh snapshot after a rejected check clears the stale error and unlocks checking', async () => {
    let rerender!: ReturnType<typeof renderSettings>['rerender']
    const onCheckForUpdates = vi.fn(() => {
      rerender(<SettingsTestView props={buildProps({
        updateSnapshot: snap({ status: 'checking' }),
        onCheckForUpdates,
      })} />)
      return Promise.reject(new Error('IPC unavailable'))
    })
    const view = renderSettings(buildProps({ onCheckForUpdates }))
    rerender = view.rerender

    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))

    expect(await screen.findByText(/IPC unavailable/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Checking...' })).toBeDisabled()

    rerender(<SettingsTestView props={buildProps({
      updateSnapshot: snap({ status: 'not-available', lastCheckedAt: Date.UTC(2026, 7, 27, 12, 1) }),
      onCheckForUpdates,
    })} />)

    await waitFor(() => expect(screen.queryByText(/IPC unavailable/)).toBeNull())
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled()
  })

  it.each([
    ['en-US' as const, 'This is a Beta build — Stable unlocks when the first stable release ships.'],
    ['pt-BR' as const, 'Este build é Beta — o canal Estável é liberado quando a primeira versão estável for lançada.'],
  ])('channel copy acknowledges the beta build instead of the confusing placeholder (%s)', (language, copy) => {
    render(<SettingsTestView
      language={language}
      props={buildUpdateProps('beta', {
        updateSnapshot: snap({ channel: 'beta', stableChannelAvailable: false }),
      })}
    />)

    expect(screen.getByText(copy)).toBeInTheDocument()
  })

  it('does not label a Stable-channel user as a Beta build when Stable availability is false', () => {
    renderSettings(buildUpdateProps('stable', {
      updateSnapshot: snap({ stableChannelAvailable: false }),
    }))

    expect(screen.queryByText('This is a Beta build — Stable unlocks when the first stable release ships.')).toBeNull()
  })

  it('does not show Beta-channel availability copy before the first update snapshot exists', () => {
    renderSettings(buildUpdateProps('beta', { updateSnapshot: undefined }))

    expect(screen.queryByText('This is a Beta build — Stable unlocks when the first stable release ships.')).toBeNull()
  })
})
