/**
 * Simulator setup onboarding tests (design-ios-onboarding, PA-14 —
 * frozen vocabulary 2026-08-19).
 *
 * Renders the REAL SimulatorOnboarding against a mocked Tauri bridge —
 * the same pattern as iosSimulatorApi.test.ts (invoke + listen mocked,
 * __TAURI_INTERNALS__ defined so listenInTauri actually subscribes).
 * What is pinned:
 *   - each issue lands on the right surface (choice for xcodeMissing/
 *     simctlMissing/simulatorsMissing, straight-to-guide for
 *     unsupportedXcode);
 *   - Automatic on xcodeMissing opens the App Store page AND starts the
 *     sequence with mode 'full' — the waitingForXcode step arrives from
 *     the BACKEND (the renderer never polls);
 *   - progress events drive an event-ordered step list, downloadPlatform
 *     carries the 0-100 bar;
 *   - setup-done: ready → re-detect; error:'cancelled' → choice screen;
 *     error:<reason> → retryable failure; issue without error → straight
 *     to the manual guide for the FRESH issue;
 *   - fail-open: an unknown-command rejection (old backend) falls back
 *     to the pre-onboarding static card — the panel never breaks — while
 *     a REAL error (setup already running) shows the failure state.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { I18nProvider } from '../../i18n'
import { SimulatorOnboarding } from './SimulatorOnboarding'

type EventHandler = (event: { payload: unknown }) => void

const { listenMock, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, EventHandler>()
  return {
    listeners,
    listenMock: vi.fn((name: string, callback: EventHandler) => {
      listeners.set(name, callback)
      return Promise.resolve(() => {})
    }),
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, callback: EventHandler) => listenMock(name, callback),
}))

function emitProgress(payload: unknown) {
  const handler = listeners.get('ios-simulator:setup-progress')
  expect(handler, 'component must subscribe to ios-simulator:setup-progress').toBeDefined()
  act(() => handler!({ payload }))
}

function emitDone(payload: unknown) {
  const handler = listeners.get('ios-simulator:setup-done')
  expect(handler, 'component must subscribe to ios-simulator:setup-done').toBeDefined()
  act(() => handler!({ payload }))
}

function renderOnboarding(overrides: Partial<React.ComponentProps<typeof SimulatorOnboarding>> = {}) {
  const props: React.ComponentProps<typeof SimulatorOnboarding> = {
    issue: 'xcodeMissing',
    xcodeVersion: undefined,
    requirementsLoading: false,
    onRefresh: vi.fn(async () => 0),
    onCheckAgain: vi.fn(),
    ...overrides,
  }
  return {
    props,
    ...render(
      <I18nProvider language="en-US">
        <SimulatorOnboarding {...props} />
      </I18nProvider>,
    ),
  }
}

async function flush() {
  await act(async () => {})
}

function invokeCalls(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name)
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  listeners.clear()
  vi.mocked(invoke).mockResolvedValue(undefined)
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}) },
    configurable: true,
  })
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('SimulatorOnboarding — per-issue surfaces', () => {
  it('xcodeMissing opens on the choice screen with the detected problem and the 2 options', () => {
    renderOnboarding({ issue: 'xcodeMissing' })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Simulator setup needed')
    expect(alert).toHaveTextContent('Install Xcode 26 or 27')
    expect(screen.getByRole('button', { name: /Automatic setup/ })).toBeTruthy()
    expect(screen.getByText('Recommended')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Manual setup/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('unsupportedXcode goes STRAIGHT to the manual guide (automatic never forces a version change)', () => {
    renderOnboarding({ issue: 'unsupportedXcode', xcodeVersion: '25.4' })

    expect(screen.queryByRole('button', { name: /Automatic setup/ })).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Xcode 25.4 is not supported')
    expect(screen.getByText('Update Xcode to version 26 or 27 on the App Store.')).toBeTruthy()
  })
})

describe('SimulatorOnboarding — automatic sequence (frozen vocabulary)', () => {
  it('xcodeMissing Automatic: opens the App Store page, then starts the sequence with mode full', async () => {
    renderOnboarding({ issue: 'xcodeMissing' })

    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['ios_simulator_setup_open_app_store'],
      ['ios_simulator_setup_start', { mode: 'full' }],
    ])
    expect(screen.getByText('Setting up the iOS simulator')).toBeTruthy()
  })

  it('simulatorsMissing Automatic: starts full WITHOUT touching the App Store', async () => {
    renderOnboarding({ issue: 'simulatorsMissing' })

    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    expect(invokeCalls('ios_simulator_setup_open_app_store')).toHaveLength(0)
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('ios_simulator_setup_start', { mode: 'full' })
  })

  it('the waitingForXcode step comes from the BACKEND — the renderer only displays it (with a reopen convenience)', async () => {
    renderOnboarding({ issue: 'xcodeMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    emitProgress({ step: 'verify' })
    emitProgress({ step: 'waitingForXcode' })

    const waiting = screen.getByText('Waiting for the Xcode installation').closest('li')
    expect(waiting).toHaveAttribute('data-state', 'active')
    // verify is behind the active step → done.
    expect(screen.getByText('Check the simulator environment').closest('li')).toHaveAttribute('data-state', 'done')
    expect(screen.getByText(/Install it and the setup continues automatically/)).toBeTruthy()

    vi.mocked(invoke).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Open the App Store page again' }))
    await flush()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('ios_simulator_setup_open_app_store')
  })

  it('progress events drive the step list and the downloadPlatform percent drives the bar; ready re-detects', async () => {
    const { props } = renderOnboarding({ issue: 'simulatorsMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    emitProgress({ step: 'verify' })
    emitProgress({ step: 'selectXcode', message: 'Selecting Xcode.app' })
    emitProgress({ step: 'downloadPlatform', percent: 45, message: 'Downloading iOS runtime' })

    expect(screen.getByText('Point the command line tools at Xcode.app').closest('li')).toHaveAttribute('data-state', 'done')
    expect(screen.getByText('Download the iOS platform runtime').closest('li')).toHaveAttribute('data-state', 'active')
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '45')
    expect(bar).toHaveTextContent('45%')
    expect(screen.getByText('Downloading iOS runtime')).toBeTruthy()

    emitDone({ ready: true })
    await flush()
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
  })

  it('setup-done with an error keeps the SPECIFIC cause and retries on demand', async () => {
    renderOnboarding({ issue: 'simctlMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    emitProgress({ step: 'acceptLicense', message: 'running license accept' })
    emitDone({ ready: false, issue: 'simctlMissing', error: 'failed to accept the Xcode license' })

    expect(screen.getByText('Automatic setup did not finish')).toBeTruthy()
    expect(screen.getByText('failed to accept the Xcode license')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await flush()
    expect(invokeCalls('ios_simulator_setup_start')).toHaveLength(2)
  })

  it("setup-done { error: 'cancelled' } is the user's own cancel — back to the choice screen, no failure", async () => {
    renderOnboarding({ issue: 'simulatorsMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    emitDone({ ready: false, error: 'cancelled' })
    await flush()

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('ios_simulator_setup_cancel')
    expect(screen.getByRole('button', { name: /Automatic setup/ })).toBeTruthy()
    expect(screen.queryByText('Automatic setup did not finish')).toBeNull()
  })

  it('setup-done with an issue and NO error means manual-only: straight to the guide for the FRESH issue', async () => {
    renderOnboarding({ issue: 'xcodeMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    // The user installed an OLD Xcode from the App Store — the backend
    // detects unsupportedXcode and ends the automatic run.
    emitDone({ ready: false, issue: 'unsupportedXcode' })

    expect(screen.queryByText('Automatic setup did not finish')).toBeNull()
    expect(screen.getByText('Update Xcode to version 26 or 27 on the App Store.')).toBeTruthy()
  })
})

describe('SimulatorOnboarding — manual guide and fail-open', () => {
  it('manual guide for xcodeMissing: App Store convenience button, copyable commands, Check again', async () => {
    const { props } = renderOnboarding({ issue: 'xcodeMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Manual setup/ }))

    expect(screen.getByText('Install Xcode 26 or 27 from the App Store.')).toBeTruthy()
    expect(screen.getByText('sudo xcode-select -s /Applications/Xcode.app')).toBeTruthy()
    expect(screen.getByText('sudo xcodebuild -license accept')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0])
    await flush()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sudo xcode-select -s /Applications/Xcode.app')
    expect(screen.getByText('Copied')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(props.onCheckAgain).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Open the App Store' }))
    await flush()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('ios_simulator_setup_open_app_store')
    // The manual convenience NEVER starts the automatic sequence.
    expect(invokeCalls('ios_simulator_setup_start')).toHaveLength(0)
  })

  it('fail-open: backend without the setup commands falls back to the OLD static card', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Command ios_simulator_setup_start not found'))
    const { container } = renderOnboarding({ issue: 'simulatorsMissing' })

    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    // The pre-onboarding card, verbatim: issue text + refresh button.
    const legacy = container.querySelector('.ios-simulator-requirement')
    expect(legacy, 'old static card must render when the backend lacks the commands').toBeTruthy()
    expect(legacy).toHaveTextContent('Create an iOS simulator in Xcode, then refresh this panel.')
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy()
    expect(screen.queryByText('Setting up the iOS simulator')).toBeNull()
  })

  it('fail-open: the same fallback covers an unknown App Store opener', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('unknown command'))
    const { container } = renderOnboarding({ issue: 'xcodeMissing' })

    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    expect(container.querySelector('.ios-simulator-requirement')).toBeTruthy()
    expect(invokeCalls('ios_simulator_setup_start')).toHaveLength(0)
  })

  it('a REAL start error (setup already running) shows the failure state — never the legacy card', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('an iOS simulator setup is already running'))
    const { container } = renderOnboarding({ issue: 'simulatorsMissing' })

    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    expect(container.querySelector('.ios-simulator-requirement')).toBeNull()
    expect(screen.getByText('Automatic setup did not finish')).toBeTruthy()
    expect(screen.getByText('an iOS simulator setup is already running')).toBeTruthy()
  })
})
