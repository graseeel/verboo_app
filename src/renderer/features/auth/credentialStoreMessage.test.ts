import { describe, expect, it } from 'vitest'
import { createTranslator } from '../../i18n'
import {
  SECRET_SERVICE_FILE_FALLBACK,
  SECRET_SERVICE_UNAVAILABLE,
  credentialStoreI18nKey,
  invokeErrorText,
} from './credentialStoreMessage'

describe('credentialStoreMessage', () => {
  it('maps Secret Service IPC codes to i18n keys in both languages without mixing PT/EN', () => {
    const en = createTranslator('en-US')
    const pt = createTranslator('pt-BR')
    const unavailable = credentialStoreI18nKey(SECRET_SERVICE_UNAVAILABLE)
    const fallback = credentialStoreI18nKey(SECRET_SERVICE_FILE_FALLBACK)
    expect(unavailable).toBe('login.apiKeySecretServiceUnavailable')
    expect(fallback).toBe('login.apiKeySecretServiceFallback')

    expect(en(unavailable!)).toContain('Default collection')
    expect(en(unavailable!)).not.toMatch(/Falha ao/)
    expect(pt(unavailable!)).toContain('coleção Default')
    expect(pt(unavailable!)).not.toMatch(/Secret Service/)
    expect(pt(unavailable!)).not.toMatch(/no result found/)

    expect(en(fallback!)).toContain('local file')
    expect(pt(fallback!)).toContain('arquivo local')
    expect(pt(fallback!)).not.toMatch(/Secret Service/)
  })

  it('does not map macOS/Windows keychain errors', () => {
    expect(credentialStoreI18nKey('Falha ao ler API key: Keychain error -25293')).toBeUndefined()
    expect(credentialStoreI18nKey('keychain unavailable')).toBeUndefined()
  })

  it('reads Tauri invoke rejections as the raw string', () => {
    expect(invokeErrorText(SECRET_SERVICE_UNAVAILABLE)).toBe(SECRET_SERVICE_UNAVAILABLE)
    expect(invokeErrorText(new Error(SECRET_SERVICE_UNAVAILABLE))).toBe(SECRET_SERVICE_UNAVAILABLE)
    expect(invokeErrorText({ message: SECRET_SERVICE_UNAVAILABLE })).toBe(SECRET_SERVICE_UNAVAILABLE)
  })
})
