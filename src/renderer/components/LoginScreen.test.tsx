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

  it('a rejected onLoginComplete shows persistent localized feedback with technical details', async () => {
    const props = makeProps({
      onLoginComplete: vi.fn(() => Promise.reject(new Error('revalidation unavailable'))),
    })
    await startLoginAndAwaitBrowser(props)

    emitLoginEvent({ kind: 'complete', message: 'Login concluído.', ok: true })

    const alert = await screen.findByRole('alert')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(alert.textContent).toContain('Não foi possível concluir o login pelo CLI.')
    expect(alert.querySelector('details')?.textContent).toContain('revalidation unavailable')
  })

  it('kind=error shows the SPECIFIC cause and re-enables the button', async () => {
    await startLoginAndAwaitBrowser()
    const cause = 'Falha ao iniciar login do CLI Verboo: spawn ENOENT'

    emitLoginEvent({ kind: 'error', message: cause })

    const alert = await screen.findByRole('alert')
    // PA-37: a short summary on the surface; the raw cause stays reachable
    // behind the details toggle, never bare.
    expect(alert.textContent).toContain('Não foi possível concluir o login pelo CLI.')
    expect(alert.querySelector('details')?.textContent).toContain(cause)
    expect((screen.getByRole('button', { name: /Entrar pelo CLI/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('kind=complete with ok:false shows the CLI message (not a generic) and re-enables', async () => {
    await startLoginAndAwaitBrowser()

    emitLoginEvent({ kind: 'complete', message: 'Login não concluído: token expirado', ok: false })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Não foi possível concluir o login pelo CLI.')
    expect(alert.querySelector('details')?.textContent).toContain('Login não concluído: token expirado')
    expect((screen.getByRole('button', { name: /Entrar pelo CLI/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('invoke rejection surfaces the Rust cause — the button NEVER gets stuck (Windows "Not responding")', async () => {
    const props = makeProps({
      onStartLogin: vi.fn(() => Promise.reject('Falha ao iniciar login do CLI Verboo: spawn ENOENT')),
    })
    renderLogin(props)

    fireEvent.click(screen.getByRole('button', { name: /Entrar pelo CLI/ }))

    const alert = await screen.findByRole('alert')
    expect(alert.querySelector('details')?.textContent).toContain('Falha ao iniciar login do CLI Verboo: spawn ENOENT')
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
    expect(second.textContent).toContain('segunda causa')
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

// T-C (critical field report, M4) → PA-37: the original defect was the
// panel overflowing with STACKED banners until the API key field became
// unreachable. Progressive disclosure resolves it structurally: the key
// field is no longer stacked at the bottom — it SWAPS the central block
// one click away, while notes/banners live OUTSIDE the swapped region.
// jsdom cannot prove real scrollability (layout is runtime — declared in
// the report); what it DOES pin: every path stays reachable in both modes
// and the window-drag affordance is a dedicated top strip.
describe('LoginScreen — PA-37: progressive disclosure keeps every path reachable', () => {
  it('CLI-mode full state swaps to API mode and discards the previous user-action result', async () => {
    const props = makeProps({
      authError: { kind: 'no-session', message: 'Nenhuma sessão Verboo válida foi encontrada.' },
      onCheckExistingAuth: vi.fn(() => Promise.resolve(true)),
    })
    renderLogin(props)

    // The empty state is a NEUTRAL note — not a red banner, no alert role.
    const emptyNote = screen.getByText('Nenhuma sessão Verboo válida foi encontrada.')
    expect(emptyNote.className).toBe('login-empty')
    expect(screen.queryByRole('alert')).toBeNull()

    // Stack the CLI-mode states: session note (success) + login URL block.
    fireEvent.click(screen.getByRole('button', { name: /Já autentiquei/ }))
    await screen.findByText('Sessão Verboo validada.')
    fireEvent.click(screen.getByRole('button', { name: /Entrar pelo CLI/ }))
    emitLoginEvent({ kind: 'url', url: LOGIN_URL })
    await screen.findByLabelText('Link de login do Verboo')

    // The key field is NOT stacked underneath — it swaps in on request…
    expect(screen.queryByLabelText(/Chave de API Verboo/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Usar chave de API/ }))
    expect(screen.getByLabelText(/Chave de API Verboo/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Salvar$/ })).toBeTruthy()
    // …the primary leaves while the form owns the central block…
    expect(screen.queryByRole('button', { name: /Entrar pelo CLI/ })).toBeNull()
    // …the passive backend note survives the swap, while the result of
    // the previous user action is discarded when the API action starts…
    expect(screen.getByText('Nenhuma sessão Verboo válida foi encontrada.')).toBeTruthy()
    expect(screen.queryByText('Sessão Verboo validada.')).toBeNull()
    // …and the tertiary paths stay reachable in the footer.
    expect(screen.getByRole('button', { name: /Reportar problema/ })).toBeTruthy()

    // The way back restores the CLI block without resurrecting the old
    // in-flight URL: entering API mode replaced that user action.
    fireEvent.click(screen.getByRole('button', { name: /Voltar para o login/ }))
    expect(screen.getByRole('button', { name: /Entrar pelo CLI/ })).toBeTruthy()
    expect(screen.queryByLabelText('Link de login do Verboo')).toBeNull()
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

describe('LoginScreen — PA-37 state rules (empty state, one error, swap)', () => {
  it('empty state: "no session found" is a neutral note, NEVER a red banner', () => {
    renderLogin(makeProps({ authError: { kind: 'no-session', message: 'Nenhuma sessão Verboo válida foi encontrada.' } }))

    const note = screen.getByText('Nenhuma sessão Verboo válida foi encontrada.')
    expect(note.className).toBe('login-empty')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.login-warning')).toBeNull()
  })

  // Gate PA-37g (the Sonda's counterfactual): the producer materialized the
  // message in ONE language; the user then switches the selector — the stale
  // string matches NO current dictionary, so a text-based discriminator
  // would resurrect the red banner. The stable `kind` must win in pt-BR AND
  // en-US, across the switch with re-render.
  it('language switch pt-BR → en-US NEVER resurrects the red banner for the no-session state', () => {
    const props = makeProps({
      authError: { kind: 'no-session', message: 'Nenhuma sessão Verboo válida foi encontrada.' },
    })
    const { rerender } = render(
      <I18nProvider language="pt-BR">
        <LoginScreen {...props} />
      </I18nProvider>,
    )

    expect(screen.getByText('Nenhuma sessão Verboo válida foi encontrada.').className).toBe('login-empty')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.login-warning')).toBeNull()

    // Same stale pt-BR string in state, dictionary now English.
    rerender(
      <I18nProvider language="en-US">
        <LoginScreen {...props} language="en-US" />
      </I18nProvider>,
    )
    expect(screen.getByText('Nenhuma sessão Verboo válida foi encontrada.').className).toBe('login-empty')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.login-warning')).toBeNull()
  })

  it('language switch en-US → pt-BR NEVER resurrects the red banner either', () => {
    const props = makeProps({
      language: 'en-US' as const,
      authError: { kind: 'no-session', message: 'No valid Verboo session was found.' },
    })
    const { rerender } = render(
      <I18nProvider language="en-US">
        <LoginScreen {...props} />
      </I18nProvider>,
    )

    expect(screen.getByText('No valid Verboo session was found.').className).toBe('login-empty')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.login-warning')).toBeNull()

    rerender(
      <I18nProvider language="pt-BR">
        <LoginScreen {...props} language="pt-BR" />
      </I18nProvider>,
    )
    expect(screen.getByText('No valid Verboo session was found.').className).toBe('login-empty')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.login-warning')).toBeNull()
  })

  it('the stable no-session kind stays neutral even if a stale diagnostic detail coexists', () => {
    renderLogin(makeProps({
      authError: { kind: 'no-session', message: 'Nenhuma sessão Verboo válida foi encontrada.' },
      authErrorDetail: 'stale diagnostic from an older validation',
    }))

    expect(screen.getByText('Nenhuma sessão Verboo válida foi encontrada.').className).toBe('login-empty')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a REAL validation failure renders ONE banner, inline, with a retry action', async () => {
    const props = makeProps({
      authError: { kind: 'error', message: 'Não foi possível verificar sua sessão do Verboo.' },
      authErrorDetail: 'No such file or directory (os error 2)',
    })
    renderLogin(props)

    expect(screen.getAllByRole('alert')).toHaveLength(1)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Não foi possível verificar sua sessão do Verboo.')
    expect(alert.querySelector('details')?.textContent).toContain('os error 2')

    // The retry action re-runs the validation.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    })
    expect(props.onCheckExistingAuth).toHaveBeenCalledTimes(1)
  })

  it('a CLI failure shows summary + details (raw cause never bare) and retries the CLI login', async () => {
    const props = makeProps()
    renderLogin(props)
    fireEvent.click(screen.getByRole('button', { name: /Entrar pelo CLI/ }))
    await screen.findByText('Login iniciado — aguardando o navegador…')

    act(() => {
      loginEventHandler()({ payload: { kind: 'error', message: 'Falha ao iniciar login do CLI Verboo: spawn ENOENT' } })
    })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Não foi possível concluir o login pelo CLI.')
    expect(alert.querySelector('details')?.textContent).toContain('spawn ENOENT')

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(props.onStartLogin).toHaveBeenCalledTimes(2))
  })

  it('ONE banner even when a CLI failure and a validation error coexist (the freshest action wins)', async () => {
    renderLogin(makeProps({ authError: { kind: 'error', message: 'Não foi possível verificar sua sessão do Verboo.' } }))
    fireEvent.click(screen.getByRole('button', { name: /Entrar pelo CLI/ }))
    await screen.findByText('Login iniciado — aguardando o navegador…')

    act(() => {
      loginEventHandler()({ payload: { kind: 'error', message: 'causa técnica crua' } })
    })

    await screen.findByRole('alert')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível concluir o login pelo CLI.')
  })

  it('replaces an earlier CLI failure with the result of checking an existing session', async () => {
    renderLogin(makeProps({
      authError: { kind: 'no-session', message: 'Nenhuma sessão Verboo válida foi encontrada.' },
      onCheckExistingAuth: vi.fn(() => Promise.resolve(false)),
    }))
    fireEvent.click(screen.getByRole('button', { name: /Entrar pelo CLI/ }))
    await screen.findByText('Login iniciado — aguardando o navegador…')
    act(() => {
      loginEventHandler()({ payload: { kind: 'error', message: 'falha antiga do CLI' } })
    })
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: /Já autentiquei/ }))

    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(screen.getByRole('alert').textContent).toContain('Não foi possível verificar sua sessão do Verboo.')
    })
    expect(screen.getByRole('alert').textContent).not.toContain('falha antiga do CLI')
    expect(screen.queryByText('Nenhuma sessão Verboo válida foi encontrada.')).toBeNull()
  })

  it('replaces an earlier CLI failure with a rejected API key result and its new detail', async () => {
    renderLogin(makeProps({
      onSaveApiKey: vi.fn(() => Promise.reject(new Error('keychain indisponível agora'))),
    }))
    fireEvent.click(screen.getByRole('button', { name: /Entrar pelo CLI/ }))
    await screen.findByText('Login iniciado — aguardando o navegador…')
    act(() => {
      loginEventHandler()({ payload: { kind: 'error', message: 'falha antiga do CLI' } })
    })
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: /Usar chave de API/ }))
    fireEvent.change(screen.getByLabelText(/Chave de API Verboo/), { target: { value: 'vk_test_123' } })
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }))

    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(screen.getByRole('alert').textContent).toContain('Não foi possível validar a chave de API.')
    })
    expect(screen.getByRole('alert').querySelector('details')?.textContent).toContain('keychain indisponível agora')
    expect(screen.getByRole('alert').textContent).not.toContain('falha antiga do CLI')
  })

  it('exactly ONE primary action in the default mode — none while the API form owns the block', () => {
    const { container } = renderLogin()
    expect(container.querySelectorAll('.primary-action')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: /Usar chave de API/ }))
    expect(container.querySelectorAll('.primary-action')).toHaveLength(0)
  })

  it('API key swap: replaces the central block, focuses the field, submits, and the back link restores it', async () => {
    const props = makeProps({ onSaveApiKey: vi.fn(() => Promise.resolve(true)) })
    renderLogin(props)

    fireEvent.click(screen.getByRole('button', { name: /Usar chave de API/ }))
    const input = screen.getByLabelText(/Chave de API Verboo/) as HTMLInputElement
    expect(screen.queryByRole('button', { name: /Entrar pelo CLI/ })).toBeNull()
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'vk_test_123' } })
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }))
    await screen.findByText('Chave de API validada.')
    expect(props.onSaveApiKey).toHaveBeenCalledWith('vk_test_123')

    fireEvent.click(screen.getByRole('button', { name: /Voltar para o login/ }))
    expect(screen.getByRole('button', { name: /Entrar pelo CLI/ })).toBeTruthy()
    expect(screen.queryByLabelText(/Chave de API Verboo/)).toBeNull()
    // Focus returns to the button that opened the form (keyboard a11y).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Usar chave de API/ }))
  })

  it('a rejected API key save shows persistent localized feedback with technical details', async () => {
    const props = makeProps({
      onSaveApiKey: vi.fn(() => Promise.reject(new Error('keychain unavailable'))),
    })
    renderLogin(props)

    fireEvent.click(screen.getByRole('button', { name: /Usar chave de API/ }))
    fireEvent.change(screen.getByLabelText(/Chave de API Verboo/), { target: { value: 'vk_test_123' } })
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Não foi possível validar a chave de API.')
    expect(alert.querySelector('details')?.textContent).toContain('keychain unavailable')
    expect(screen.getByLabelText(/Chave de API Verboo/)).toBeTruthy()
  })

  it('an API key save returning false shows persistent localized feedback', async () => {
    renderLogin(makeProps({
      onSaveApiKey: vi.fn(() => Promise.resolve(false)),
    }))

    fireEvent.click(screen.getByRole('button', { name: /Usar chave de API/ }))
    fireEvent.change(screen.getByLabelText(/Chave de API Verboo/), { target: { value: 'vk_test_123' } })
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }))

    const alert = await screen.findByRole('alert')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(alert.textContent).toContain('Não foi possível validar a chave de API.')
    expect(screen.getByLabelText(/Chave de API Verboo/)).toBeTruthy()
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
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Não foi possível verificar sua sessão do Verboo.')
    expect(alert.querySelector('details')?.textContent).toContain('CLI spawn failed')
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
    expect(screen.getByRole('alert').textContent).toContain('Could not verify your Verboo session.')
  })

  it('authErrorDetail renders behind a "Mostrar detalhes técnicos" toggle, not bare on the surface (pt-BR)', () => {
    const props = makeProps({
      authError: { kind: 'error', message: 'Não foi possível verificar sua sessão do Verboo.' },
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
    // PA-37: the API key help lives in the swapped-in API mode.
    fireEvent.click(screen.getByRole('button', { name: /Usar chave de API/ }))
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
    fireEvent.click(screen.getByRole('button', { name: /Use an API key/ }))
    const help = screen.getByText(/The key is encrypted locally/)
    expect(help.textContent).not.toMatch(/unsigned beta|unsigned/i)
  })
})
