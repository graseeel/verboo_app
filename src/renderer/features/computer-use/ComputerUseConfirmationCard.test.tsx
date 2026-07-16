import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import { ComputerUseConfirmationCard } from './ComputerUseConfirmationCard'

const confirmation = {
  id: 'confirmation-1',
  sessionId: 'session-1',
  appBundleId: 'com.apple.Notes',
  action: 'left_click',
  summary: 'Delete content in the approved app',
  createdAt: 1,
  expiresAt: 2,
  screenshotText: 'private screenshot OCR must never render',
}

afterEach(cleanup)

describe('ComputerUseConfirmationCard', () => {
  it('describes only the controlled app, action, and effect in an inline alertdialog', () => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseConfirmationCard
          variant="inline"
          confirmation={confirmation}
          appName="Notes"
          onAllowOnce={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )

    const card = screen.getByRole('alertdialog', { name: /confirm action/i })
    expect(card).toHaveTextContent('Notes')
    expect(card).toHaveTextContent('Left click')
    expect(card).toHaveTextContent('Delete content in the approved app.')
    expect(card).not.toHaveTextContent('private screenshot OCR')
  })

  it('busy-protects both one-shot decisions', () => {
    const onAllowOnce = vi.fn()
    const onDeny = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseConfirmationCard
          variant="inline"
          confirmation={confirmation}
          appName="Notes"
          busy
          onAllowOnce={onAllowOnce}
          onDeny={onDeny}
        />
      </I18nProvider>,
    )

    const deny = screen.getByRole('button', { name: /^deny$/i })
    const allow = screen.getByRole('button', { name: /applying/i })
    expect(deny).toBeDisabled()
    expect(allow).toBeDisabled()
    fireEvent.click(deny)
    fireEvent.click(allow)
    expect(onAllowOnce).not.toHaveBeenCalled()
    expect(onDeny).not.toHaveBeenCalled()
  })
})
