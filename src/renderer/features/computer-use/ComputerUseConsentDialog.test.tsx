import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUseConsentRequest } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { ComputerUseConsentDialog } from './ComputerUseConsentDialog'

const request: ComputerUseConsentRequest = {
  id: 'request-1',
  goal: 'Write a short note in Notes',
  appName: 'Notes',
  appBundleId: 'com.apple.Notes',
  scope: 'full',
  requestedTier: 'full_control',
  originalModel: { id: 'text-model', displayName: 'Text Model' },
  executorModel: { id: 'vision-model', displayName: 'Vision Model' },
  temporaryExecutor: true,
  hiddenAppCount: 0,
  createdAt: Date.now(),
}

afterEach(cleanup)

describe('ComputerUseConsentDialog', () => {
  it('discloses the goal, approved app, control tier, screenshots, and Esc stop without repeating executor delegation', () => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseConsentDialog request={request} onApprove={() => {}} onDeny={() => {}} />
      </I18nProvider>,
    )

    const dialog = screen.getByRole('dialog', { name: /allow computer use/i })
    expect(dialog).toHaveTextContent('Write a short note in Notes')
    expect(dialog).toHaveTextContent('Notes')
    expect(dialog).toHaveTextContent(/full control/i)
    expect(dialog).toHaveTextContent(/screenshots/i)
    expect(dialog).not.toHaveTextContent(/Vision Model/i)
    expect(dialog).not.toHaveTextContent(/Text Model/i)
    expect(dialog).toHaveTextContent(/Esc/i)
    expect(dialog.textContent).not.toMatch(/cost|billing|quota|upgrade|plan limit/i)
  })

  it('shows a bounded decorative PNG app icon supplied by the native helper', () => {
    const { container } = render(
      <I18nProvider language="en-US">
        <ComputerUseConsentDialog
          request={{ ...request, appIconBase64: 'iVBORw0KGgoAAA==' }}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )

    const icon = container.querySelector('.computer-use-app-icon')
    expect(icon).toHaveAttribute('alt', '')
    expect(icon).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgoAAA==',
    )
  })

  it('requires the explicit Deny or Allow for this session actions', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseConsentDialog request={request} onApprove={onApprove} onDeny={onDeny} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /^allow for this session$/i }))
    expect(onApprove).toHaveBeenCalledOnce()
    expect(onDeny).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }))
    expect(onDeny).toHaveBeenCalledOnce()
  })

  it('allows the user to grant a narrower tier than the app maximum', () => {
    const onApprove = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseConsentDialog request={request} onApprove={onApprove} onDeny={() => {}} />
      </I18nProvider>,
    )

    expect(screen.getByText('Maximum for this app: Full control')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /control level/i }), {
      target: { value: 'view_only' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^allow for this session$/i }))

    expect(onApprove).toHaveBeenCalledWith('view_only')
  })

  it('never offers a tier broader than the app maximum', () => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseConsentDialog
          request={{ ...request, requestedTier: 'click_only' }}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )

    const options = screen.getAllByRole('option').map(option => option.textContent)
    expect(options).toEqual(['View only', 'Click only'])
    expect(options).not.toContain('Full control')
  })

  it('focuses the safe action, traps focus, and treats Escape as denial', () => {
    const onDeny = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseConsentDialog request={request} onApprove={() => {}} onDeny={onDeny} />
      </I18nProvider>,
    )

    const denyButton = screen.getByRole('button', { name: /^deny$/i })
    const allowButton = screen.getByRole('button', { name: /^allow for this session$/i })
    const tierSelect = screen.getByRole('combobox', { name: /control level/i })
    expect(denyButton).toHaveFocus()

    tierSelect.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(allowButton).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(tierSelect).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDeny).toHaveBeenCalledOnce()
  })

  it('restores focus to the previously focused control when it closes', () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Open Computer Use'
    document.body.append(trigger)
    trigger.focus()

    const { unmount } = render(
      <I18nProvider language="en-US">
        <ComputerUseConsentDialog request={request} onApprove={() => {}} onDeny={() => {}} />
      </I18nProvider>,
    )
    expect(trigger).not.toHaveFocus()

    unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it('warns that developer tools with click-only access cannot receive typed commands', () => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseConsentDialog
          request={{ ...request, appName: 'Terminal', requestedTier: 'click_only' }}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Developer tools are click-only: Verboo can click controls, but cannot type commands or text.',
    )
  })

  it('states that clipboard access is not authorized and requires a separate prompt', () => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseConsentDialog request={request} onApprove={() => {}} onDeny={() => {}} />
      </I18nProvider>,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Clipboard: not authorized; copy/paste asks separately',
    )
  })

  it.each([
    ['com.apple.finder', 'Finder can reach files and folders available to your account.'],
    ['com.apple.systempreferences', 'System Settings can change system configuration, privacy, and security permissions.'],
  ])('explains the specific reach of sentinel app %s', (appBundleId, warning) => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseConsentDialog
          request={{ ...request, appBundleId, sentinelConfirmationRequired: true }}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent(warning)
  })

  it.each([
    [0, 'No other apps will be hidden.'],
    [1, '1 other visible app will be hidden during control and restored afterward.'],
    [3, '3 other visible apps will be hidden during control and restored afterward.'],
  ])('discloses the number of apps hidden during isolation (%i)', (hiddenAppCount, disclosure) => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseConsentDialog
          request={{ ...request, hiddenAppCount }}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent(disclosure)
  })

  it('localizes the hidden-app disclosure in Portuguese', () => {
    render(
      <I18nProvider language="pt-BR">
        <ComputerUseConsentDialog
          request={{ ...request, hiddenAppCount: 3 }}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent(
      '3 outros apps visíveis serão ocultados durante o controle e restaurados ao terminar.',
    )
  })
})
