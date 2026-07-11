import { describe, it, expect } from 'vitest'
import { createTranslator } from './i18n'

describe('@-mention + voice i18n keys', () => {
  it('has EN translations for the @ palette and voice input', () => {
    const t = createTranslator('en-US')
    expect(t('composer.fileMenuLoading')).toBe('Loading files…')
    expect(t('composer.emptyFileMenu')).toBe('No files match this name.')
    expect(t('composer.file')).toBe('file')
    expect(t('composer.voiceStart')).toBe('Start voice input')
    expect(t('composer.voiceStop')).toBe('Stop voice input')
  })

  it('has PT-BR translations for the @ palette and voice input', () => {
    const t = createTranslator('pt-BR')
    // Should be specific PT, not the fallback key echo.
    expect(t('composer.fileMenuLoading')).not.toBe('composer.fileMenuLoading')
    expect(t('composer.emptyFileMenu')).not.toBe('composer.emptyFileMenu')
    expect(t('composer.fileMenuLoading').length).toBeGreaterThan(0)
    expect(t('composer.emptyFileMenu').length).toBeGreaterThan(0)
    // Badge copy must translate (Aloy QA).
    expect(t('composer.file')).toBe('arquivo')
    // Voice copy in PT-BR, not the key echo.
    expect(t('composer.voiceStart')).not.toBe('composer.voiceStart')
    expect(t('composer.voiceStop')).not.toBe('composer.voiceStop')
    expect(t('composer.voiceUnsupportedTitle')).not.toBe('composer.voiceUnsupportedTitle')
    expect(t('composer.voiceError', { message: 'no-speech' })).toContain('no-speech')
  })
})
