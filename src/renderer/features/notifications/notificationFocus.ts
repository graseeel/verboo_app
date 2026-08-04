import type { StoredConversation } from '../../../shared/types'

type ConversationReference = Pick<StoredConversation, 'id' | 'archivedAt'>

export type MainNavigationState = {
  activeConversationId?: string
  selectedProjectId?: string
  activeView: string
}

/**
 * Only persisted, visible conversations can be focused from a notification.
 * Ephemeral side-chat IDs are intentionally absent from ChatStore; accepting
 * one here would make the main transcript resolve to the empty-chat state.
 */
export function findNotifiableConversationId(
  conversations: readonly ConversationReference[],
  conversationId: string,
): string | undefined {
  const conversation = conversations.find(item => item.id === conversationId && !item.archivedAt)
  return conversation?.id
}

/**
 * Applies the same decision as the App notification listener to a navigation
 * snapshot. Unknown/ephemeral IDs are a no-op, preserving every main-screen
 * field, including the selected project and current view.
 */
export function applyNotificationFocus(
  state: MainNavigationState,
  conversationId: string,
  conversations: readonly ConversationReference[],
): MainNavigationState {
  const target = findNotifiableConversationId(conversations, conversationId)
  if (!target) return state
  return { ...state, activeConversationId: target, activeView: 'chat' }
}
