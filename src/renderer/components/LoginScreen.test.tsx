/**
 * A1: render tests for the event-driven CLI login (login:event channel).
 *
 * Production defects this guards (both reported by REAL users):
 *   - Windows: app showed "Verboo Code — Not responding" stuck on the
 *     login screen after "Sign in with CLI" — the Rust command blocked
 *     on .output() until the CLI exited (now non-blocking, PERISCOPIO).
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

// Ivo's order: NO project-status content in the login UI — the interstitial
// and the personal contact block are gone for good. This is a
// multi-pattern VOCABULARY SWEEP (not an item pin): reintroducing a personal
// channel or dev-version copy fails here automatically.
describe('LoginScreen — no project-status interstitial (Ivo\'s order)', () => {
  it('carries no project-status vocabulary and no personal contact channels (multi-pattern sweep)', () => {
    const { container } = renderLogin()
    expect(container.textContent).not.toMatch(/important notice|aviso importante|development build|versão (em desenvolvimento|independente)|not an official|não é uma versão oficial/i)
    // Personal channels (the removed contact block): mailto/tel links, the
    // personal handle — the sweep is by PATTERN, never by the owner's data.
    expect(container.innerHTML).not.toMatch(/mailto:|tel:|x\.com\//i)
    expect(container.querySelector('.contact-list')).toBeNull()
    expect(screen.queryByRole('button', { name: /I understand and want to continue|Entendi e quero continuar/ })).toBeNull()
  })

  it('keeps the Report issue channel — the AUTHORIZED exception (feedback flow stays)', () => {
    const { props } = renderLogin()
    fireEvent.click(screen.getByRole('button', { name: /Reportar problema/ }))
    expect(props.onOpenFeedback).toHaveBeenCalledTimes(1)
  })
})

// T-C (critical field report, M4): with error banners stacked the panel grew
// past the window and the user could NOT reach the API key field — the screen
// had no scroll container at all (body overflow:hidden + .login-screen without
// overflow-y). jsdom cannot prove real scrollability (layout is runtime —
// declared in the report); what it DOES pin: the FULL state renders COMPLETE
// (every section coexists, key field at the bottom of the stack) and the
// window-drag affordance is a dedicated top strip, not the whole screen.
describe('LoginScreen — T-C: the FULL state (banners + key field) stays complete', () => {
  it('error banner + session note + login URL block + API key form ALL render in one panel, key field LAST', async () => {
    const props = makeProps({
      authError: 'Nenhuma sessão Verboo válida foi encontrada.',
      onCheckExistingAuth: vi.fn(() => Promise.resolve(true)),
    })
    renderLogin(props)

    // Stack the states: session note (success), CLI login URL block.
    fireEvent.click(screen.getByRole('button', { name: /Já autentiquei/ }))
    await screen.findByText('Sessão Verboo validada.')
    fireEvent.click(screen.getByRole('button', { name: /Entrar pelo CLI/ }))
    emitLoginEvent({ kind: 'url', url: LOGIN_URL })
    await screen.findByLabelText('Link de login do Verboo')

    // Everything coexists in ONE document — nothing is dropped when full…
    const warning = screen.getByText('Nenhuma sessão Verboo válida foi encontrada.')
    expect(screen.getByText('Sessão Verboo validada.')).toBeTruthy()
    expect(screen.getByLabelText('Link de login do Verboo')).toBeTruthy()
    const apiKeyInput = screen.getByLabelText(/Chave de API Verboo/) as HTMLInputElement
    expect(screen.getByRole('button', { name: /^Salvar$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Reportar problema/ })).toBeTruthy()

    // …and the key field — the element M4 could not reach — sits BELOW the
    // banners in document order (the bottom of the overflowing stack).
    expect(warning.compareDocumentPosition(apiKeyInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('the window-drag affordance is a dedicated top strip, NOT the content surface', () => {
    const { container } = renderLogin()
    const strip = container.querySelector('.login-drag-strip')
    expect(strip, 'login screen must carry a dedicated drag strip').toBeTruthy()
    const panel = container.querySelector('.login-panel')
    expect(panel).toBeTruthy()
    // The strip must never cover the panel's interactive content.
    expect(strip!.contains(panel!)).toBe(false)
    expect(panel!.contains(strip!)).toBe(false)
  })
})

describe('T5: a rejected onCheckExistingAuth never sticks "Verificando…" (field photo M4)', () => {
  it('pt-BR: rejecting onCheckExistingAuth ends "Verificando…" — not stuck forever', async () => {
    const props = makeProps({
      onCheckExistingAuth: vi.fn(() => Promise.reject(new Error('CLI spawn failed'))),
    })
    renderLogin(props)

    const button = screen.getByRole('button', { name: /Já autentiquei/ })
    fireEvent.click(button)

    // The "verificando" message appears immediately…
    await screen.findByText('Verificando sessão local do Verboo...')

    // …and leaves when the promise rejects — NOT stuck forever (field photo M4).
    await waitFor(() => {
      expect(screen.queryByText('Verificando sessão local do Verboo...')).toBeNull()
    })
    // The button is interactive again (no eternal spinner).
    expect((screen.getByRole('button', { name: /Já autentiquei/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('en-US: rejecting onCheckExistingAuth ends "Checking…" — not stuck forever', async () => {
    const props = makeProps({
      language: 'en-US' as const,
      onCheckExistingAuth: vi.fn(() => Promise.reject(new Error('CLI spawn failed'))),
    })
    render(
      <I18nProvider language="en-US">
        <LoginScreen {...props} />
      </I18nProvider>,
    )

    const button = screen.getByRole('button', { name: /I already authenticated/ })
    fireEvent.click(button)
    await screen.findByText('Checking local Verboo session...')
    await waitFor(() => {
      expect(screen.queryByText('Checking local Verboo session...')).toBeNull()
    })
    expect((screen.getByRole('button', { name: /I already authenticated/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('authErrorDetail renders behind a "Mostrar detalhes técnicos" toggle, not bare on the surface (pt-BR)', () => {
    const props = makeProps({
      authError: 'Não foi possível verificar sua sessão do Verboo.',
      authErrorDetail: 'No such file or directory (os error 2)',
    })
    const { container } = renderLogin(props)

    // Friendly headline is on the surface…
    expect(screen.getByText('Não foi possível verificar sua sessão do Verboo.')).toBeTruthy()
    // …the toggle uses the existing 429 pattern's key…
    expect(screen.getByText('Mostrar detalhes técnicos')).toBeTruthy()
    // …and the raw cause lives inside a <details> element (collapsed by
    // default), not as a bare text node on the login surface.
    const details = container.querySelector('details.login-warning-details')
    expect(details, 'authErrorDetail must render inside a <details> toggle').toBeTruthy()
    expect(details!.textContent).toContain('No such file or directory (os error 2)')
  })
})

describe('T6: apiKeyHelp no longer mentions unsigned beta builds (factually false — builds are signed)', () => {
  it('pt-BR: the help text omits "beta sem assinatura" vocabulary', () => {
    renderLogin()
    const help = screen.getByText(/A chave fica criptografada localmente/)
    // The signed-builds claim was factually false and removed from both locales.
    expect(help.textContent).not.toMatch(/beta sem assinatura|sem assinatura/i)
  })

  it('en-US: the help text omits "unsigned beta" vocabulary', () => {
    const props = makeProps({ language: 'en-US' as const })
    render(
      <I18nProvider language="en-US">
        <LoginScreen {...props} />
      </I18nProvider>,
    )
    const help = screen.getByText(/The key is encrypted locally/)
    expect(help.textContent).not.toMatch(/unsigned beta|unsigned/i)
  })
})
