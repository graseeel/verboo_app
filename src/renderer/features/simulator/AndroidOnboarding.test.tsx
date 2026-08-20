/**
 * Android emulator setup onboarding tests (PA-25, contract
 * `contrato-android-simulator` — frozen vocabulary 2026-08-19, refined with
 * the `awaiting` resume protocol; names verbatim, do not rename).
 *
 * Renders the REAL AndroidOnboarding against a mocked Tauri bridge — the
 * same pattern as SimulatorOnboarding.test.tsx (invoke + listen mocked,
 * __TAURI_INTERNALS__ defined so listenInTauri actually subscribes).
 * What is pinned:
 *   - each frozen issue lands on the right surface (choice for the six
 *     auto-capable issues; straight-to-guide for accelMissing/
 *     unsupportedPlatform/discoveryFailed);
 *   - the `awaiting` protocol: a progress event with awaiting:'licenses'
 *     shows the license card (text from message, DISPLAY-ONLY) and Accept
 *     re-invokes setup_start with acceptedLicenses=true — never before the
 *     click; awaiting:'download' shows the large-download confirmation
 *     (size from message) and Download re-invokes with confirmDownload=true;
 *   - progress events drive an event-ordered step list; percent drives the
 *     bar; unknown backend step additions render by raw id;
 *   - setup-done: ready → re-detect; error:'cancelled' → choice; issue
 *     without error → the manual guide for the FRESH issue (enableAccel →
 *     accelMissing guide); error:<reason> → retryable failure;
 *   - fail-open: an unknown-command rejection (old backend) drops to the
 *     legacy guide card — setup is never offered — while a REAL error
 *     (setup already running) shows the failure state.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { appDataDir, homeDir, join } from '@tauri-apps/api/path'
import { openPath } from '@tauri-apps/plugin-opener'
import { I18nProvider } from '../../i18n'
import { AndroidEmulatorLegacyCard, AndroidOnboarding } from './AndroidOnboarding'

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
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(),
  homeDir: vi.fn(),
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/').replaceAll('//', '/'))),
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, callback: EventHandler) => listenMock(name, callback),
}))

function emitProgress(payload: unknown) {
  const handler = listeners.get('android-emulator:setup-progress')
  expect(handler, 'component must subscribe to android-emulator:setup-progress').toBeDefined()
  act(() => handler!({ payload }))
}

function emitDone(payload: unknown) {
  const handler = listeners.get('android-emulator:setup-done')
  expect(handler, 'component must subscribe to android-emulator:setup-done').toBeDefined()
  act(() => handler!({ payload }))
}

function renderOnboarding(overrides: Partial<React.ComponentProps<typeof AndroidOnboarding>> = {}) {
  const props: React.ComponentProps<typeof AndroidOnboarding> = {
    issue: 'sdkMissing',
    platform: 'darwin',
    requirementsLoading: false,
    onRefresh: vi.fn(async () => 0),
    onCheckAgain: vi.fn(),
    ...overrides,
  }
  return {
    props,
    ...render(
      <I18nProvider language="en-US">
        <AndroidOnboarding {...props} />
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
  vi.mocked(appDataDir).mockResolvedValue('/app-data')
  vi.mocked(homeDir).mockResolvedValue('/home/person')
  vi.mocked(openPath).mockResolvedValue(undefined)
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}) },
    configurable: true,
  })
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('AndroidOnboarding — per-issue surfaces', () => {
  it('sdkMissing opens on the choice screen with the detected problem and the 2 options', () => {
    renderOnboarding({ issue: 'sdkMissing' })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Android emulator setup needed')
    expect(alert).toHaveTextContent('No Android SDK was found')
    expect(screen.getByRole('button', { name: /Automatic setup/ })).toBeTruthy()
    expect(screen.getByText('Recommended')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Manual setup/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('every auto-capable issue offers the automatic path', () => {
    for (const issue of ['adbMissing', 'emulatorMissing', 'systemImageMissing', 'avdMissing', 'licensesNotAccepted'] as const) {
      cleanup()
      renderOnboarding({ issue })
      expect(screen.getByRole('button', { name: /Automatic setup/ }), `${issue} must offer Automatic`).toBeTruthy()
    }
  })

  it('accelMissing goes STRAIGHT to the manual guide (admin/reboot or re-login can never be automatic)', () => {
    renderOnboarding({ issue: 'accelMissing', platform: 'linux' })

    expect(screen.queryByRole('button', { name: /Automatic setup/ })).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Hardware acceleration is unavailable')
    expect(screen.getByText('sudo usermod -aG kvm $USER')).toBeTruthy()
  })

  it('unsupportedPlatform and discoveryFailed have no automatic path either', () => {
    renderOnboarding({ issue: 'unsupportedPlatform', platform: 'freebsd' as NodeJS.Platform })
    expect(screen.queryByRole('button', { name: /Automatic setup/ })).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('requires macOS, Windows or Linux')

    cleanup()
    renderOnboarding({ issue: 'discoveryFailed' })
    expect(screen.queryByRole('button', { name: /Automatic setup/ })).toBeNull()
    expect(screen.getByText('sdkmanager --list_installed')).toBeTruthy()
  })
})

describe('AndroidOnboarding — automatic sequence (frozen vocabulary)', () => {
  it('Automatic starts the sequence with mode full and shows the progress screen', async () => {
    renderOnboarding({ issue: 'sdkMissing' })

    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['android_emulator_setup_start', { mode: 'full' }],
    ])
    expect(screen.getByText('Setting up the Android emulator')).toBeTruthy()
  })

  it('progress events drive the step list, the download percent drives the bar, and ready re-detects', async () => {
    const { props } = renderOnboarding({ issue: 'sdkMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    emitProgress({ step: 'downloadTools', percent: 40, message: 'Downloading command-line tools' })
    emitProgress({ step: 'installPackages', percent: 12 })

    expect(screen.getByText('Download the Android command-line tools').closest('li')).toHaveAttribute('data-state', 'done')
    expect(screen.getByText('Install the SDK packages (adb, emulator)').closest('li')).toHaveAttribute('data-state', 'active')
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '12')
    expect(bar).toHaveTextContent('12%')

    emitDone({ ready: true })
    await flush()
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
  })

  it('renders a backend step ADDITION by its raw id (Solda may add steps; renames stay vetoed)', async () => {
    renderOnboarding({ issue: 'sdkMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    emitProgress({ step: 'downloadEmulatorSnapshots', message: 'new backend step' })

    expect(screen.getByText('downloadEmulatorSnapshots').closest('li')).toHaveAttribute('data-state', 'active')
  })

  it('setup-done with an error keeps the SPECIFIC cause and retries on demand', async () => {
    renderOnboarding({ issue: 'systemImageMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    emitProgress({ step: 'downloadSystemImage', percent: 61 })
    emitDone({ ready: false, issue: 'systemImageMissing', error: 'curl exited with 22' })

    expect(screen.getByText('Automatic setup did not finish')).toBeTruthy()
    expect(screen.getByText('curl exited with 22')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await flush()
    expect(invokeCalls('android_emulator_setup_start')).toHaveLength(2)
  })

  it("setup-done { error: 'cancelled' } is the user's own cancel — back to the choice screen, no failure", async () => {
    renderOnboarding({ issue: 'sdkMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    emitDone({ ready: false, error: 'cancelled' })
    await flush()

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_setup_cancel')
    expect(screen.getByRole('button', { name: /Automatic setup/ })).toBeTruthy()
    expect(screen.queryByText('Automatic setup did not finish')).toBeNull()
  })

  it('setup-done with an issue and NO error means manual-only: the guide for the FRESH issue (enableAccel → accelMissing)', async () => {
    renderOnboarding({ issue: 'avdMissing', platform: 'win32' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    // The worker created the AVD, then STOPPED at enableAccel: WHPX needs
    // admin + a reboot, so setup-done reports accelMissing with no error.
    emitProgress({ step: 'createAvd' })
    emitProgress({ step: 'enableAccel' })
    emitDone({ ready: false, issue: 'accelMissing' })

    expect(screen.queryByText('Automatic setup did not finish')).toBeNull()
    expect(screen.getByText(/Enable the Windows Hypervisor Platform/)).toBeTruthy()
    expect(screen.getByText(/Restart Windows/)).toBeTruthy()
  })
})

describe('AndroidOnboarding — awaiting protocol (licenses and large downloads)', () => {
  it('awaiting:licenses shows the license text (display-only) and Accept resumes with acceptedLicenses=true — NEVER before the click', async () => {
    renderOnboarding({ issue: 'licensesNotAccepted' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    emitProgress({ step: 'acceptLicenses', awaiting: 'licenses', message: 'Android SDK License Agreement\n…terms…' })

    // The license screen is up and NOTHING was accepted silently.
    const card = screen.getByRole('group', { name: 'Android SDK licenses' })
    expect(card).toHaveTextContent('Android SDK License Agreement')
    expect(card).toHaveTextContent('Nothing is accepted without your click')
    expect(invokeCalls('android_emulator_setup_start')).toEqual([
      ['android_emulator_setup_start', { mode: 'full' }],
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Accept licenses' }))
    await flush()

    expect(invokeCalls('android_emulator_setup_start')).toEqual([
      ['android_emulator_setup_start', { mode: 'full' }],
      ['android_emulator_setup_start', { mode: 'full', acceptedLicenses: true }],
    ])
    // The card clears optimistically; the worker resumes and the next
    // progress event drives the step list.
    expect(screen.queryByRole('button', { name: 'Accept licenses' })).toBeNull()
  })

  it('awaiting:download shows the backend-provided size and Download resumes with confirmDownload=true', async () => {
    renderOnboarding({ issue: 'sdkMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    emitProgress({ step: 'downloadSystemImage', awaiting: 'download', message: 'About 1.2 GB will be downloaded' })

    expect(screen.getByText('Large download ahead')).toBeTruthy()
    expect(screen.getByText('About 1.2 GB will be downloaded')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await flush()

    expect(invokeCalls('android_emulator_setup_start')[1]).toEqual([
      'android_emulator_setup_start',
      { mode: 'full', confirmDownload: true },
    ])
  })

  it('a later progress event without awaiting clears the pause card; Cancel still works while paused', async () => {
    renderOnboarding({ issue: 'sdkMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    emitProgress({ step: 'downloadSystemImage', awaiting: 'download', message: 'About 1.2 GB' })
    expect(screen.getByText('Large download ahead')).toBeTruthy()

    emitProgress({ step: 'downloadSystemImage', percent: 8 })
    expect(screen.queryByText('Large download ahead')).toBeNull()

    emitProgress({ step: 'acceptLicenses', awaiting: 'licenses', message: 'terms' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('android_emulator_setup_cancel')
  })

  it('a REAL resume failure surfaces the failure state (the card never swallows it)', async () => {
    renderOnboarding({ issue: 'licensesNotAccepted' })
    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()
    emitProgress({ step: 'acceptLicenses', awaiting: 'licenses', message: 'terms' })

    vi.mocked(invoke).mockRejectedValueOnce(new Error('worker gone'))
    fireEvent.click(screen.getByRole('button', { name: 'Accept licenses' }))
    await flush()

    expect(screen.getByText('Automatic setup did not finish')).toBeTruthy()
    expect(screen.getByText('worker gone')).toBeTruthy()
  })
})

describe('AndroidOnboarding — manual guide and fail-open', () => {
  it('manual guide for sdkMissing: copyable guidance and Check again; never starts the sequence', async () => {
    const { props } = renderOnboarding({ issue: 'sdkMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Manual setup/ }))

    expect(screen.getByText(/Install the Android SDK command-line tools/)).toBeTruthy()
    expect(screen.getByText(/ANDROID_HOME/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    await flush()
    expect(openPath).toHaveBeenCalledWith('/app-data')

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(props.onCheckAgain).toHaveBeenCalledTimes(1)
    expect(invokeCalls('android_emulator_setup_start')).toHaveLength(0)
  })

  it('opens the issue-relevant AVD destination from the real manual guide', async () => {
    renderOnboarding({ issue: 'avdMissing' })
    fireEvent.click(screen.getByRole('button', { name: /Manual setup/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    await flush()

    expect(homeDir).toHaveBeenCalledTimes(1)
    expect(join).toHaveBeenCalledWith('/home/person', '.android', 'avd')
    expect(openPath).toHaveBeenCalledWith('/home/person/.android/avd')
  })

  it('opens the managed SDK folder for a real generic manual issue', async () => {
    renderOnboarding({ issue: 'accelMissing', platform: 'darwin' })

    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    await flush()

    expect(appDataDir).toHaveBeenCalledTimes(1)
    expect(join).toHaveBeenCalledWith('/app-data', 'android-sdk')
    expect(openPath).toHaveBeenCalledWith('/app-data/android-sdk')
  })

  it('manual guide for licensesNotAccepted: the user answers y in their own terminal', async () => {
    renderOnboarding({ issue: 'licensesNotAccepted' })
    fireEvent.click(screen.getByRole('button', { name: /Manual setup/ }))

    expect(screen.getByText('sdkmanager --licenses')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0])
    await flush()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sdkmanager --licenses')
    expect(screen.getByText('Copied')).toBeTruthy()
  })

  it('accelMissing guide is per-OS: WHPX on Windows, kvm group on Linux, Hypervisor.framework on macOS', () => {
    renderOnboarding({ issue: 'accelMissing', platform: 'win32' })
    expect(screen.getByText('dism.exe /online /enable-feature /featurename:HypervisorPlatform /all')).toBeTruthy()

    cleanup()
    renderOnboarding({ issue: 'accelMissing', platform: 'linux' })
    expect(screen.getByText('sudo usermod -aG kvm $USER')).toBeTruthy()

    cleanup()
    renderOnboarding({ issue: 'accelMissing', platform: 'darwin' })
    expect(screen.getByText(/Hypervisor\.framework/)).toBeTruthy()
  })

  it('fail-open: backend without the setup commands drops to the legacy guide card and never offers setup', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Command android_emulator_setup_start not found'))
    const { container } = renderOnboarding({ issue: 'sdkMissing' })

    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    expect(container.querySelector('.ios-simulator-requirement')).toBeTruthy()
    expect(screen.getByRole('alert')).toHaveTextContent('does not include the Android emulator setup')
    expect(screen.getByText(/Install the Android SDK command-line tools/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Automatic setup/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('a REAL start error (setup already running) shows the failure state — never the legacy card', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('an Android emulator setup is already running'))
    const { container } = renderOnboarding({ issue: 'sdkMissing' })

    fireEvent.click(screen.getByRole('button', { name: /Automatic setup/ }))
    await flush()

    expect(container.querySelector('.ios-simulator-requirement')).toBeNull()
    expect(screen.getByText('Automatic setup did not finish')).toBeTruthy()
    expect(screen.getByText('an Android emulator setup is already running')).toBeTruthy()
  })
})

describe('AndroidEmulatorLegacyCard — panel-level fail-open (old backend without android_emulator_requirements)', () => {
  it('shows the guide and Check again, and offers NO setup action', () => {
    const onCheckAgain = vi.fn()
    render(
      <I18nProvider language="en-US">
        <AndroidEmulatorLegacyCard requirementsLoading={false} onCheckAgain={onCheckAgain} />
      </I18nProvider>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('does not include the Android emulator setup')
    expect(screen.getByText(/Install the Android SDK command-line tools/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Automatic setup/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(onCheckAgain).toHaveBeenCalledTimes(1)
  })
})
