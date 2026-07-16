import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUseSession } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { ControlBanner } from './ControlBanner'

const session: ComputerUseSession = {
  id: 'session-1',
  status: 'active',
  goal: 'Write in Notes',
  appName: 'Notes',
  appBundleId: 'com.apple.Notes',
  approvedApps: [{
    bundleId: 'com.apple.Notes',
    displayName: 'Notes',
    tier: 'full_control',
    sentinelConfirmed: false,
  }],
  scope: 'full',
  isSelfTest: false,
  startedAt: Date.now(),
  actionCount: 0,
  originalModel: { id: 'text', displayName: 'Text Model' },
  executorModel: { id: 'vision', displayName: 'Vision Model' },
  temporaryExecutor: true,
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ControlBanner', () => {
  it('shows the approved app, active visual executor, restoration model, and plain Esc stop', () => {
    const onManageApps = vi.fn()
    render(
      <I18nProvider language="en-US">
        <ControlBanner
          session={session}
          onPause={() => {}}
          onResume={() => {}}
          onCancel={() => {}}
          onManageApps={onManageApps}
        />
      </I18nProvider>,
    )

    const banner = screen.getByRole('region', { name: /verboo is controlling your computer/i })
    expect(banner).toHaveTextContent('Notes')
    expect(banner).toHaveTextContent('Vision Model')
    expect(banner).toHaveTextContent('Text Model')
    expect(screen.getByText(/Visual executor:/i)).toHaveClass('control-banner-executor')
    expect(banner).toHaveTextContent(/Esc/)
    expect(banner.textContent).not.toContain('⌘⇧Esc')
    fireEvent.click(screen.getByRole('button', { name: /manage apps/i }))
    expect(onManageApps).toHaveBeenCalledOnce()
  })

  it('keeps explicit accessible names when compact CSS hides button text', () => {
    const { rerender } = render(
      <I18nProvider language="en-US">
        <ControlBanner
          session={session}
          onPause={() => {}}
          onResume={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveAttribute('aria-label', 'Pause')

    rerender(
      <I18nProvider language="en-US">
        <ControlBanner
          session={{ ...session, status: 'paused' }}
          onPause={() => {}}
          onResume={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: 'Resume' })).toHaveAttribute('aria-label', 'Resume')
  })

  it('labels a verified event as the last completed action', () => {
    render(
      <I18nProvider language="en-US">
        <ControlBanner
          session={{
            ...session,
            actionCount: 1,
            lastAction: {
              sessionId: session.id,
              verb: 'click',
              targetLabel: 'approved pointer target',
              appName: 'Notes',
              elapsedMs: 100,
              actionIndex: 0,
            },
          }}
          onPause={() => {}}
          onResume={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('region')).toHaveTextContent('Last action: clicked in Notes')
    expect(screen.getByRole('region')).not.toHaveTextContent('clicking')
  })

  it('shows the current action before falling back to the last verified action', () => {
    render(
      <I18nProvider language="en-US">
        <ControlBanner
          session={{
            ...session,
            currentAction: {
              sessionId: session.id,
              actionId: 'tool-use-1',
              verb: 'type',
              targetLabel: 'approved text field',
              appName: 'Notes',
              elapsedMs: 100,
            },
          }}
          onPause={() => {}}
          onResume={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Current action: typing in Notes')
  })

  it('labels pointer movement without calling it a click', () => {
    render(
      <I18nProvider language="en-US">
        <ControlBanner
          session={{
            ...session,
            currentAction: {
              sessionId: session.id,
              actionId: 'tool-use-move',
              verb: 'move',
              targetLabel: 'approved pointer target',
              appName: 'Notes',
              elapsedMs: 100,
            },
          }}
          onPause={() => {}}
          onResume={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Current action: moving the pointer in Notes')
    expect(screen.getByRole('status')).not.toHaveTextContent('clicking')
  })

  it('keeps the once-per-second timer outside live announcements', () => {
    vi.useFakeTimers()
    render(
      <I18nProvider language="en-US">
        <ControlBanner
          session={{ ...session, startedAt: Date.now() }}
          onPause={() => {}}
          onResume={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    )

    const banner = screen.getByRole('region')
    const timer = screen.getByText(/0s elapsed/)
    expect(banner).not.toHaveAttribute('aria-live')
    expect(timer.closest('[aria-live]')).toBeNull()

    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText(/1s elapsed/)).toBeInTheDocument()
    expect(screen.getByRole('status')).not.toHaveTextContent(/elapsed/i)
  })
})
