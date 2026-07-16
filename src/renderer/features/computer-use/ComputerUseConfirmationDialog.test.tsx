import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import { ComputerUseConfirmationDialog } from './ComputerUseConfirmationDialog'

afterEach(cleanup)

describe('ComputerUseConfirmationDialog', () => {
  const confirmation = {
    id: 'confirmation-1',
    sessionId: 'session-1',
    appBundleId: 'com.apple.Notes',
    action: 'left_click',
    summary: 'Delete content in the approved app',
    createdAt: 1,
    expiresAt: 2,
  }

  it('shows the app name and a friendly action label without exposing technical identifiers', () => {
    const onAllowOnce = vi.fn()
    const onDeny = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseConfirmationDialog
          confirmation={confirmation}
          appName="Notes"
          onAllowOnce={onAllowOnce}
          onDeny={onDeny}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('dialog', { name: /confirm action/i })).toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
    expect(screen.queryByText(/com\.apple\.Notes/i)).not.toBeInTheDocument()
    expect(screen.getByText('Left click')).toBeInTheDocument()
    expect(screen.queryByText('left_click')).not.toBeInTheDocument()
    expect(screen.getByText('Delete content in the approved app.')).toBeInTheDocument()
    expect(screen.queryByText(/cost|token|billing|quota|upgrade/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /allow once/i }))
    expect(onAllowOnce).toHaveBeenCalledOnce()
    expect(onDeny).not.toHaveBeenCalled()
  })

  it('denies without granting the action', () => {
    const onAllowOnce = vi.fn()
    const onDeny = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseConfirmationDialog
          confirmation={confirmation}
          appName="Notes"
          onAllowOnce={onAllowOnce}
          onDeny={onDeny}
        />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }))
    expect(onDeny).toHaveBeenCalledOnce()
    expect(onAllowOnce).not.toHaveBeenCalled()
  })

  it('focuses Deny, traps focus, and treats Escape as denial', () => {
    const onDeny = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseConfirmationDialog
          confirmation={confirmation}
          appName="Notes"
          onAllowOnce={() => {}}
          onDeny={onDeny}
        />
      </I18nProvider>,
    )

    const denyButton = screen.getByRole('button', { name: /^deny$/i })
    const allowButton = screen.getByRole('button', { name: /^allow once$/i })
    expect(denyButton).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(allowButton).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(denyButton).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDeny).toHaveBeenCalledOnce()
  })

  it('restores focus when the action confirmation closes', () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Previous action'
    document.body.append(trigger)
    trigger.focus()

    const { unmount } = render(
      <I18nProvider language="en-US">
        <ComputerUseConfirmationDialog
          confirmation={confirmation}
          appName="Notes"
          onAllowOnce={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )
    unmount()

    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it('uses a generic friendly label for an unknown action token', () => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseConfirmationDialog
          confirmation={{ ...confirmation, action: 'future_internal_action' }}
          appName="Notes"
          onAllowOnce={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('Requested interaction')).toBeInTheDocument()
    expect(screen.queryByText('future_internal_action')).not.toBeInTheDocument()
  })

  it('does not render the bundle identifier when no display name is available', () => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseConfirmationDialog
          confirmation={confirmation}
          appName="com.apple.Notes"
          onAllowOnce={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('Authorized app')).toBeInTheDocument()
    expect(screen.queryByText(/com\.apple\.Notes/i)).not.toBeInTheDocument()
  })

  it('localizes controlled backend summaries instead of showing raw English in Portuguese', () => {
    render(
      <I18nProvider language="pt-BR">
        <ComputerUseConfirmationDialog
          confirmation={{ ...confirmation, summary: 'Paste clipboard contents into the approved app' }}
          appName="Notes"
          onAllowOnce={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('Colar o conteúdo da área de transferência no app autorizado.')).toBeInTheDocument()
    expect(screen.queryByText(/Paste clipboard contents/i)).not.toBeInTheDocument()
  })

  it('uses a localized safe fallback for an unknown backend summary', () => {
    render(
      <I18nProvider language="pt-BR">
        <ComputerUseConfirmationDialog
          confirmation={{ ...confirmation, summary: 'Untrusted raw backend detail' }}
          appName="Notes"
          onAllowOnce={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('Executar a interação solicitada no app autorizado.')).toBeInTheDocument()
    expect(screen.queryByText('Untrusted raw backend detail')).not.toBeInTheDocument()
  })
})
