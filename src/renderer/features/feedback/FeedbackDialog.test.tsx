import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n'
import type { FeedbackDiagnostics, FeedbackRequest, FeedbackResult } from '../../../shared/types'
import { FeedbackDialog } from './FeedbackDialog'

/**
 * FeedbackDialog — fallback path regression, FIXTURES CAPTURED from the Rust
 * service as it emits in production (feedback_service.rs):
 *
 *   supabase_failed:       message = "Não foi possível enviar pelo Supabase.
 *                          Uma issue pré-preenchida foi aberta como fallback."
 *                          error   = Some(<reason>)  ← renders submitWarning
 *   supabase_unconfigured: message = "Supabase não está configurado neste
 *                          build. Uma issue pré-preenchida foi aberta."
 *                          error   = None
 *
 * The Rust now opens a pre-filled GitHub issue instead of a mailto. The
 * renderer must surface the localized `code`-driven copy and MUST NOT mention
 * email anywhere in the fallback DOM, in either locale — including the real
 * submitWarning text.
 */

const diagnostics: FeedbackDiagnostics = {
  appVersion: '0.3.0-beta.1',
  platform: 'darwin',
  appSource: 'desktop',
  projectName: undefined,
  activeView: undefined,
  modelId: undefined,
  modelDisplayName: undefined,
  modelSource: undefined,
  accessMode: undefined,
  contextWindow: undefined,
  contextUsage: undefined,
  authMethod: undefined,
  cliLoggedIn: undefined,
  hasApiKey: undefined,
}

// Captured production shapes from feedback_service.rs (channel is still
// 'mailto' — the enum was not renamed; only the URL/behavior changed).
function issueFailedResult(): FeedbackResult {
  return {
    ok: true,
    channel: 'mailto',
    code: 'supabase_failed',
    message: 'Não foi possível enviar pelo Supabase. Uma issue pré-preenchida foi aberta como fallback.',
    error: 'HTTP 500: conexão recusada',
  }
}

function issueUnconfiguredResult(): FeedbackResult {
  return {
    ok: true,
    channel: 'mailto',
    code: 'supabase_unconfigured',
    message: 'Supabase não está configurado neste build. Uma issue pré-preenchida foi aberta.',
    error: undefined,
  }
}

function renderDialog(language: 'en-US' | 'pt-BR', onSubmit: (request: FeedbackRequest) => Promise<FeedbackResult>) {
  return render(
    <I18nProvider language={language}>
      <FeedbackDialog
        open
        defaultContact=""
        diagnostics={diagnostics}
        onClose={() => {}}
        onSubmit={onSubmit}
      />
    </I18nProvider>,
  )
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/Title|Título/), { target: { value: 'Something broke' } })
  fireEvent.change(screen.getByLabelText(/Description|Descrição/), { target: { value: 'It failed in a reproducible way' } })
  fireEvent.click(screen.getByRole('button', { name: /^Send$|^Enviar$/i }))
}

describe('FeedbackDialog — fallback to GitHub issue (code-driven, no email)', () => {
  beforeEach(() => cleanup())

  it('pt-BR: supabase_failed + error renders the real submitWarning, no email anywhere', async () => {
    const onSubmit = vi.fn().mockResolvedValue(issueFailedResult())
    const { container } = renderDialog('pt-BR', onSubmit)

    await fillAndSubmit()

    // The code-driven localized copy replaces the hardcoded Rust message: the
    // production message says "foi aberta" WITHOUT "no GitHub", so asserting
    // "no GitHub" proves code > message precedence.
    expect(await screen.findByText(/Não foi possível enviar pelo Supabase. Uma issue pré-preenchida foi aberta no GitHub/i)).toBeInTheDocument()
    // The captured production shape carries `error` → the real submitWarning
    // must render, and it speaks of the GitHub issue, not an opened email.
    expect(screen.getByText(/O canal principal de feedback falhou/i)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/e-mail|email/i)
  })

  it('en-US: supabase_failed + error renders the real submitWarning, no email anywhere', async () => {
    const onSubmit = vi.fn().mockResolvedValue(issueFailedResult())
    const { container } = renderDialog('en-US', onSubmit)

    await fillAndSubmit()

    expect(await screen.findByText(/Could not send via Supabase/i)).toBeInTheDocument()
    expect(screen.getByText(/The main feedback channel failed/i)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/e-mail|email/i)
  })

  it('pt-BR: supabase_unconfigured (no error) shows issue copy, no email anywhere', async () => {
    const onSubmit = vi.fn().mockResolvedValue(issueUnconfiguredResult())
    const { container } = renderDialog('pt-BR', onSubmit)

    await fillAndSubmit()

    expect(await screen.findByText(/Supabase não está configurado neste build. Uma issue pré-preenchida foi aberta no GitHub/i)).toBeInTheDocument()
    // No error → no submitWarning rendered at all.
    expect(screen.queryByText(/O canal principal de feedback falhou/i)).toBeNull()
    expect(container.textContent).not.toMatch(/e-mail|email/i)
  })

  it('en-US: supabase_unconfigured (no error) shows issue copy, no email anywhere', async () => {
    const onSubmit = vi.fn().mockResolvedValue(issueUnconfiguredResult())
    const { container } = renderDialog('en-US', onSubmit)

    await fillAndSubmit()

    expect(await screen.findByText(/Supabase is not configured in this build/i)).toBeInTheDocument()
    expect(screen.queryByText(/The main feedback channel failed/i)).toBeNull()
    expect(container.textContent).not.toMatch(/e-mail|email/i)
  })
})
