import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import { MarkdownLinkDialog } from './MarkdownLinkDialog'

afterEach(cleanup)

function renderDialog(kind: 'local' | 'external' = 'external') {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  render(
    <I18nProvider language="en-US">
      <MarkdownLinkDialog
        destination={{ href: 'http://localhost:8765/', kind }}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </I18nProvider>,
  )
  return { onCancel, onConfirm }
}

describe('MarkdownLinkDialog', () => {
  it('labels a local URL and focuses Cancel', () => {
    renderDialog('local')
    expect(screen.getByText('Local address')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('warns when the destination is external', () => {
    renderDialog('external')
    expect(screen.getByText('External link')).toBeTruthy()
    expect(screen.getByText('This address will open in your default browser.')).toBeTruthy()
  })

  it('does not confirm until the user chooses Open in browser', () => {
    const { onConfirm } = renderDialog()
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cancels through Escape and the backdrop', () => {
    const { onCancel } = renderDialog()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(screen.getByRole('dialog').parentElement!)
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
