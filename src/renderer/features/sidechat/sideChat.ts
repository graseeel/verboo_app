import type { AgentTurnRequest, Annotation, StoredConversation } from '../../../shared/types'
import { applyAnnotations } from '../annotations/annotationRequest'

export const SIDE_CHAT_SKIP_CLOSE_CONFIRMATION_STORAGE_KEY = 'verboo:side-chat-skip-close-confirmation'

export type SideChatState = {
  conversation: StoredConversation
  context: Annotation
  /** Main conversation and workspace that owned the selected excerpt. */
  originConversationId?: string
  originWorkingDirectory?: string
}

/**
 * Creates the one conversation owned by the side-chat panel.
 * It is deliberately not a ChatStore entry: the caller keeps this state in
 * memory, so the normal sidebar and persistence pipeline never see it.
 */
export function createSideChatState(
  context: Annotation,
  id = `sidechat:${crypto.randomUUID()}`,
  now = Date.now(),
  originConversationId?: string,
  originWorkingDirectory?: string,
): SideChatState {
  return {
    conversation: {
      id,
      title: '',
      items: [],
      subagents: [],
      createdAt: now,
      updatedAt: now,
      lastTurnEndedAt: now,
    },
    context: { ...context },
    originConversationId,
    originWorkingDirectory,
  }
}

/** A side chat belongs to the conversation its excerpt came from. */
export function shouldDiscardSideChatForNavigation(
  state: SideChatState | undefined,
  nextConversationId: string | undefined,
  nextWorkingDirectory?: string,
): boolean {
  return Boolean(
    state
    && (
      state.originConversationId !== nextConversationId
      || (nextWorkingDirectory !== undefined && state.originWorkingDirectory !== nextWorkingDirectory)
    ),
  )
}

export function resolveSideChatWorkingDirectory(
  state: SideChatState | undefined,
  conversationId: string,
  fallback: string,
): string {
  if (state?.conversation.id === conversationId && state.originWorkingDirectory) {
    return state.originWorkingDirectory
  }
  return fallback
}

/** The selected excerpt is prompt context, not a second user message. */
export function buildSideChatRequest<R extends AgentTurnRequest>(
  request: R,
  context: Annotation,
): R {
  return applyAnnotations(request, [context])
}

export function updateSideChatState(
  state: SideChatState | undefined,
  conversationId: string,
  updater: (conversation: StoredConversation) => StoredConversation,
): SideChatState | undefined {
  if (!state || state.conversation.id !== conversationId) return state
  return { ...state, conversation: updater(state.conversation) }
}

export function resolveSideChatSessionId(
  state: SideChatState | undefined,
  conversationId: string,
  persistedSessionId?: string,
): string | undefined {
  if (state?.conversation.id === conversationId) return state.conversation.cliSessionId
  return persistedSessionId
}
