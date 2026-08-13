import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProviderRiskDialog } from './ProviderRiskDialog'

// F4 risk_notice dialog: the notice body is the VERBATIM event text (never
// summarized), policy URLs become links, and both actions are explicit.
const NOTICE = 'Anthropic Usage Policy applies to this login.\nReview it before continuing.'

describe('ProviderRiskDialog', () => {
  it('renders the FULL notice verbatim on screen, line breaks included', () => {
    render(<ProviderRiskDialog provider="claude" message={NOTICE} onAccept={() => {}} onCancel={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Anthropic Usage Policy applies to this login.')
    expect(dialog.textContent).toContain('Review it before continuing.')
  })

  it('turns a policy URL from the notice into a real link', () => {
    render(
      <ProviderRiskDialog
        provider="claude"
        message="See https://www.anthropic.com/legal/usage-policy for details."
        onAccept={() => {}}
        onCancel={() => {}}
      />,
    )
    const link = screen.getByRole('link', { name: 'https://www.anthropic.com/legal/usage-policy' })
    expect(link.getAttribute('href')).toBe('https://www.anthropic.com/legal/usage-policy')
  })

  it('accept and cancel are explicit owner actions (no auto-accept)', () => {
    const onAccept = vi.fn()
    const onCancel = vi.fn()
    render(<ProviderRiskDialog provider="claude" message={NOTICE} onAccept={onAccept} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /Accept the risk and continue|Aceitar o risco e continuar/i }))
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$|^Cancelar$/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  // T3 finishing: the dialog frame carries the hierarchy — risk signal,
  // provider brand, subtitle — and the verbatim notice sits inside a
  // readable document card. The notice wording itself stays untouched.
  it('frames the notice: risk icon, provider brand + subtitle, and the verbatim text inside the document card', () => {
    render(<ProviderRiskDialog provider="claude" message={NOTICE} onAccept={() => {}} onCancel={() => {}} />)
    const dialog = screen.getByRole('dialog')
    // Risk signal (the same danger-tile family as ConfirmDialog).
    expect(dialog.querySelector('.confirm-dialog-icon')).toBeTruthy()
    // Provider brand glyph + a subtitle naming the provider.
    expect(dialog.querySelector('[data-testid="provider-icon-claude"]')).toBeTruthy()
    expect(dialog.querySelector('.provider-risk-subtitle')?.textContent).toContain('Claude')
    // The notice lives in the document card, verbatim.
    const document = dialog.querySelector('.provider-risk-document')
    expect(document).toBeTruthy()
    expect(document?.textContent).toContain('Anthropic Usage Policy applies to this login.')
    expect(document?.textContent).toContain('Review it before continuing.')
  })

  it('accept keeps the danger appearance; cancel stays the neutral exit', () => {
    render(<ProviderRiskDialog provider="claude" message={NOTICE} onAccept={() => {}} onCancel={() => {}} />)
    const accept = screen.getByRole('button', { name: /Accept the risk and continue|Aceitar o risco e continuar/i })
    const cancel = screen.getByRole('button', { name: /^Cancel$|^Cancelar$/i })
    expect(accept.className).toContain('danger-button')
    expect(cancel.className).not.toContain('danger-button')
  })
})
