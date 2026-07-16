import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '../../i18n'
import { ComputerUseLiveActionRow } from './ComputerUseLiveActionRow'

afterEach(cleanup)

describe('ComputerUseLiveActionRow', () => {
  it('renders a non-persisted pending action with its app', () => {
    render(
      <I18nProvider language="en-US">
        <ComputerUseLiveActionRow
          status="active"
          appName="Notes"
          action={{
            sessionId: 'session-1',
            actionId: 'action-1',
            verb: 'type',
            targetLabel: 'Body',
            appName: 'Notes',
            elapsedMs: 10,
          }}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('status')).toHaveTextContent(/typing in Notes/i)
  })

  it('shows bounded working and paused states without inventing transcript entries', () => {
    const { rerender } = render(
      <I18nProvider language="en-US">
        <ComputerUseLiveActionRow status="active" appName="Notes" />
      </I18nProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Working on this…')

    rerender(
      <I18nProvider language="en-US">
        <ComputerUseLiveActionRow status="paused" appName="Notes" />
      </I18nProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Computer Use paused')
  })
})
