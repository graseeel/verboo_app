import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import { ComputerUseAppApprovalDialog } from './ComputerUseAppApprovalDialog'

const apps = [
  { bundleId: 'com.apple.Notes', name: 'Notes', pid: 1, isFrontmost: false, iconBase64: 'iVBORw0KGgoAAA==' },
  { bundleId: 'com.google.Chrome', name: 'Google Chrome', pid: 2, isFrontmost: true },
]

afterEach(cleanup)

describe('ComputerUseAppApprovalDialog', () => {
  it('shows the fixed tier and requires explicit approval before switching apps', () => {
    const onApprove = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseAppApprovalDialog
          apps={apps}
          approvedBundleIds={['com.apple.Notes']}
          onApprove={onApprove}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('dialog', { name: /manage approved apps/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /google chrome/i }))
    expect(screen.getByRole('combobox', { name: /control level/i })).toHaveValue('view_only')
    expect(onApprove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /approve and use app/i }))
    expect(onApprove).toHaveBeenCalledWith(
      apps[1],
      expect.objectContaining({ tier: 'view_only', scope: 'view' }),
    )
  })

  it('allows a narrower tier and discloses screenshots, isolation, clipboard, and stop behavior', () => {
    const onApprove = vi.fn()
    const disclosureApps = [
      { bundleId: 'com.apple.Notes', name: 'Notes', pid: 1, isFrontmost: true, visibleWindowCount: 1 },
      { bundleId: 'com.apple.TextEdit', name: 'TextEdit', pid: 2, isFrontmost: false, visibleWindowCount: 1 },
    ]
    render(
      <I18nProvider language="en-US">
        <ComputerUseAppApprovalDialog
          apps={disclosureApps}
          approvedBundleIds={[]}
          onApprove={onApprove}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Maximum for this app: Full control')
    expect(dialog).toHaveTextContent(/screenshots/i)
    expect(dialog).toHaveTextContent('1 other visible app will be hidden during control and restored afterward.')
    expect(dialog).toHaveTextContent('Clipboard: not authorized; copy/paste asks separately')
    expect(dialog).toHaveTextContent(/Press Esc anywhere to stop immediately/i)

    fireEvent.change(screen.getByRole('combobox', { name: /control level/i }), {
      target: { value: 'click_only' },
    })
    fireEvent.click(screen.getByRole('button', { name: /approve and use app/i }))
    expect(onApprove).toHaveBeenCalledWith(
      disclosureApps[0],
      expect.objectContaining({ tier: 'click_only', scope: 'input' }),
    )
  })

  it('does not count already-approved apps as hidden during additional consent', () => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseAppApprovalDialog
          apps={[
            { bundleId: 'com.apple.Notes', name: 'Notes', pid: 1, isFrontmost: true, visibleWindowCount: 1 },
            { bundleId: 'com.google.Chrome', name: 'Chrome', pid: 2, isFrontmost: false, visibleWindowCount: 1 },
          ]}
          approvedBundleIds={['com.google.Chrome']}
          onApprove={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent('No other apps will be hidden.')
  })

  it('focuses Cancel, traps focus across the dynamic app list, and cancels on Escape', () => {
    const onCancel = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseAppApprovalDialog
          apps={apps}
          approvedBundleIds={[]}
          onApprove={() => {}}
          onCancel={onCancel}
        />
      </I18nProvider>,
    )

    const cancelButton = screen.getByRole('button', { name: /^cancel$/i })
    const approveButton = screen.getByRole('button', { name: /approve and use app/i })
    const firstAppButton = screen.getByRole('button', { name: /^notes$/i })
    expect(cancelButton).toHaveFocus()

    firstAppButton.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(approveButton).toHaveFocus()
    approveButton.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(firstAppButton).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('restores focus when the app approval dialog closes', () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Manage apps'
    document.body.append(trigger)
    trigger.focus()

    const { unmount } = render(
      <I18nProvider language="en-US">
        <ComputerUseAppApprovalDialog
          apps={apps}
          approvedBundleIds={[]}
          onApprove={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )
    unmount()

    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it('explains the click-only restriction before approving a developer tool', () => {
    const developerApps = [
      { bundleId: 'com.microsoft.VSCode', name: 'Visual Studio Code', pid: 3, isFrontmost: true },
    ]
    render(
      <I18nProvider language="en-US">
        <ComputerUseAppApprovalDialog
          apps={developerApps}
          approvedBundleIds={[]}
          onApprove={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Developer tools are click-only: Verboo can click controls, but cannot type commands or text.',
    )
  })

  it.each([
    ['com.apple.finder', 'Finder can reach files and folders available to your account.'],
    ['com.apple.systempreferences', 'System Settings can change system configuration, privacy, and security permissions.'],
  ])('explains the specific reach of sentinel app %s', (bundleId, warning) => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseAppApprovalDialog
          apps={[{ bundleId, name: 'Sensitive app', pid: 3, isFrontmost: true }]}
          approvedBundleIds={[]}
          onApprove={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent(warning)
  })

  it('exposes the app choices as list items containing buttons', () => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseAppApprovalDialog
          apps={apps}
          approvedBundleIds={[]}
          onApprove={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )

    const list = screen.getByRole('list')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(apps.length)
    expect(within(items[0]!).getByRole('button', { name: 'Notes' })).toBeInTheDocument()
    expect(within(items[1]!).getByRole('button', { name: 'Google Chrome' })).toBeInTheDocument()
    expect(items[0]!.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgoAAA==',
    )
  })
})
