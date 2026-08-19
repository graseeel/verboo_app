/**
 * Issue #71: Windows Git onboarding gate on the login screen
 * (contract contrato-71-gitbash with the Rust side).
 *
 * These tests render the REAL LoginScreen and mock ONLY the bridge
 * (window.verboo) — the same mock pattern as the App.*.test.tsx
 * harnesses. What is pinned here:
 *   - no Git on Windows  → the sign-in is HELD and the onboarding
 *     dialog opens with the two contract options; onStartLogin never
 *     fires;
 *   - Install automatically → install_git_windows runs, the gate
 *     RE-CHECKS, and the login proceeds automatically on success;
 *   - install failure → summarized log tail + the manual path
 *     (git-scm.com/downloads/win);
 *   - non-Windows / no bridge → the flow is byte-identical to before
 *     (fail-open, no dialog);
 *   - fallback: a raw CLI error naming git-bash maps to the same
 *     dialog instead of the bare banner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { LoginEvent } from '../../shared/types'
import { LoginScreen } from './LoginScreen'
import { I18nProvider } from '../i18n'

// Capture the login:event handler so tests can emit events exactly as
// Tauri would (same technique as LoginScreen.test.tsx).
type LoginEventHandler = (event: { payload: LoginEvent }) => void
const mockListen = vi.fn<(name: string, handler: LoginEventHandler) => Promise<() => void>>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: LoginEventHandler) => mockListen(name, handler),
}))

vi.mock('../../../assets/branding/verboo-mascot.png', () => ({ default: 'mascot.png' }))
vi.mock('../../../assets/branding/verboo-wordmark.png', () => ({ default: 'wordmark.png' }))

const checkWindowsLoginPrereqs = vi.fn()
const installGitWindows = vi.fn()

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockListen.mockImplementation(() => Promise.resolve(() => {}))
  ;(window as unknown as { verboo: unknown }).verboo = {
    checkWindowsLoginPrereqs,
    installGitWindows,
  }
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).verboo
})

type LoginScreenProps = ComponentProps<typeof LoginScreen>

function makeProps(overrides: Partial<LoginScreenProps> = {}): LoginScreenProps {
  return {
    language: 'en-US' as const,
    checking: false,
    authError: undefined,
    credentials: { hasApiKey: false },
    cliAuth: { loggedIn: false },
    modelResult: { models: [], source: 'none' as const, stale: false },
    staySignedIn: false,
    onStartLogin: vi.fn(() => Promise.resolve({ ok: true, message: 'Login started in background.' })),
    onOpenDashboard: vi.fn(),
    onOpenSignup: vi.fn(),
    onCheckExistingAuth: vi.fn(() => Promise.resolve(false)),
    onSaveApiKey: vi.fn(() => Promise.resolve(false)),
    onLanguageChange: vi.fn(),
    onStaySignedInChange: vi.fn(),
    onOpenFeedback: vi.fn(),
    onLoginComplete: vi.fn(),
    ...overrides,
  }
}

function renderLogin(props = makeProps()) {
  return {
    props,
    ...render(
      <I18nProvider language="en-US">
        <LoginScreen {...props} />
      </I18nProvider>,
    ),
  }
}

function clickSignIn() {
  fireEvent.click(screen.getByRole('button', { name: /Sign in with CLI/ }))
}

function loginEventHandler(): LoginEventHandler {
  const call = mockListen.mock.calls.find(([name]) => name === 'login:event')
  expect(call, 'component must subscribe to the login:event channel').toBeDefined()
  return call![1]
}

describe('Issue #71: Windows Git onboarding gate (contrato-71-gitbash)', () => {
  it('Windows WITHOUT git → sign-in is HELD, the dialog opens with the 2 contract options', async () => {
    checkWindowsLoginPrereqs.mockResolvedValue({ gitAvailable: false, platform: 'windows' })
    const { props } = renderLogin()

    clickSignIn()

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Git is required to sign in on Windows')
    expect(screen.getByRole('button', { name: 'Install automatically' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Manual instructions' })).toBeTruthy()
    // The CLI login was NEVER fired — the gate holds before the spawn.
    expect(props.onStartLogin).not.toHaveBeenCalled()
    // And the button is back to idle, not stuck on a spinner.
    expect((screen.getByRole('button', { name: /Sign in with CLI/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('Install automatically → winget runs, the gate RE-CHECKS and the login proceeds on its own', async () => {
    checkWindowsLoginPrereqs
      .mockResolvedValueOnce({ gitAvailable: false, platform: 'windows' }) // initial gate
      .mockResolvedValue({ gitAvailable: true, platform: 'windows' }) // post-install re-check + re-gate
    installGitWindows.mockResolvedValue({ success: true, exitCode: 0, log: 'Successfully installed' })
    const { props } = renderLogin()

    clickSignIn()
    fireEvent.click(await screen.findByRole('button', { name: 'Install automatically' }))

    // Progress state while winget runs.
    await screen.findByText('Installing Git for Windows… this can take a few minutes.')
    expect(installGitWindows).toHaveBeenCalledTimes(1)

    // Success: the dialog closes and the CLI login starts automatically.
    await waitFor(() => expect(props.onStartLogin).toHaveBeenCalledTimes(1))
    await screen.findByText('Login started — waiting for the browser…')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('install failure → summarized log TAIL + the manual path (git-scm link, defaults, reopen)', async () => {
    checkWindowsLoginPrereqs.mockResolvedValue({ gitAvailable: false, platform: 'windows' })
    installGitWindows.mockResolvedValue({
      success: false,
      exitCode: 1,
      log: [
        'early noise line',
        'Found Git [Git.Git] Version 2.51.0',
        'This application is licensed to you by its owner.',
        'Microsoft is not responsible for...',
        'Downloading https://github.com/git-for-windows/git/releases/...',
        'Installer hash verified',
        'more noise',
        'winget: the msstore source certificate verification failed',
      ].join('\n'),
    })
    const { props } = renderLogin()

    clickSignIn()
    fireEvent.click(await screen.findByRole('button', { name: 'Install automatically' }))

    // Failure state: friendly headline + the log tail behind the details
    // toggle (the early lines are cut — the tail carries the cause)…
    const warning = await screen.findByRole('alert')
    expect(warning.textContent).toContain('Automatic installation did not finish.')
    expect(warning.textContent).toContain('certificate verification failed')
    expect(warning.textContent).not.toContain('early noise line')
    // …and the login still never fired.
    expect(props.onStartLogin).not.toHaveBeenCalled()

    // The manual path is offered from the failure state.
    fireEvent.click(screen.getByRole('button', { name: 'Manual instructions' }))
    const link = (await screen.findByRole('link', { name: 'git-scm.com/downloads/win' })) as HTMLAnchorElement
    expect(link.href).toBe('https://git-scm.com/downloads/win')
    expect(link.target).toBe('_blank')
    expect(screen.getByText('Run the installer keeping the default options.')).toBeTruthy()
    expect(screen.getByText('Reopen the app and sign in again.')).toBeTruthy()
  })

  it('a successful winget exit with git STILL missing falls to the failure state (re-check is load-bearing)', async () => {
    checkWindowsLoginPrereqs.mockResolvedValue({ gitAvailable: false, platform: 'windows' })
    installGitWindows.mockResolvedValue({ success: true, exitCode: 0, log: 'installed but PATH not refreshed' })
    const { props } = renderLogin()

    clickSignIn()
    fireEvent.click(await screen.findByRole('button', { name: 'Install automatically' }))

    await screen.findByRole('alert')
    expect(props.onStartLogin).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Manual instructions' })).toBeTruthy()
  })

  it('non-Windows (gitAvailable:true per contract) → flow untouched: no dialog, login fires', async () => {
    checkWindowsLoginPrereqs.mockResolvedValue({ gitAvailable: true, platform: 'darwin' })
    const { props } = renderLogin()

    clickSignIn()

    await waitFor(() => expect(props.onStartLogin).toHaveBeenCalledTimes(1))
    await screen.findByText('Login started — waiting for the browser…')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('fail-OPEN: bridge without the command (older backend) never blocks the sign-in', async () => {
    ;(window as unknown as { verboo: unknown }).verboo = {}
    const { props } = renderLogin()

    clickSignIn()

    await waitFor(() => expect(props.onStartLogin).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('fallback: a raw CLI error naming git-bash maps to the SAME dialog — never the bare banner', async () => {
    checkWindowsLoginPrereqs.mockResolvedValue({ gitAvailable: true, platform: 'windows' })
    renderLogin()

    clickSignIn()
    await screen.findByText('Login started — waiting for the browser…')

    // Detection missed (stale PATH, moved install…): the CLI fails with
    // the git-bash cause over the event channel.
    act(() => {
      loginEventHandler()({
        payload: { kind: 'error', message: 'Verboo CLI requires Git for Windows (git-bash) to run on Windows' },
      })
    })

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Git is required to sign in on Windows')
    expect(screen.getByRole('button', { name: 'Install automatically' })).toBeTruthy()
    // The raw cause NEVER paints as the error banner.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Verboo CLI requires Git for Windows/)).toBeNull()
  })
})
