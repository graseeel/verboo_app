import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputerUseRecoveryDialog } from './ComputerUseRecoveryDialog'

vi.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const copy: Record<string, string> = {
        'computerUse.recovery.title': 'Recover Computer Use?',
        'computerUse.recovery.description': `Computer Use was interrupted while ${values?.executor ?? ''} was handling the visual session.`,
        'computerUse.recovery.choice': `Resume the visual session, or safely return to ${values?.original ?? ''}.`,
        'computerUse.recovery.resume': 'Resume',
        'computerUse.recovery.restore': 'Restore original model',
      }
      return copy[key] ?? key
    },
  }),
}))

afterEach(cleanup)

describe('ComputerUseRecoveryDialog', () => {
  it('explains the interrupted executor lease without cost language', () => {
    render(
      <ComputerUseRecoveryDialog
        executorModelName="Vision Model"
        originalModelName="Default Model"
        onResume={() => {}}
        onRestore={() => {}}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: /recover computer use/i })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription(
      'Computer Use was interrupted while Vision Model was handling the visual session. Resume the visual session, or safely return to Default Model.',
    )
    expect(dialog.textContent).not.toMatch(/cost|billing|quota|upgrade|plan limit/i)
  })

  it('offers exactly the Resume and Restore original model actions', () => {
    const onResume = vi.fn()
    const onRestore = vi.fn()
    render(
      <ComputerUseRecoveryDialog
        executorModelName="Vision Model"
        originalModelName="Default Model"
        onResume={onResume}
        onRestore={onRestore}
      />,
    )

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons.map(button => button.textContent)).toEqual([
      'Resume',
      'Restore original model',
    ])

    fireEvent.click(screen.getByRole('button', { name: /^resume$/i }))
    expect(onResume).toHaveBeenCalledOnce()
    expect(onRestore).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^restore original model$/i }))
    expect(onRestore).toHaveBeenCalledOnce()
  })

  it('focuses Restore original model and treats Escape as the safe restore action', () => {
    const onRestore = vi.fn()
    render(
      <ComputerUseRecoveryDialog
        executorModelName="Vision Model"
        originalModelName="Default Model"
        onResume={() => {}}
        onRestore={onRestore}
      />,
    )

    expect(screen.getByRole('button', { name: /^restore original model$/i })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRestore).toHaveBeenCalledOnce()
  })

  it('traps forward and backward keyboard focus within both actions', () => {
    render(
      <ComputerUseRecoveryDialog
        executorModelName="Vision Model"
        originalModelName="Default Model"
        onResume={() => {}}
        onRestore={() => {}}
      />,
    )

    const resumeButton = screen.getByRole('button', { name: /^resume$/i })
    const restoreButton = screen.getByRole('button', { name: /^restore original model$/i })

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(resumeButton).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(restoreButton).toHaveFocus()
  })
})
