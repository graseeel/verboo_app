import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComputerUseTurnCompleteEvent } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { StoppedToast } from './EmergencyStopOverlay'

afterEach(cleanup)

function renderStoppedToast(
  turnReason: ComputerUseTurnCompleteEvent['stoppedReason'],
  isEmergency = false,
) {
  render(
    <I18nProvider language="en-US">
      <StoppedToast
        actionCount={2}
        durationMs={3_000}
        isEmergency={isEmergency}
        turnReason={turnReason}
      />
    </I18nProvider>,
  )
  return screen.getByRole('status')
}

describe('StoppedToast', () => {
  it('renders completed control as a successful return', () => {
    const toast = renderStoppedToast('completed')

    expect(toast).not.toHaveClass('is-error')
    expect(toast).toHaveTextContent('Control returned to you')
  })

  it.each([
    'cancelled',
    'emergency_stop',
    'os_permission_revoked',
    'settings_revoked',
    'stopped',
  ] as const)('does not mislabel the controlled stop %s as an executor failure', turnReason => {
    const toast = renderStoppedToast(turnReason, turnReason === 'emergency_stop')

    expect(toast).not.toHaveClass('is-error')
    expect(toast).not.toHaveTextContent('The visual executor stopped before completing the task.')
  })

  it.each([
    'spawn_error',
    'stdout_unavailable',
    'executor_error',
    'app_approval_failed',
    'cleanup_error',
  ] as const)('keeps the real failure %s in the error state', turnReason => {
    const toast = renderStoppedToast(turnReason)

    expect(toast).toHaveClass('is-error')
  })
})
