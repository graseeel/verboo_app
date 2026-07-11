import { describe, it, expect } from 'vitest'
import { createTranslator } from './i18n'

describe('@-mention palette i18n keys', () => {
  it('has EN translations for the new @-palette empty/loading copy', () => {
    const t = createTranslator('en-US')
    expect(t('composer.fileMenuLoading')).toBe('Loading files…')
    expect(t('composer.emptyFileMenu')).toBe('No files match this name.')
    expect(t('composer.file')).toBe('file')
  })

  it('has PT-BR translations for the new @-palette empty/loading copy', () => {
    const t = createTranslator('pt-BR')
    // Should be specific PT, not the fallback key echo.
    expect(t('composer.fileMenuLoading')).not.toBe('composer.fileMenuLoading')
    expect(t('composer.emptyFileMenu')).not.toBe('composer.emptyFileMenu')
    expect(t('composer.fileMenuLoading').length).toBeGreaterThan(0)
    expect(t('composer.emptyFileMenu').length).toBeGreaterThan(0)
    // Badge copy must translate (Aloy QA).
    expect(t('composer.file')).toBe('arquivo')
  })
})
