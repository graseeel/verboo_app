import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AgentEvent, Annotation, StoredConversation, TranscriptItem } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { PermissionApprovalPanel } from '../permission/PermissionApprovalPanel'
import { QuestionWizard } from '../questions/QuestionWizard'
import { applyNotificationFocus, type MainNavigationState } from '../notifications/notificationFocus'
import {
  SIDE_CHAT_SKIP_CLOSE_CONFIRMATION_STORAGE_KEY,
  createSideChatState,
  updateSideChatState,
  type SideChatState,
} from './sideChat'
import { SideChatSurface } from './SideChatSurface'

const context: Annotation = {
  id: 'annotation-sidechat-screen',
  segmentId: 'turn-main:text:0',
  quote: 'The selected answer excerpt',
  prefix: '',
  suffix: '',
  occurrenceIndex: 0,
  comment: null,
  createdAt: 1_700_000_000_000,
}

const mainConversation: Pick<StoredConversation, 'id' | 'archivedAt'> = {
  id: 'main-conversation',
  archivedAt: undefined,
}
const sideConversationId = 'sidechat:screen'
const sideTurnEvents: AgentEvent[] = [
  { type: 'started', turnId: 'turn-sidechat-screen', conversationId: sideConversationId },
  {
    type: 'result',
    turnId: 'turn-sidechat-screen',
    conversationId: sideConversationId,
    result: { turnId: 'turn-sidechat-screen', exitCode: 0 },
  },
  { type: 'done', turnId: 'turn-sidechat-screen', conversationId: sideConversationId, exitCode: 0 },
]

function appendMessage(state: SideChatState, item: TranscriptItem): SideChatState {
  return updateSideChatState(state, state.conversation.id, conversation => ({
    ...conversation,
    items: [...conversation.items, item],
  }))!
}

function renderScreen(language: 'en-US' | 'pt-BR' = 'en-US') {
  function ScreenHarness() {
    const [navigation, setNavigation] = useState<MainNavigationState>({
      activeConversationId: 'main-conversation',
      selectedProjectId: 'project-y',
      activeView: 'chat',
    })
    const [sideChat, setSideChat] = useState<SideChatState>()
    const [busy, setBusy] = useState(false)
    const [responseReady, setResponseReady] = useState(false)
    const [receivedEvents, setReceivedEvents] = useState<AgentEvent[]>([])

    function openSideChat() {
      setSideChat(createSideChatState(context, 'sidechat:screen', 1_700_000_000_001))
    }

    function send(message: string) {
      setSideChat(current => current && appendMessage(current, {
        id: 'sidechat:screen:user:1',
        role: 'user',
        text: message,
        timestamp: 1_700_000_000_002,
      }))
      setBusy(true)
      setResponseReady(true)
    }

    function completeTurn() {
      setReceivedEvents(sideTurnEvents)
      setSideChat(current => current && appendMessage(current, {
        id: 'sidechat:screen:assistant:1',
        role: 'assistant',
        text: 'The excerpt means this.',
        timestamp: 1_700_000_000_003,
      }))
      // Rust emits notification-clicked with this same conversation ID when
      // the desktop completion notification is shown. Feed that real event
      // through the production decision so a side turn cannot navigate main.
      const doneEvent = sideTurnEvents.at(-1)
      if (doneEvent?.type === 'done' && doneEvent.conversationId) {
        setNavigation(current => applyNotificationFocus(current, doneEvent.conversationId!, [mainConversation]))
      }
      setBusy(false)
      setResponseReady(false)
    }

    return (
      <I18nProvider language={language}>
        <main>
          <output data-testid="active-conversation">{navigation.activeConversationId}</output>
          <output data-testid="selected-project">{navigation.selectedProjectId}</output>
          <output data-testid="active-view">{navigation.activeView}</output>
          <output data-testid="received-events">{receivedEvents.map(event => event.type).join(',')}</output>
          <section data-testid="main-column">
            <div data-testid="main-transcript">Main conversation answer</div>
            <form aria-label="Main composer">
              <textarea aria-label="Main composer input" />
            </form>
          </section>
          <button type="button" onClick={openSideChat}>Open side chat</button>
          <SideChatSurface
            sideChat={sideChat}
            busy={busy}
            onSubmit={send}
            onClose={() => {}}
          />
          {responseReady && (
            <button type="button" onClick={completeTurn}>Deliver side-chat response</button>
          )}
        </main>
      </I18nProvider>
    )
  }

  return render(<ScreenHarness />)
}

function renderClosableScreen() {
  function ScreenHarness() {
    const [sideChat, setSideChat] = useState<SideChatState | undefined>(() => createSideChatState(context, 'sidechat:close', 1_700_000_000_001))

    return (
      <I18nProvider language="pt-BR">
        <main>
          <div data-testid="main-transcript">Main conversation answer</div>
          <SideChatSurface
            sideChat={sideChat}
            busy={false}
            onSubmit={() => {}}
            onClose={() => setSideChat(undefined)}
          />
        </main>
      </I18nProvider>
    )
  }

  return render(<ScreenHarness />)
}

beforeEach(() => {
  window.localStorage.removeItem(SIDE_CHAT_SKIP_CLOSE_CONFIRMATION_STORAGE_KEY)
})

describe('SideChatSurface screen wiring', () => {
  it('keeps a permission intervention inside the side-chat lane', () => {
    const sideChat = createSideChatState(context, 'sidechat:permission', 1_700_000_000_001)
    const prompt = {
      id: 'permission:sidechat:permission',
      turnId: 'turn-sidechat-permission',
      conversationId: sideChat.conversation.id,
      detail: 'The side chat needs approval.',
      autoApprove: false,
    }
    const questionPrompt = {
      conversationId: sideChat.conversation.id,
      turnId: 'turn-sidechat-question',
      questions: [{ question: 'Which detail should I explain?', options: [] }],
      answers: [{ selected: [], custom: '' }],
    }

    render(
      <I18nProvider language="en-US">
        <SideChatSurface
          sideChat={sideChat}
          busy={true}
          onSubmit={() => {}}
          onClose={() => {}}
          auxiliary={(
            <>
              <PermissionApprovalPanel
                prompt={prompt}
                onAllow={() => {}}
                onDeny={() => {}}
                onAlwaysAllow={() => {}}
              />
              <QuestionWizard
                prompt={questionPrompt}
                onAnswersChange={() => {}}
                onSubmit={() => {}}
                onDismiss={() => {}}
              />
            </>
          )}
        />
      </I18nProvider>,
    )

    const panel = screen.getByRole('complementary', { name: 'Side chat' })
    expect(within(panel).getByText('The side chat needs approval.')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    expect(within(panel).getByRole('dialog', { name: 'The model has questions' })).toBeInTheDocument()
  })

  it('keeps the main conversation and panel mounted when sending', () => {
    renderScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Open side chat' }))
    const input = screen.getByRole('textbox', { name: 'Side-chat question' })
    fireEvent.change(input, { target: { value: 'What does this mean?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send side-chat question' }))

    expect(screen.getByTestId('active-conversation')).toHaveTextContent('main-conversation')
    expect(screen.getByTestId('selected-project')).toHaveTextContent('project-y')
    expect(screen.getByTestId('active-view')).toHaveTextContent('chat')
    expect(screen.getByTestId('main-transcript')).toHaveTextContent('Main conversation answer')
    expect(screen.getByRole('complementary', { name: 'Side chat' })).toBeInTheDocument()
    expect(screen.getByTestId('sidechat-title')).toHaveTextContent('What does this mean?')
    expect(screen.getByRole('form', { name: 'Main composer' })).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Side-chat composer' })).toBeInTheDocument()
  })

  it('survives send, response and turn completion as one side-chat lifecycle', async () => {
    renderScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Open side chat' }))
    const input = screen.getByRole('textbox', { name: 'Side-chat question' })
    fireEvent.change(input, { target: { value: 'Explain the excerpt.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send side-chat question' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deliver side-chat response' }))

    await waitFor(() => expect(screen.getByText('The excerpt means this.')).toBeInTheDocument())
    expect(screen.getByTestId('received-events')).toHaveTextContent('started,result,done')
    expect(screen.getByTestId('active-conversation')).toHaveTextContent('main-conversation')
    expect(screen.getByTestId('selected-project')).toHaveTextContent('project-y')
    expect(screen.getByTestId('active-view')).toHaveTextContent('chat')
    expect(screen.getByRole('complementary', { name: 'Side chat' })).toBeInTheDocument()
  })

  it('shows both composers and changes the side-chat tab to the first message', () => {
    renderScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Open side chat' }))
    expect(screen.getByRole('form', { name: 'Main composer' })).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Side-chat composer' })).toBeInTheDocument()
    expect(screen.getByTestId('sidechat-title')).toHaveTextContent('Side chat')

    const input = screen.getByRole('textbox', { name: 'Side-chat question' })
    fireEvent.change(input, { target: { value: 'What does this mean?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send side-chat question' }))

    expect(screen.getByTestId('sidechat-title')).toHaveTextContent('What does this mean?')
  })

  it('cancels or confirms the exact Portuguese close dialog', () => {
    renderClosableScreen()

    const panel = screen.getByRole('complementary', { name: 'Chat lateral' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Fechar chat lateral' }))

    expect(screen.getByRole('dialog')).toHaveTextContent('Fechar chat lateral?')
    expect(screen.getByRole('dialog')).toHaveTextContent('Este chat lateral desaparecerá e não poderá ser recuperado. Tem certeza?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.getByRole('complementary', { name: 'Chat lateral' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(within(screen.getByRole('complementary', { name: 'Chat lateral' })).getByRole('button', { name: 'Fechar chat lateral' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fechar chat lateral' }))
    expect(screen.queryByRole('complementary', { name: 'Chat lateral' })).not.toBeInTheDocument()
  })

  it('persists “Não perguntar novamente” across a remount', () => {
    const first = renderClosableScreen()
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Chat lateral' })).getByRole('button', { name: 'Fechar chat lateral' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Não perguntar novamente' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fechar chat lateral' }))
    expect(window.localStorage.getItem(SIDE_CHAT_SKIP_CLOSE_CONFIRMATION_STORAGE_KEY)).toBe('1')
    first.unmount()

    renderClosableScreen()
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Chat lateral' })).getByRole('button', { name: 'Fechar chat lateral' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Chat lateral' })).not.toBeInTheDocument()
  })
})
