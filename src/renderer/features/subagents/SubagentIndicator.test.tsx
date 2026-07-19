import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubagentThread } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { SubagentIndicator } from './SubagentIndicator'

afterEach(cleanup)

const thread: SubagentThread = {
  id: 'thread-1',
  parentTurnId: 'turn-1',
  label: 'Scout',
  mission: 'Inspect',
  status: 'running',
  events: [],
  createdAt: 1,
  updatedAt: 1,
}

describe('SubagentIndicator', () => {
  it('stays compact and only opens from an explicit click', () => {
    const onOpen = vi.fn()
    render(<I18nProvider language="en-US"><SubagentIndicator threads={[thread]} open={false} onOpen={onOpen} /></I18nProvider>)

    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
