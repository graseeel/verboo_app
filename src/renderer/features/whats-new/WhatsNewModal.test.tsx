import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import { WhatsNewModal } from './WhatsNewModal'

const status = { version: '0.7.0-beta', tag: 'v0.7.0-beta', preview: false }

function renderModal(overrides: Partial<ComponentProps<typeof WhatsNewModal>> = {}) {
  const onAcknowledge = vi.fn(async () => ({ persisted: true }))
  const onDismiss = vi.fn()
  const openReleaseUrl = vi.fn(async () => undefined)
  const view = render(
    <div>
      <button type="button">Background action</button>
      <I18nProvider language="en-US">
        <WhatsNewModal
          status={status}
          onAcknowledge={onAcknowledge}
          onDismiss={onDismiss}
          openReleaseUrl={openReleaseUrl}
          {...overrides}
        />
      </I18nProvider>
    </div>,
  )
  return { view, onAcknowledge, onDismiss, openReleaseUrl }
}

afterEach(() => vi.restoreAllMocks())

describe('WhatsNewModal', () => {
  it('renders version, summary, six highlights, and exactly two actions', () => {
    renderModal()
    expect(screen.getByRole('dialog', { name: 'Verboo Code 0.7.0-beta is here' })).toBeVisible()
    expect(screen.getByText(/major update for working with iOS apps/i)).toBeVisible()
    expect(screen.getByText('Built-in iOS Simulator — macOS')).toBeVisible()
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
    expect(within(screen.getByRole('dialog')).getAllByRole('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Background action' })).toHaveAttribute('inert')
  })

  it('starts on Close, traps focus, handles Escape, and ignores backdrop clicks', async () => {
    const { onAcknowledge, onDismiss } = renderModal()
    const close = screen.getByRole('button', { name: 'Close' })
    const learnMore = screen.getByRole('button', { name: 'Learn more' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(learnMore).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.click(screen.getByTestId('whats-new-backdrop'))
    expect(onAcknowledge).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(onAcknowledge).toHaveBeenCalledWith('0.7.0-beta'))
    expect(onDismiss).toHaveBeenCalledWith({ persisted: true })
  })

  it('opens the exact tag and acknowledges only after a successful open', async () => {
    const { openReleaseUrl, onAcknowledge, onDismiss } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Learn more' }))
    await waitFor(() => expect(openReleaseUrl).toHaveBeenCalledWith(
      'https://github.com/graseeel/verboo_app/releases/tag/v0.7.0-beta',
    ))
    await waitFor(() => expect(onAcknowledge).toHaveBeenCalledWith('0.7.0-beta'))
    expect(openReleaseUrl.mock.invocationCallOrder[0]).toBeLessThan(onAcknowledge.mock.invocationCallOrder[0])
    expect(onDismiss).toHaveBeenCalledWith({ persisted: true })
  })

  it('keeps the modal open and does not acknowledge when opening fails', async () => {
    const openReleaseUrl = vi.fn(async () => { throw new Error('browser unavailable') })
    const { onAcknowledge, onDismiss } = renderModal({ openReleaseUrl })
    fireEvent.click(screen.getByRole('button', { name: 'Learn more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not open the release page/i)
    expect(onAcknowledge).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeVisible()
  })

  it('dismisses with a non-fatal result when acknowledgment IPC rejects', async () => {
    const onAcknowledge = vi.fn(async () => { throw new Error('IPC unavailable') })
    const { onDismiss } = renderModal({ onAcknowledge })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith({
      persisted: false,
      error: 'IPC unavailable',
    }))
  })

  it('removes modal movement when reduced motion is requested', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/whats-new.css'), 'utf8')
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*\.whats-new-modal[\s\S]*animation:\s*none/)
  })
})
