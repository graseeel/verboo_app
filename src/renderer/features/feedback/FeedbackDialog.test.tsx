import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createTranslator, getTranslationKeys, I18nProvider } from '../../i18n'
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
 * renderer must surface localized, provider-neutral `code`-driven copy and
 * MUST NOT mention email or the internal provider anywhere in the fallback
 * DOM, in either locale — including the real submitWarning text.
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

function cssDeclarations(fileName: string, selector: string): Record<string, string> {
  const style = document.createElement('style')
  style.textContent = readFileSync(resolve(process.cwd(), 'src/renderer/styles', fileName), 'utf8')
  document.head.appendChild(style)

  const rule = Array.from(style.sheet?.cssRules ?? []).find(candidate => {
    if (candidate.type !== CSSRule.STYLE_RULE) return false
    return (candidate as CSSStyleRule).selectorText
      .split(',')
      .map(part => part.trim())
      .includes(selector)
  }) as CSSStyleRule | undefined

  const declarations = rule
    ? Object.fromEntries(Array.from(rule.style).map(property => [property, rule.style.getPropertyValue(property).trim()]))
    : {}
  style.remove()
  return declarations
}

function orderedCssDeclarations(fileName: string, selector: string): Array<[string, string]> {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles', fileName), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const ruleStart = new RegExp(`(?:^|})\\s*${escapedSelector}\\s*\\{`, 'm').exec(css)
  if (!ruleStart) return []

  const bodyStart = ruleStart.index + ruleStart[0].lastIndexOf('{') + 1
  const bodyEnd = css.indexOf('}', bodyStart)
  if (bodyEnd < 0) return []

  return css.slice(bodyStart, bodyEnd)
    .split(';')
    .map(declaration => declaration.trim())
    .filter(Boolean)
    .map(declaration => {
      const colon = declaration.indexOf(':')
      return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()]
    })
}

function supportCopyKeys(language: 'en-US' | 'pt-BR'): string[] {
  return getTranslationKeys(language).filter(key => key.startsWith('feedback.'))
}

describe('FeedbackDialog — fallback to GitHub issue (code-driven, provider-neutral)', () => {
  beforeEach(() => cleanup())

  it('keeps actions outside the scroll body in a dynamic-viewport dialog', () => {
    const { container } = renderDialog('en-US', vi.fn())
    const dialog = screen.getByRole('dialog', { name: 'Help and feedback' })
    const form = dialog.querySelector<HTMLFormElement>(':scope > form.feedback-form')
    const scrollBody = form?.querySelector<HTMLElement>(':scope > .feedback-scroll-body')
    const footer = form?.querySelector<HTMLElement>(':scope > footer.modal-actions')

    expect(form).toBeInTheDocument()
    expect(scrollBody).toBeInTheDocument()
    expect(footer).toBeInTheDocument()
    expect(scrollBody).not.toContainElement(footer ?? null)
    expect(container.querySelector('.feedback-modal')).toBe(dialog)
    expect(container.querySelector('.feedback-backdrop.modal-backdrop')).toBeInTheDocument()

    const backdropStyles = cssDeclarations('composer.css', '.modal-backdrop')
    const modalStyles = cssDeclarations('feedback.css', '.feedback-modal')
    const formStyles = cssDeclarations('feedback.css', '.feedback-form')
    const scrollStyles = cssDeclarations('feedback.css', '.feedback-scroll-body')
    const maxHeightFallbacks = orderedCssDeclarations('feedback.css', '.feedback-modal')
      .filter(([property]) => property === 'max-height')
      .map(([, value]) => value)
    const viewportUnits = maxHeightFallbacks.map(value => (
      /^min\(\s*760px\s*,\s*calc\(\s*100(d?vh)\s*-\s*48px\s*\)\s*\)$/.exec(value)?.[1]
    ))
    const viewportClearance = /calc\(100dvh\s*-\s*([\d.]+)px\)/.exec(modalStyles['max-height'])

    expect(viewportUnits).toEqual(['vh', 'dvh'])
    expect(viewportClearance).not.toBeNull()
    expect(Number(viewportClearance?.[1])).toBeGreaterThanOrEqual(2 * Number.parseFloat(backdropStyles.padding))
    expect(modalStyles['grid-template-rows']).toMatch(/^auto\s+minmax\(0,\s*1fr\)$/)
    expect(modalStyles.overflow).toBe('hidden')
    expect(formStyles['grid-template-rows']).toMatch(/^minmax\(0,\s*1fr\)\s+auto$/)
    expect(formStyles['min-height']).toMatch(/^0(?:px)?$/)
    expect(scrollStyles['min-height']).toMatch(/^0(?:px)?$/)
    expect(scrollStyles['overflow-y']).toBe('auto')
  })

  it.each([
    ['en-US', 'Describe the issue or suggestion. If sending fails, we will open a pre-filled GitHub issue.'],
    ['pt-BR', 'Descreva o problema ou sugestão. Se o envio falhar, abriremos uma issue pré-preenchida no GitHub.'],
  ] as const)('keeps support copy provider-neutral in %s', (language, expectedSubtitle) => {
    const t = createTranslator(language)
    const keys = supportCopyKeys(language)
    const supportCopy = keys.map(key => t(key)).join('\n')

    expect(keys.length).toBeGreaterThan(0)
    expect(t('feedback.subtitle')).toBe(expectedSubtitle)
    expect(supportCopy).not.toMatch(/supabase/i)
  })

  it('brings a newly submitted result into the scrollable view', async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    try {
      renderDialog('en-US', vi.fn().mockResolvedValue(issueUnconfiguredResult()))
      await fillAndSubmit()

      const message = await screen.findByText(/Feedback submission is unavailable in this build/i)
      const result = message.closest('.feedback-result')
      expect(result).toBeInTheDocument()
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }))
      expect(scrollIntoView.mock.instances[0]).toBe(result)
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
      } else {
        Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
      }
    }
  })

  it.each([
    ['en-US', 'A pre-filled GitHub issue was opened as a fallback.'],
    ['pt-BR', 'Uma issue pré-preenchida foi aberta no GitHub como alternativa.'],
  ] as const)('keeps an unknown result code provider-neutral in %s', async (language, expectedFallback) => {
    const unknownResult = {
      ok: true,
      channel: 'mailto',
      code: 'future_provider_failure',
      message: 'Supabase rejected the request in feedback_entries.',
      // IPC is runtime data and can arrive ahead of this build's code union.
    } as unknown as FeedbackResult
    const { container } = renderDialog(language, vi.fn().mockResolvedValue(unknownResult))

    await fillAndSubmit()

    expect(await screen.findByText(expectedFallback)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/supabase|feedback_entries/i)
  })

  it('pt-BR: supabase_failed + error renders provider-neutral fallback and warning', async () => {
    const onSubmit = vi.fn().mockResolvedValue(issueFailedResult())
    const { container } = renderDialog('pt-BR', onSubmit)

    await fillAndSubmit()

    // The provider-neutral localized copy replaces the captured Rust message,
    // proving that the structured code takes precedence over raw backend text.
    expect(await screen.findByText(/Não foi possível usar o canal principal de feedback. Uma issue pré-preenchida foi aberta no GitHub como alternativa/i)).toBeInTheDocument()
    // The captured production shape carries `error` → the real submitWarning
    // must render, and it speaks of the GitHub issue, not an opened email.
    expect(screen.getByText(/O canal principal de feedback falhou/i)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/supabase|e-mail|email/i)
  })

  it('en-US: supabase_failed + error renders provider-neutral fallback and warning', async () => {
    const onSubmit = vi.fn().mockResolvedValue(issueFailedResult())
    const { container } = renderDialog('en-US', onSubmit)

    await fillAndSubmit()

    expect(await screen.findByText(/Could not use the main feedback channel. A pre-filled GitHub issue was opened as a fallback/i)).toBeInTheDocument()
    expect(screen.getByText(/The main feedback channel failed/i)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/supabase|e-mail|email/i)
  })

  it('pt-BR: supabase_unconfigured shows provider-neutral issue copy', async () => {
    const onSubmit = vi.fn().mockResolvedValue(issueUnconfiguredResult())
    const { container } = renderDialog('pt-BR', onSubmit)

    await fillAndSubmit()

    expect(await screen.findByText(/O envio de feedback não está disponível neste build. Uma issue pré-preenchida foi aberta no GitHub/i)).toBeInTheDocument()
    // No error → no submitWarning rendered at all.
    expect(screen.queryByText(/O canal principal de feedback falhou/i)).toBeNull()
    expect(container.textContent).not.toMatch(/supabase|e-mail|email/i)
  })

  it('en-US: supabase_unconfigured shows provider-neutral issue copy', async () => {
    const onSubmit = vi.fn().mockResolvedValue(issueUnconfiguredResult())
    const { container } = renderDialog('en-US', onSubmit)

    await fillAndSubmit()

    expect(await screen.findByText(/Feedback submission is unavailable in this build. A pre-filled GitHub issue was opened/i)).toBeInTheDocument()
    expect(screen.queryByText(/The main feedback channel failed/i)).toBeNull()
    expect(container.textContent).not.toMatch(/supabase|e-mail|email/i)
  })
})
