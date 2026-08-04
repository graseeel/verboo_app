import type { TranscriptItem } from '../../../shared/types'

/**
 * The main stream stores one assistant item for each text burst between
 * activities (`turnId:text:N`). The side chat does not render those activities
 * as rows, so it must reunite the text bursts from one turn into one bubble.
 */
export function groupSideChatMessages(items: readonly TranscriptItem[]): TranscriptItem[] {
  const messages: TranscriptItem[] = []
  const assistantByTurn = new Map<string, TranscriptItem>()

  for (const item of items) {
    if (
      (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system')
      || item.kind === 'summary'
      || item.text.trim().length === 0
    ) continue

    if (item.role !== 'assistant') {
      messages.push(item)
      continue
    }

    const turnKey = item.id.match(/^(.*):text:\d+$/)?.[1] ?? item.id
    const previous = assistantByTurn.get(turnKey)
    if (previous) {
      previous.text = mergeAssistantText(previous.text, item.text)
      previous.streaming = Boolean(previous.streaming || item.streaming)
      if (item.errorDetail) previous.errorDetail = item.errorDetail
      continue
    }

    const message = { ...item }
    messages.push(message)
    assistantByTurn.set(turnKey, message)
  }

  return messages
}

// Keep the same boundary behavior as App's streaming accumulator: a text
// burst may end in the middle of a word, or just before a new sentence.
function mergeAssistantText(current: string, incoming: string): string {
  if (!current || !incoming) return current + incoming
  const left = current.at(-1) ?? ''
  const right = incoming[0] ?? ''
  if (!left || !right || /\s/.test(left) || /\s/.test(right)) return current + incoming
  if (left === '`' || right === '`' || left === '/' || right === '/') return current + incoming
  if (/[.!?:;,)]/.test(left) && /[\p{L}\p{N}("'“]/u.test(right)) return `${current} ${incoming}`
  if (/[\p{Ll}\p{N})]/u.test(left) && /[\p{Lu}]/u.test(right)) return `${current} ${incoming}`
  return current + incoming
}
