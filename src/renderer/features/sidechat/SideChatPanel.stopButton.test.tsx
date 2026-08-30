import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Annotation } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { createSideChatState } from './sideChat'
import { SideChatPanel } from './SideChatPanel'

const context: Annotation = {
  id: 'annotation-sidechat-stop',
  segmentId: 'turn-main:text:0',
  quote: 'The selected answer excerpt',
  prefix: '',
  suffix: '',
  occurrenceIndex: 0,
  comment: null,
  createdAt: 1_700_000_000_000,
}

type SideChatPanelProps = React.ComponentProps<typeof SideChatPanel>
type StopAwareSideChatPanelProps = SideChatPanelProps & { onStop?: () => void }

function renderPanel(overrides: Partial<StopAwareSideChatPanelProps> = {}, language: 'en-US' | 'pt-BR' = 'en-US') {
  const sideChat = createSideChatState(context, 'sidechat:stop', 1_700_000_000_001)
  const props: StopAwareSideChatPanelProps = {
    conversation: sideChat.conversation,
    context: sideChat.context,
    busy: false,
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }

  return {
    ...render(
      <I18nProvider language={language}>
        <SideChatPanel {...props} />
      </I18nProvider>,
    ),
    props,
  }
}

describe('SideChatPanel stop button', () => {
  it('replaces the disabled send control with an enabled stop action while busy', () => {
    const onStop = vi.fn()
    const onSubmit = vi.fn()
    renderPanel({ busy: true, onStop, onSubmit })

    const stopButton = screen.getByRole('button', { name: 'Stop' })
    expect(stopButton).toHaveAttribute('type', 'button')
    expect(stopButton).toHaveAttribute('title', 'Stop')
    expect(stopButton).not.toBeDisabled()
    expect(screen.getByTestId('sidechat-stop-icon')).toBeInTheDocument()

    fireEvent.click(stopButton)

    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps the regular send control while idle and localizes stop in Portuguese', () => {
    const { rerender } = renderPanel()

    const sendButton = screen.getByRole('button', { name: 'Send side-chat question' })
    expect(sendButton).toHaveAttribute('type', 'submit')
    expect(sendButton).toHaveAttribute('title', 'Send side-chat question')
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()

    const sideChat = createSideChatState(context, 'sidechat:stop-pt', 1_700_000_000_002)
    rerender(
      <I18nProvider language="pt-BR">
        <SideChatPanel
          conversation={sideChat.conversation}
          context={sideChat.context}
          busy
          onSubmit={() => {}}
          onStop={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('button', { name: 'Parar' })).toHaveAttribute('title', 'Parar')
  })

  it('falls back to the disabled send button when busy has no stop callback', () => {
    renderPanel({ busy: true })

    const sendButton = screen.getByRole('button', { name: 'Send side-chat question' })
    expect(sendButton).toHaveAttribute('type', 'submit')
    expect(sendButton).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })

  it('keeps the stop action enabled when other side-chat actions are blocked', () => {
    renderPanel({ busy: true, disabled: true, onStop: vi.fn() })

    expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled()
  })
})
