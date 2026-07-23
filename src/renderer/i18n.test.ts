import { describe, it, expect } from 'vitest'
import { createTranslator } from './i18n'

describe('@-mention + voice i18n keys', () => {
  it('has EN translations for the @ palette and voice input', () => {
    const t = createTranslator('en-US')
    expect(t('composer.emptyPluginMenu')).toBe('No plugin skill matches this name.')
    expect(t('composer.pluginMenuLoading')).toBe('Loading plugin skills…')
    expect(t('composer.voiceStart')).toBe('Start voice input')
    expect(t('composer.voiceStop')).toBe('Stop voice input')
    // Mapped error keys must not echo the key back.
    expect(t('composer.voicePermissionDenied')).not.toBe('composer.voicePermissionDenied')
    expect(t('composer.voiceNoMic')).not.toBe('composer.voiceNoMic')
    expect(t('composer.voiceNetworkError')).not.toBe('composer.voiceNetworkError')
    expect(t('composer.voiceNoSpeech')).not.toBe('composer.voiceNoSpeech')
  })

  it('has PT-BR translations for the @ palette and voice input', () => {
    const t = createTranslator('pt-BR')
    // Should be specific PT, not the fallback key echo.
    expect(t('composer.emptyPluginMenu')).not.toBe('composer.emptyPluginMenu')
    expect(t('composer.pluginMenuLoading')).not.toBe('composer.pluginMenuLoading')
    expect(t('composer.emptyPluginMenu').length).toBeGreaterThan(0)
    expect(t('composer.pluginMenuLoading').length).toBeGreaterThan(0)
    // Voice copy in PT-BR, not the key echo.
    expect(t('composer.voiceStart')).not.toBe('composer.voiceStart')
    expect(t('composer.voiceStop')).not.toBe('composer.voiceStop')
    expect(t('composer.voiceUnsupportedTitle')).not.toBe('composer.voiceUnsupportedTitle')
    expect(t('composer.voiceError', { message: 'no-speech' })).toContain('no-speech')
  })
})

describe('sidebar updater i18n keys', () => {
  it.each(['en-US', 'pt-BR'] as const)('provides complete %s update copy', language => {
    const t = createTranslator(language)
    const keys = [
      'updates.sidebarAvailable',
      'updates.sidebarDownloading',
      'updates.sidebarReady',
      'updates.sidebarWaiting',
      'updates.sidebarRestarting',
      'updates.sidebarError',
      'updates.retryAria',
    ]

    for (const key of keys) {
      expect(t(key)).not.toBe(key)
    }
    expect(t('updates.downloadAria', { version: '0.6.0' })).toContain('0.6.0')
  })
})
