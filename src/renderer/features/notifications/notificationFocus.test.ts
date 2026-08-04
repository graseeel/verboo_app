import { describe, expect, it } from 'vitest'

import type { AgentEvent, StoredConversation } from '../../../shared/types'
import { applyNotificationFocus, type MainNavigationState } from './notificationFocus'

const mainConversation: Pick<StoredConversation, 'id' | 'archivedAt'> = {
  id: 'main-conversation',
  archivedAt: undefined,
}

const sideDoneEvent: AgentEvent = {
  type: 'done',
  turnId: 'turn-sidechat',
  conversationId: 'sidechat:ephemeral',
  exitCode: 0,
}

const initialNavigation: MainNavigationState = {
  activeConversationId: 'main-conversation',
  selectedProjectId: 'project-y',
  activeView: 'chat',
}

describe('notification focus navigation', () => {
  it('ignores the side-chat completion event and preserves main navigation state', () => {
    expect(sideDoneEvent.type).toBe('done')
    const next = applyNotificationFocus(
      initialNavigation,
      sideDoneEvent.conversationId!,
      [mainConversation],
    )

    expect(next).toEqual(initialNavigation)
  })

  it('still focuses a persisted conversation from a real notification event', () => {
    const event: AgentEvent = {
      type: 'done',
      turnId: 'turn-main',
      conversationId: 'other-conversation',
      exitCode: 0,
    }
    const next = applyNotificationFocus(
      initialNavigation,
      event.conversationId!,
      [mainConversation, { id: 'other-conversation', archivedAt: undefined }],
    )

    expect(next).toEqual({
      ...initialNavigation,
      activeConversationId: 'other-conversation',
    })
  })
})
