import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChromeIntegrationStatus } from '../../../shared/types'
import { ChromeIntegrationSettings } from './ChromeIntegrationSettings'
import { useChromeIntegration } from './useChromeIntegration'

vi.mock('../../i18n', async () => {
  const actual = await vi.importActual<typeof import('../../i18n')>('../../i18n')
  const pt = actual.createTranslator('pt-BR')
  const translatedKeys = new Set([
    'chrome.accountLogin',
    'chrome.accountLoginBody',
    'chrome.cliConnection',
    'chrome.cliConnectionBody',
  ])

  return {
    useI18n: () => ({
      t: (key: string, values?: Record<string, string | number | undefined>) => (
        translatedKeys.has(key) ? pt(key, values) : key
      ),
    }),
  }
})
vi.mock('./useChromeIntegration', () => ({ useChromeIntegration: vi.fn() }))

const actions = {
  setDevelopmentExtensionId: vi.fn(),
  refresh: vi.fn(),
  configure: vi.fn(),
  repair: vi.fn(),
  testConnection: vi.fn(),
  remove: vi.fn(),
  openStore: vi.fn(),
}

const baseStatus: ChromeIntegrationStatus = {
  extension: 'managed',
  bridge: 'managed',
  mcp: 'managed',
  connection: 'waitingForChrome',
  panelState: 'notApplicable',
  aggregate: 'ready',
  installedVersion: '0.5.2-beta.1',
  availableVersion: '0.5.2-beta.1',
  canConfigure: false,
  canRepair: false,
  canRemove: true,
  storeUrlAvailable: true,
  developmentBuild: false,
  extensionIdSource: 'release',
}

function mockHook(status: ChromeIntegrationStatus = baseStatus) {
  vi.mocked(useChromeIntegration).mockReturnValue({
    status,
    loading: false,
    activeAction: undefined,
    error: undefined,
    developmentExtensionId: '',
    developmentIdValid: true,
    lastTestPassed: undefined,
    lastTestResult: undefined,
    ...actions,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockHook()
})

describe('ChromeIntegrationSettings', () => {
  it('renders four quiet component rows and the waiting-for-Chrome state', () => {
    render(<ChromeIntegrationSettings />)

    expect(screen.getAllByTestId('chrome-status-row')).toHaveLength(4)
    expect(screen.getByText('chrome.aggregate.waiting')).toBeInTheDocument()
    expect(screen.getByText('chrome.connection.waitingForChrome')).toBeInTheDocument()
  })

  it('does not mutate the integration on mount', () => {
    render(<ChromeIntegrationSettings />)

    expect(actions.configure).not.toHaveBeenCalled()
    expect(actions.repair).not.toHaveBeenCalled()
    expect(actions.remove).not.toHaveBeenCalled()
    expect(actions.openStore).not.toHaveBeenCalled()
  })

  it('distinguishes the extension account login from the CLI connection', () => {
    render(<ChromeIntegrationSettings />)

    const explanation = screen.getByRole('region', { name: 'chrome.identityAndCli' })
    expect(explanation).toHaveTextContent('Entre na sua conta Verboo')
    expect(explanation).toHaveTextContent('Você precisa estar logado na sua conta Verboo para usar as ferramentas do Chrome.')
    expect(explanation).toHaveTextContent('Conexão do CLI')
    expect(explanation).toHaveTextContent('O CLI Verboo se conecta ao Chrome pelo helper local e pela extensão Verboo. Mantenha o painel lateral da extensão aberto enquanto uma tarefa estiver em execução.')
  })

  it('shows only actions enabled by the backend state', () => {
    mockHook({
      ...baseStatus,
      extension: 'missing',
      bridge: 'missing',
      mcp: 'missing',
      aggregate: 'notConfigured',
      canConfigure: true,
      canRemove: false,
      storeUrlAvailable: false,
    })
    render(<ChromeIntegrationSettings />)

    expect(screen.getByRole('button', { name: 'chrome.configure' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'chrome.installExtension' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'chrome.repair' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'chrome.test' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'chrome.remove' })).not.toBeInTheDocument()
  })

  it('shows development ID input in both release and development builds', () => {
    const { unmount } = render(<ChromeIntegrationSettings />)
    expect(screen.getByLabelText('chrome.developmentId')).toBeInTheDocument()
    unmount()

    mockHook({ ...baseStatus, developmentBuild: true })
    render(<ChromeIntegrationSettings />)
    expect(screen.getByLabelText('chrome.developmentId')).toBeInTheDocument()
  })

  it('requires explicit confirmation before removing the managed integration', () => {
    render(<ChromeIntegrationSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'chrome.remove' }))
    expect(actions.remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('button', { name: 'chrome.remove' })[1])
    expect(actions.remove).toHaveBeenCalledTimes(1)
  })
})
