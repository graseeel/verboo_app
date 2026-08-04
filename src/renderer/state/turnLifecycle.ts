export type TurnLifecycleState = {
  /** One current turn per conversation; different conversations may run together. */
  runningTurnByConversation: Record<string, string>
}

export function startTurn(
  state: TurnLifecycleState,
  conversationId: string,
  turnId: string,
): TurnLifecycleState {
  return {
    runningTurnByConversation: {
      ...state.runningTurnByConversation,
      [conversationId]: turnId,
    },
  }
}

export function finishTurn(
  state: TurnLifecycleState,
  conversationId: string,
  turnId: string,
): TurnLifecycleState {
  if (state.runningTurnByConversation[conversationId] !== turnId) return state
  const next = { ...state.runningTurnByConversation }
  delete next[conversationId]
  return { runningTurnByConversation: next }
}

export function canStartQueuedConversation(state: TurnLifecycleState, conversationId: string): boolean {
  return state.runningTurnByConversation[conversationId] === undefined
}

export function findNextRunnableQueueIndex(
  queue: readonly { conversationId: string }[],
  runningConversationIds: ReadonlySet<string>,
): number {
  return queue.findIndex(item => !runningConversationIds.has(item.conversationId))
}

export function resolveEscapeConversation({
  activeConversationId,
  sideChatConversationId,
  focusedConversationId,
  focusedLane,
  lifecycle,
}: {
  activeConversationId?: string
  sideChatConversationId?: string
  focusedConversationId?: string
  focusedLane?: 'main' | 'side'
  lifecycle: TurnLifecycleState
}): string | undefined {
  if (focusedLane === 'main') {
    return focusedConversationId && lifecycle.runningTurnByConversation[focusedConversationId]
      ? focusedConversationId
      : undefined
  }

  if (focusedLane === 'side') {
    return focusedConversationId && lifecycle.runningTurnByConversation[focusedConversationId]
      ? focusedConversationId
      : undefined
  }

  if (focusedConversationId) {
    return lifecycle.runningTurnByConversation[focusedConversationId] ? focusedConversationId : undefined
  }

  if (activeConversationId && lifecycle.runningTurnByConversation[activeConversationId]) {
    return activeConversationId
  }

  if (sideChatConversationId && lifecycle.runningTurnByConversation[sideChatConversationId]) {
    return sideChatConversationId
  }

  return undefined
}
