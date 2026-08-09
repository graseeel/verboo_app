import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChromeIntegrationAggregate, ChromeIntegrationStatus } from '../../../shared/types'
import { useChromeIntegration } from '../settings/useChromeIntegration'
import { OfficialChromeIntegrationCard } from './OfficialChromeIntegrationCard'

vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../settings/useChromeIntegration', () => ({ useChromeIntegration: vi.fn() }))

const mutations = {
  configure: vi.fn(),
  repair: vi.fn(),
  remove: vi.fn(),
  testConnection: vi.fn(),
  openStore: vi.fn(),
}

function statusFor(aggregate: ChromeIntegrationAggregate): ChromeIntegrationStatus {
  return {
    extension: aggregate === 'notConfigured' ? 'missing' : 'managed',
    bridge: aggregate === 'notConfigured' ? 'missing' : aggregate === 'incomplete' ? 'invalid' : 'managed',
    mcp: aggregate === 'notConfigured' ? 'missing' : 'managed',
    connection: aggregate === 'connected' ? 'connected' : 'waitingForChrome',
    panelState: aggregate === 'connected' ? 'unknown' : 'notApplicable',
    aggregate,
    availableVersion: '0.5.2-beta.1',
    canConfigure: aggregate === 'notConfigured',
    canRepair: aggregate === 'incomplete',
    canRemove: aggregate !== 'notConfigured',
    storeUrlAvailable: true,
    developmentBuild: false,
    extensionIdSource: aggregate === 'notConfigured' ? 'none' : 'release',
  }
}

function mockAggregate(aggregate: ChromeIntegrationAggregate) {
  vi.mocked(useChromeIntegration).mockReturnValue({
    status: statusFor(aggregate),
    loading: false,
    activeAction: undefined,
    error: undefined,
    developmentExtensionId: '',
    developmentIdValid: true,
    lastTestPassed: undefined,
    lastTestResult: undefined,
    setDevelopmentExtensionId: vi.fn(),
    refresh: vi.fn(),
    ...mutations,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAggregate('notConfigured')
})

describe('OfficialChromeIntegrationCard', () => {
  it.each<ChromeIntegrationAggregate>(['notConfigured', 'incomplete', 'ready', 'connected'])(
    'renders the official Verboo identity and %s state',
    aggregate => {
      mockAggregate(aggregate)
      render(<OfficialChromeIntegrationCard onManage={vi.fn()} />)

      expect(screen.getByText('plugins.chrome.title')).toBeInTheDocument()
      expect(screen.getByText('plugins.chrome.official')).toBeInTheDocument()
      expect(screen.getByText(`plugins.chrome.${aggregate}`)).toBeInTheDocument()
    },
  )

  it('navigates to management without mutating the integration', () => {
    const onManage = vi.fn()
    render(<OfficialChromeIntegrationCard onManage={onManage} />)

    fireEvent.click(screen.getByRole('button', { name: 'plugins.chrome.configure' }))

    expect(onManage).toHaveBeenCalledTimes(1)
    expect(mutations.configure).not.toHaveBeenCalled()
    expect(mutations.repair).not.toHaveBeenCalled()
    expect(mutations.remove).not.toHaveBeenCalled()
  })
})
