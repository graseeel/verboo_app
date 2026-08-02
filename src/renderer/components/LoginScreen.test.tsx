/**
 * A1: render tests for the event-driven CLI login (login:event channel).
 *
 * Production defects this guards (both reported by REAL users):
 *   - Windows: app showed "Verboo Code — Not responding" stuck on the
 *     login screen after "Sign in with CLI" — the Rust command blocked
 *     on .output() until the CLI exited (now non-blocking, TORNO).
 *   - Linux (issue #59, Fedora 43): "login doesn't open any window" —
 *     the browser may never open by itself, so the login URL must be
 *     VISIBLE and COPYABLE in the UI, not buried in a log.
 *
 * Contract pinned here (verified against the Rust source):
 *   - The channel name is literally `login:event` (colon included).
 *   - LoginEventKind uses serde rename_all = "lowercase" — the wire
 *     values are 'url' | 'complete' | 'error', LOWERCASE, a DIFFERENT
 *     serde attribute from the struct family's camelCase.
 *   - url/message/ok/status use skip_serializing_if Option::is_none —
 *     absent keys arrive as undefined. Absence, not null.
 *
 * These tests assert on the RENDERED UI (what the user sees), not on
 * the mere existence of a handler — the "proves assembly, not display"
 * gap already cost this project six defects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { LoginEvent } from '../../shared/types'
import { LoginScreen } from './LoginScreen'
import { I18nProvider } from '../i18n'

// Capture the login:event handler registered by the component so tests
// can emit events exactly as Tauri would (payload-only Event object).
type LoginEventHandler = (event: { payload: LoginEvent }) => void
const mockListen = vi.fn<(name: string, handler: LoginEventHandler) => Promise<() => void>>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: LoginEventHandler) => mockListen(name, handler),
}))

vi.mock('../../../assets/branding/verboo-mascot.png', () => ({ default: 'mascot.png' }))
vi.mock('../../../assets/branding/verboo-wordmark.png', () => ({ default: 'wordmark.png' }))

const LOGIN_URL = 'https://verboo.ai/auth/cli?code=abc123'
const clipboardWriteText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  clipboardWriteText.mockResolvedValue(undefined)
  mockListen.mockImplementation(() => Promise.resolve(() => {}))
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWriteText },
    configurable: true,
  })
})

type LoginScreenProps = ComponentProps<typeof LoginScreen>

function makeProps(overrides: Partial<LoginScreenProps> = {}): LoginScreenProps {
  return {
    language: 'pt-BR' as const,
    noticeAccepted: true,
    checking: false,
    authError: undefined,
    credentials: { hasApiKey: false },
    cliAuth: { loggedIn: false },
    modelResult: { models: [], source: 'none' as const, stale: false },
    staySignedIn: false,
    onStartLogin: vi.fn(() => Promise.resolve({ ok: true, message: 'Login iniciado em background.' })),
    onOpenDashboard: vi.fn(),
    onOpenSignup: vi.fn(),
    onCheckExistingAuth: vi.fn(() => Promise.resolve(false)),
    onSaveApiKey: vi.fn(() => Promise.resolve(false)),
    onLanguageChange: vi.fn(),
    onStaySignedInChange: vi.fn(),
    onAcceptNotice: vi.fn(),
    onOpenFeedback: vi.fn(),
    onLoginComplete: vi.fn(),
    ...overrides,
  }
}

function renderLogin(props = makeProps()) {
  return {
    props,
    ...render(
      <I18nProvider language="pt-BR">
        <LoginScreen {...props} />
      </I18nProvider>,
    ),
  }
}

/** The handler the component registered on `login:event`. */
function loginEventHandler(): LoginEventHandler {
  const call = mockListen.mock.calls.find(([name]) => name === 'login:event')
  expect(call, 'component must subscribe to the login:event channel').toBeDefined()
  return call![1]
}

function emitLoginEvent(payload: LoginEvent) {
  act(() => {
    loginEventHandler()({ payload })
  })
}

async function startLoginAndAwaitBrowser(props = makeProps()) {
  const rendered = renderLogin(props)
  const button = screen.getByRole('button', { name: /Entrar pelo CLI/ })
  fireEvent.click(button)
  // onStartLogin resolves ok → phase awaitingBrowser (shimmer status).
  await screen.findByText('Login iniciado — aguardando o navegador…')
  return rendered
}

describe('A1: event-driven CLI login (login:event)', () => {
  it('subscribes to the channel literally named "login:event" (colon included)', () => {
    renderLogin()
    expect(mockListen).toHaveBeenCalledWith('login:event', expect.any(Function))
  })

  it('kind=url shows the URL VISIBLE and COPYABLE — the issue #59 fix', async () => {
    await startLoginAndAwaitBrowser()

    emitLoginEvent({ kind: 'url', url: LOGIN_URL })

    // The URL reaches the SCREEN as a readable, selectable value — not
    // a log line. This is what the Linux user (no auto-opened browser)
    // copies by hand.
    const urlInput = screen.getByLabelText('Link de login do Verboo') as HTMLInputElement
    expect(urlInput.value).toBe(LOGIN_URL)
    expect(urlInput.readOnly).toBe(true)

    // The help text tells the user WHY the link is there.
    expect(screen.getByText('Se o navegador não abrir sozinho, copie e cole este link:')).toBeTruthy()

    // Copy button puts the exact URL on the clipboard.
    fireEvent.click(screen.getByRole('button', { name: /Copiar link/ }))
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(LOGIN_URL)
    })
    await screen.findByText('Copiado')

    // And a direct "open in browser" anchor as the secondary path.
    const anchor = screen.getByRole('link', { name: /Abrir link no navegador/ }) as HTMLAnchorElement
    expect(anchor.href).toBe(LOGIN_URL)
    expect(anchor.target).toBe('_blank')

    // The flow is still alive, waiting for the browser authentication.
    expect(screen.getByText('Aguardando a autenticação no navegador…')).toBeTruthy()
  })

  it('kind=complete (ok:true) exits the loading state and hands the event to onLoginComplete', async () => {
    const props = makeProps()
    await startLoginAndAwaitBrowser(props)
    emitLoginEvent({ kind: 'url', url: LOGIN_URL })

    const payload: LoginEvent = {
      kind: 'complete',
      message: 'Login concluído.',
      ok: true,
      status: { loggedIn: true },
    }
    emitLoginEvent(payload)

    // The parent gets the event so it can re-validate and unlock…
    expect(props.onLoginComplete).toHaveBeenCalledTimes(1)
    expect(props.onLoginComplete).toHaveBeenCalledWith(payload)
    // …the loading indicator is GONE (not an infinite spinner)…
    expect(screen.queryByText('Aguardando a autenticação no navegador…')).toBeNull()
    expect(screen.queryByText('Login iniciado — aguardando o navegador…')).toBeNull()
    // …and the button is usable again.
    expect((screen.getByRole('button', { name: /Entrar pelo CLI/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('kind=error shows the SPECIFIC cause and re-enables the button', async () => {
    await startLoginAndAwaitBrowser()
    const cause = 'Falha ao iniciar login do CLI Verboo: spawn ENOENT'

    emitLoginEvent({ kind: 'error', message: cause })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(cause)
    expect((screen.getByRole('button', { name: /Entrar pelo CLI/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('kind=complete with ok:false shows the CLI message (not a generic) and re-enables', async () => {
    await startLoginAndAwaitBrowser()

    emitLoginEvent({ kind: 'complete', message: 'Login não concluído: token expirado', ok: false })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Login não concluído: token expirado')
    expect((screen.getByRole('button', { name: /Entrar pelo CLI/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('invoke rejection surfaces the Rust cause — the button NEVER gets stuck (Windows "Not responding")', async () => {
    const props = makeProps({
      onStartLogin: vi.fn(() => Promise.reject('Falha ao iniciar login do CLI Verboo: spawn ENOENT')),
    })
    renderLogin(props)

    fireEvent.click(screen.getByRole('button', { name: /Entrar pelo CLI/ }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Falha ao iniciar login do CLI Verboo: spawn ENOENT')
    expect((screen.getByRole('button', { name: /Entrar pelo CLI/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('kind=url WITHOUT the url key (skip_serializing_if absence) keeps waiting — no crash, no fake link', async () => {
    await startLoginAndAwaitBrowser()

    // The key is OMITTED from the JSON when absent — arrives undefined.
    emitLoginEvent({ kind: 'url' })

    expect(screen.queryByLabelText('Link de login do Verboo')).toBeNull()
    expect(screen.getByText('Login iniciado — aguardando o navegador…')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('cancel exits the waiting state, and a late ok:false completion does NOT resurrect an error on idle', async () => {
    await startLoginAndAwaitBrowser()
    emitLoginEvent({ kind: 'url', url: LOGIN_URL })

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByLabelText('Link de login do Verboo')).toBeNull()
    expect((screen.getByRole('button', { name: /Entrar pelo CLI/ }) as HTMLButtonElement).disabled).toBe(false)

    // The CLI exits after the user cancelled — the late failure must not
    // paint an error on an idle screen.
    emitLoginEvent({ kind: 'complete', message: 'Login não concluído.', ok: false })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a new failure REPLAYS the shake (block remounts per message)', async () => {
    await startLoginAndAwaitBrowser()
    emitLoginEvent({ kind: 'error', message: 'primeira causa' })
    const first = await screen.findByRole('alert')
    expect(first.className).toContain('is-shaking')

    emitLoginEvent({ kind: 'error', message: 'segunda causa' })
    const second = await screen.findByRole('alert')
    expect(second.textContent).toBe('segunda causa')
    expect(second.className).toContain('is-shaking')
    expect(second).not.toBe(first) // remounted → animation replays
  })
})
