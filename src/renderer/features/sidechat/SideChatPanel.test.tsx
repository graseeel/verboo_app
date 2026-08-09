import { createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../../i18n'
import type { Annotation, TranscriptItem } from '../../../shared/types'
import { createSideChatState } from './sideChat'
import { SideChatPanel } from './SideChatPanel'

const context: Annotation = {
  id: 'annotation-sidechat-panel',
  segmentId: 'turn-main:text:0',
  quote: 'The selected answer excerpt',
  prefix: '',
  suffix: '',
  occurrenceIndex: 0,
  comment: null,
  createdAt: 1_700_000_000_000,
}

describe('SideChatPanel', () => {
  it('shows the selected quote and sends the typed side-chat question', () => {
    const sideChat = createSideChatState(context, 'sidechat:panel', 1_700_000_000_001)
    const onSubmit = vi.fn()
    const onClose = vi.fn()

    render(
      <I18nProvider language="en-US">
        <SideChatPanel
          conversation={sideChat.conversation}
          context={sideChat.context}
          busy={false}
          onSubmit={onSubmit}
          onClose={onClose}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('complementary', { name: 'Side chat' })).toHaveTextContent('The selected answer excerpt')
    fireEvent.change(screen.getByRole('textbox', { name: 'Side-chat question' }), {
      target: { value: 'Can you clarify this?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send side-chat question' }))

    expect(onSubmit).toHaveBeenCalledWith('Can you clarify this?')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('sends on Enter and keeps Shift+Enter available for a newline', () => {
    const sideChat = createSideChatState(context, 'sidechat:keyboard', 1_700_000_000_001)
    const onSubmit = vi.fn()

    render(
      <I18nProvider language="en-US">
        <SideChatPanel
          conversation={sideChat.conversation}
          context={sideChat.context}
          busy={false}
          onSubmit={onSubmit}
          onClose={() => {}}
        />
      </I18nProvider>,
    )

    const input = screen.getByRole('textbox', { name: 'Side-chat question' })
    fireEvent.change(input, { target: { value: 'Send this' } })
    const enterEvent = createEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: false })
    fireEvent(input, enterEvent)
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(onSubmit).toHaveBeenCalledWith('Send this')

    fireEvent.change(input, { target: { value: 'Keep this' } })
    const shiftEnterEvent = createEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true })
    fireEvent(input, shiftEnterEvent)
    expect(shiftEnterEvent.defaultPrevented).toBe(false)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('blocks side-chat questions while the CLI is unavailable', () => {
    const sideChat = createSideChatState(context, 'sidechat:disabled', 1_700_000_000_001)
    const onSubmit = vi.fn()

    render(
      <I18nProvider language="en-US">
        <SideChatPanel
          conversation={sideChat.conversation}
          context={sideChat.context}
          busy={false}
          disabled
          onSubmit={onSubmit}
          onClose={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('textbox', { name: 'Side-chat question' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send side-chat question' })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('closes without changing the selected context', () => {
    const sideChat = createSideChatState(context, 'sidechat:panel-close', 1_700_000_000_001)
    const onClose = vi.fn()

    render(
      <I18nProvider language="en-US">
        <SideChatPanel
          conversation={sideChat.conversation}
          context={sideChat.context}
          busy={false}
          onSubmit={() => {}}
          onClose={onClose}
        />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close side chat' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByText('The selected answer excerpt')).toBeInTheDocument()
  })

  it('shows a system error instead of silently returning to idle', () => {
    const sideChat = createSideChatState(context, 'sidechat:error', 1_700_000_000_001)
    const errorConversation = {
      ...sideChat.conversation,
      items: [{
        id: 'sidechat:error:system',
        role: 'system' as const,
        text: 'The Chrome connection failed.',
        timestamp: 1_700_000_000_002,
      }],
    }

    render(
      <I18nProvider language="en-US">
        <SideChatPanel
          conversation={errorConversation}
          context={sideChat.context}
          busy={false}
          onSubmit={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('complementary', { name: 'Side chat' })).toHaveTextContent('The Chrome connection failed.')
  })

  it('shows an interruption summary while keeping the native diagnostic expandable', () => {
    const sideChat = createSideChatState(context, 'sidechat:interrupted', 1_700_000_000_001)
    const rawDiagnostic = '(signal, runtime=bundled-node, cwd=/project)'
    const interruptedConversation = {
      ...sideChat.conversation,
      items: [{
        id: 'sidechat:interrupted:error',
        role: 'system' as const,
        text: 'Turn interrupted by the user.',
        errorDetail: rawDiagnostic,
        timestamp: 1_700_000_000_002,
      }],
    }

    render(
      <I18nProvider language="en-US">
        <SideChatPanel
          conversation={interruptedConversation}
          context={sideChat.context}
          busy={false}
          onSubmit={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    )

    const panel = screen.getByRole('complementary', { name: 'Side chat' })
    expect(panel).toHaveTextContent('Turn interrupted by the user.')
    expect(within(panel).getByText('Show technical details')).toBeInTheDocument()
    fireEvent.click(within(panel).getByText('Show technical details'))
    expect(panel).toHaveTextContent(rawDiagnostic)
  })

  it('keeps text around browser activities in one assistant bubble', () => {
    const sideChat = createSideChatState(context, 'sidechat:tool-stream', 1_700_000_000_001)
    const streamedItems: TranscriptItem[] = [
      {
        id: 'turn-side:text:1',
        role: 'assistant',
        text: 'YouTube aberto. Agora vou buscar por Sab',
        timestamp: 1_700_000_000_002,
      },
      {
        id: 'turn-side:activity:2',
        role: 'tool',
        kind: 'activity',
        activityKind: 'browser',
        text: 'Navegou no Chrome',
        timestamp: 1_700_000_000_003,
      },
      {
        id: 'turn-side:text:2',
        role: 'assistant',
        text: 'ores. A busca foi enviada.',
        timestamp: 1_700_000_000_004,
      },
      {
        id: 'turn-side:activity:3',
        role: 'tool',
        kind: 'activity',
        activityKind: 'browser',
        text: 'Leu página no Chrome',
        timestamp: 1_700_000_000_005,
      },
      {
        id: 'turn-side:text:3',
        role: 'assistant',
        text: 'Encontrei os resultados e vou tocar “Espresso”.',
        timestamp: 1_700_000_000_006,
      },
    ]
    const errorConversation = {
      ...sideChat.conversation,
      items: streamedItems,
    }

    render(
      <I18nProvider language="pt-BR">
        <SideChatPanel
          conversation={errorConversation}
          context={sideChat.context}
          busy={false}
          onSubmit={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    )

    const panel = screen.getByRole('complementary', { name: 'Chat lateral' })
    const assistantBubbles = panel.querySelectorAll('.sidechat-message.assistant')
    expect(assistantBubbles).toHaveLength(1)
    expect(assistantBubbles[0]).toHaveTextContent('YouTube aberto. Agora vou buscar por Sabores. A busca foi enviada.')
    expect(assistantBubbles[0]).toHaveTextContent('Encontrei os resultados e vou tocar “Espresso”.')
  })
})
