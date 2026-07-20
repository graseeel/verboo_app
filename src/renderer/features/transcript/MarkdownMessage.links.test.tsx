import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(() => Promise.resolve()) }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

import { MarkdownMessage } from './MarkdownMessage'

afterEach(() => {
  cleanup()
  openUrl.mockReset()
})

describe('MarkdownMessage links', () => {
  it('shows confirmation before opening a bare local URL', () => {
    render(
      <div className="app-shell">
        <I18nProvider language="en-US">
          <MarkdownMessage text="Preview: http://localhost:8765/" />
        </I18nProvider>
      </div>,
    )

    fireEvent.click(screen.getByRole('link', { name: 'http://localhost:8765/' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(dialog.closest('.markdown-body')).toBeNull()
    expect(dialog.parentElement?.parentElement).toBe(document.querySelector('.app-shell'))
    expect(screen.getByText('Local address')).toBeTruthy()
    expect(openUrl).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }))
    expect(openUrl).toHaveBeenCalledWith('http://localhost:8765/')
  })

  it('does not request opening a blocked protocol', () => {
    render(
      <I18nProvider language="en-US">
        <MarkdownMessage text="[unsafe](mailto:help@example.com)" />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('link', { name: 'unsafe' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(openUrl).not.toHaveBeenCalled()
  })
})
