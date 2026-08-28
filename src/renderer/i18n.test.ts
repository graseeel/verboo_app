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

describe('Android emulator F2 copy', () => {
  it.each([
    ['en-US', 'ADB PNG'],
    ['pt-BR', 'PNG via ADB'],
  ] as const)('provides the %s stream label', (language, expected) => {
    expect(createTranslator(language)('androidEmulator.stream.adb')).toBe(expected)
  })
})

describe('Chrome settings copy', () => {
  it.each([
    {
      language: 'en-US' as const,
      expected: {
        'chrome.identityAndCli': 'Verboo account and CLI connection',
        'chrome.accountLogin': 'Sign in to your Verboo account',
        'chrome.accountLoginBody': 'You must be signed in to your Verboo account to use Chrome tools.',
        'chrome.cliConnection': 'CLI connection',
        'chrome.cliConnectionBody': 'The Verboo CLI connects to Chrome through the local helper and the Verboo extension. Keep the extension side panel open while a task runs.',
        'chrome.error.chrome_integration_record_missing': 'Integration record missing; leftover local artifact.',
        'common.remove': 'Remove',
      },
    },
    {
      language: 'pt-BR' as const,
      expected: {
        'chrome.identityAndCli': 'Conta Verboo e conexão do CLI',
        'chrome.accountLogin': 'Entre na sua conta Verboo',
        'chrome.accountLoginBody': 'Você precisa estar logado na sua conta Verboo para usar as ferramentas do Chrome.',
        'chrome.cliConnection': 'Conexão do CLI',
        'chrome.cliConnectionBody': 'O CLI Verboo se conecta ao Chrome pelo helper local e pela extensão Verboo. Mantenha o painel lateral da extensão aberto enquanto uma tarefa estiver em execução.',
        'chrome.error.chrome_integration_record_missing': 'Registro da integração ausente; artefato local residual.',
        'common.remove': 'Remover',
      },
    },
  ])('provides complete translated copy for $language', ({ language, expected }) => {
    const t = createTranslator(language)
    for (const [key, value] of Object.entries(expected)) {
      expect(t(key)).toBe(value)
    }
  })
})

describe('side chat copy', () => {
  it.each(['en-US', 'pt-BR'] as const)('has complete %s labels', language => {
    const t = createTranslator(language)
    for (const key of [
      'annotations.askInSideChat',
      'sideChat.title',
      'sideChat.contextLabel',
      'sideChat.selectedExcerptOne',
      'sideChat.composerAria',
      'sideChat.questionAria',
      'sideChat.questionPlaceholder',
      'sideChat.sendAria',
      'sideChat.closeAria',
      'sideChat.closeConfirmTitle',
      'sideChat.closeConfirmBody',
      'sideChat.closeConfirmDontAsk',
      'sideChat.cancel',
      'sideChat.confirmClose',
      'sideChat.thinking',
    ]) {
      expect(t(key)).not.toBe(key)
    }
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

describe('browser eviction copy', () => {
  it('states the conditional restore promise in both locales', () => {
    expect(createTranslator('en-US')('browser.evictedTabHint')).toBe(
      'Unloaded to free memory. Live tabs resume exactly where you left them; this tab reloads when opened.',
    )
    expect(createTranslator('pt-BR')('browser.evictedTabHint')).toBe(
      'Descarregada para liberar memória. Abas vivas voltam exatamente de onde estavam; esta aba recarrega ao abrir.',
    )
  })
})

describe('Settings navigation copy', () => {
  it.each([
    {
      language: 'en-US' as const,
      expected: {
        'access.fullLocked': 'Enable it in Settings > Security to unlock this mode.',
        'vision.strippedWarning': 'Images removed — vision fallback is disabled. Enable in Settings → Integrations.',
        'videoConsent.denied': 'Video was not sent because local-only visual understanding is not implemented. Change Video Understanding in Settings → Integrations to allow the disclosed route.',
      },
    },
    {
      language: 'pt-BR' as const,
      expected: {
        'access.fullLocked': 'Ative em Configurações > Segurança para liberar este modo.',
        'vision.strippedWarning': 'Imagens removidas — fallback de visão desativado. Ative em Configurações → Integrações.',
        'videoConsent.denied': 'O vídeo não foi enviado porque a compreensão visual somente local ainda não foi implementada. Altere Compreensão de vídeo em Configurações → Integrações para permitir a rota informada.',
      },
    },
  ])('points obsolete settings navigation to the new $language tab', ({ language, expected }) => {
    const t = createTranslator(language)
    for (const [key, value] of Object.entries(expected)) {
      expect(t(key)).toBe(value)
    }
  })
})

describe('native dialog copy (issue #96)', () => {
  it.each([
    {
      language: 'en-US' as const,
      expected: {
        'dialogs.attachFilesTitle': 'Select files to attach',
        'dialogs.selectFolderTitle': 'Select folder',
        'dialogs.createProjectParentTitle': 'Select a parent folder for the new project',
        'dialogs.imagesFilter': 'Images',
        'dialogs.videosFilter': 'Videos',
        'dialogs.allFilesFilter': 'All files',
      },
    },
    {
      language: 'pt-BR' as const,
      expected: {
        'dialogs.attachFilesTitle': 'Selecionar arquivos para anexar',
        'dialogs.selectFolderTitle': 'Selecionar pasta',
        'dialogs.createProjectParentTitle': 'Selecionar pasta pai para o novo projeto',
        'dialogs.imagesFilter': 'Imagens',
        'dialogs.videosFilter': 'Vídeos',
        'dialogs.allFilesFilter': 'Todos os arquivos',
      },
    },
  ])('provides every producer-controlled native dialog label in $language', ({ language, expected }) => {
    const t = createTranslator(language)
    for (const [key, value] of Object.entries(expected)) {
      expect(t(key)).toBe(value)
    }
  })
})
