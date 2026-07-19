import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubagentThread } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { SubagentThreadPanel } from './SubagentThreadPanel'

afterEach(cleanup)

const thread: SubagentThread = {
  id: 'thread-1',
  parentTurnId: 'turn-1',
  label: 'Scout',
  mission: 'Inspect',
  status: 'completed',
  events: [
    { id: 'mission', kind: 'mission', text: 'Inspect', timestamp: 1 },
    { id: 'tool', kind: 'tool-call', text: '/tmp/app.ts', toolName: 'Read', timestamp: 2 },
    { id: 'final', kind: 'final', text: '# Result\n\n- Safe', timestamp: 3 },
  ],
  createdAt: 1,
  updatedAt: 3,
}

describe('SubagentThreadPanel', () => {
  it('renders agent responses as markdown without execution controls', () => {
    render(
      <I18nProvider language="en-US">
        <SubagentThreadPanel threads={[thread]} selectedId={thread.id} onSelect={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    )

    expect(screen.getByRole('heading', { name: 'Result' })).toBeInTheDocument()
    expect(screen.getByText('Safe')).toBeInTheDocument()
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument()
  })
})
