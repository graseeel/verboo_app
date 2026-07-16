import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputerUseExecutorDialog } from './ComputerUseExecutorDialog'

vi.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const copy: Record<string, string> = {
        'common.cancel': 'Cancel',
        'computerUse.executor.title': 'Use a visual model?',
        'computerUse.executor.description': `Verboo will temporarily delegate Computer Use to ${values?.model ?? ''}.`,
        'computerUse.executor.reason': 'The current model cannot inspect the screen, so this model will control the Computer Use session temporarily.',
        'computerUse.executor.continue': 'Continue',
      }
      return copy[key] ?? key
    },
  }),
}))

afterEach(cleanup)

describe('ComputerUseExecutorDialog', () => {
  it('identifies the temporary destination model and why visual understanding is required', () => {
    render(
      <ComputerUseExecutorDialog
        destinationModelName="Vision Model"
        onContinue={() => {}}
        onCancel={() => {}}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: /use a visual model/i })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveTextContent('Vision Model')
    expect(dialog).toHaveTextContent(/current model cannot inspect the screen/i)
    expect(dialog).toHaveTextContent(/control the Computer Use session temporarily/i)
    expect(dialog.textContent).not.toMatch(/cost|billing|quota|upgrade|plan limit/i)
  })

  it('requires an explicit Continue or Cancel action', () => {
    const onContinue = vi.fn()
    const onCancel = vi.fn()
    render(
      <ComputerUseExecutorDialog
        destinationModelName="Vision Model"
        onContinue={onContinue}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    expect(onContinue).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('focuses Continue and treats Escape as Cancel', () => {
    const onCancel = vi.fn()
    render(
      <ComputerUseExecutorDialog
        destinationModelName="Vision Model"
        onContinue={() => {}}
        onCancel={onCancel}
      />,
    )

    expect(screen.getByRole('button', { name: /^continue$/i })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('keeps keyboard focus within the modal actions', () => {
    render(
      <ComputerUseExecutorDialog
        destinationModelName="Vision Model"
        onContinue={() => {}}
        onCancel={() => {}}
      />,
    )

    const continueButton = screen.getByRole('button', { name: /^continue$/i })
    const cancelButton = screen.getByRole('button', { name: /^cancel$/i })

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(cancelButton).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(continueButton).toHaveFocus()
  })

  it('restores focus to the trigger when the dialog closes', () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Start Computer Use'
    document.body.append(trigger)
    trigger.focus()

    const { unmount } = render(
      <ComputerUseExecutorDialog
        destinationModelName="Vision Model"
        onContinue={() => {}}
        onCancel={() => {}}
      />,
    )
    unmount()

    expect(trigger).toHaveFocus()
    trigger.remove()
  })
})
