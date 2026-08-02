import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
 * The heavy prop list is stubbed with casts — DECLARED: only the
 * notifications tab is exercised; the stubs make the always-rendered
 * chrome (tab rail) mountable, nothing more.
 */

afterEach(cleanup)

function buildProps(overrides: Partial<SettingsViewProps> = {}): SettingsViewProps {
  const userSettings = {
    customInstructions: '',
    completionNotifications: 'background',
    permissionNotifications: true,
    questionNotifications: true,
  } as unknown as UserSettings
  return {
    credentials: {} as SettingsViewProps['credentials'],
    modelResult: {} as SettingsViewProps['modelResult'],
    theme: 'system',
    activeTab: 'notifications',
    userSettings,
    archivedConversations: [],
    browserAvailable: false,
    petEnabled: false,
    petSize: 32,
    workingDirectory: '/tmp',
    onPetToggle: () => {},
    onPetSizeChange: () => {},
    onOpenDashboard: () => {},
    onSaveApiKey: async () => {},
    onThemeChange: () => {},
    onActiveTabChange: () => {},
    onUserSettingsChange: async () => {},
    soundsEnabled: true,
    onSoundsEnabledChange: () => {},
    onResetUserSettings: async () => {},
    onRestoreConversation: () => {},
    onDeleteConversation: () => {},
    onCheckForUpdates: async () => ({} as Awaited<ReturnType<SettingsViewProps['onCheckForUpdates']>>),
    onDownloadUpdate: async () => ({} as Awaited<ReturnType<SettingsViewProps['onDownloadUpdate']>>),
    onInstallUpdate: async () => {},
    onClose: () => {},
    ...overrides,
  }
}

function renderSettings(props: SettingsViewProps) {
  return render(
    <I18nProvider language="en-US">
      <ToastProvider>
        <SettingsView {...props} />
      </ToastProvider>
    </I18nProvider>,
  )
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
