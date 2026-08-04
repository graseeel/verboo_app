export type ConversationPrompt = {
  conversationId: string
}

/** Selects the prompt belonging to one visible conversation lane. */
export function promptForConversation<T extends ConversationPrompt>(
  prompts: readonly T[],
  conversationId: string | undefined,
): T | undefined {
  if (!conversationId) return undefined
  return prompts.find(prompt => prompt.conversationId === conversationId)
}
