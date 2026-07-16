import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUseSession } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { ComputerUseCompactHeader } from './ComputerUseCompactHeader'

const session: ComputerUseSession = {
  id: 'session-1',
  status: 'active',
  conversationId: 'conversation-1',
  goal: 'Write in Notes',
  appName: 'Notes',
  appBundleId: 'com.apple.Notes',
  scope: 'full',
  isSelfTest: false,
  startedAt: 1,
  actionCount: 0,
  currentAction: {
    sessionId: 'session-1',
    actionId: 'action-1',
    verb: 'click',
    targetLabel: 'Save',
    appName: 'Notes',
    elapsedMs: 10,
  },
}

afterEach(cleanup)

describe('ComputerUseCompactHeader', () => {
  it('names the target and exposes compact management, pause, and stop controls', () => {
    const onPause = vi.fn()
    const onStop = vi.fn()
    const onManageApps = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseCompactHeader
          session={session}
          onPause={onPause}
          onResume={() => {}}
          onStop={onStop}
          onManageApps={onManageApps}
        />
      </I18nProvider>,
    )

    const header = screen.getByRole('banner')
    expect(header).toHaveTextContent('Verboo is using Notes')
    expect(header).toHaveTextContent(/clicking in Notes/i)
    expect(header).toHaveTextContent('Esc')

    fireEvent.click(screen.getByRole('button', { name: /manage apps/i }))
    fireEvent.click(screen.getByRole('button', { name: /^pause$/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop computer use/i }))
    expect(onManageApps).toHaveBeenCalledOnce()
    expect(onPause).toHaveBeenCalledOnce()
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('shows the paused state and resumes from the same header', () => {
    const onResume = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ComputerUseCompactHeader
          session={{ ...session, status: 'paused', currentAction: undefined }}
          onPause={() => {}}
          onResume={onResume}
          onStop={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('banner')).toHaveTextContent('Verboo is paused in Notes')
    fireEvent.click(screen.getByRole('button', { name: /^resume$/i }))
    expect(onResume).toHaveBeenCalledOnce()
  })
})
