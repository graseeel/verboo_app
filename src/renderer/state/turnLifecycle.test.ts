import { describe, expect, it } from 'vitest'
import {
  canStartQueuedConversation,
  finishTurn,
  findNextRunnableQueueIndex,
  resolveEscapeConversation,
  startTurn,
  type TurnLifecycleState,
} from './turnLifecycle'

function state(): TurnLifecycleState {
  return { runningTurnByConversation: {} }
}

describe('turn lifecycle — independent conversations', () => {
  it('keeps the main conversation busy when a shorter side turn finishes first', () => {
    let lifecycle = startTurn(state(), 'main', 'turn-main')
    lifecycle = startTurn(lifecycle, 'sidechat:1', 'turn-side')
    lifecycle = finishTurn(lifecycle, 'sidechat:1', 'turn-side')

    expect(canStartQueuedConversation(lifecycle, 'main')).toBe(false)
    expect(canStartQueuedConversation(lifecycle, 'sidechat:1')).toBe(true)

    lifecycle = finishTurn(lifecycle, 'main', 'turn-main')
    expect(canStartQueuedConversation(lifecycle, 'main')).toBe(true)
  })

  it('does not let a stale terminal event clear a newer turn in the same conversation', () => {
    let lifecycle = startTurn(state(), 'main', 'turn-old')
    lifecycle = startTurn(lifecycle, 'main', 'turn-new')

    lifecycle = finishTurn(lifecycle, 'main', 'turn-old')

    expect(canStartQueuedConversation(lifecycle, 'main')).toBe(false)
  })

  it('targets Escape at the conversation whose lane has focus', () => {
    const lifecycle = startTurn(startTurn(state(), 'main', 'turn-main'), 'sidechat:1', 'turn-side')

    expect(resolveEscapeConversation({
      activeConversationId: 'main',
      sideChatConversationId: 'sidechat:1',
      focusedConversationId: 'sidechat:1',
      focusedLane: 'side',
      lifecycle,
    })).toBe('sidechat:1')

    expect(resolveEscapeConversation({
      activeConversationId: 'main',
      sideChatConversationId: 'sidechat:1',
      focusedConversationId: 'main',
      focusedLane: 'main',
      lifecycle,
    })).toBe('main')

    expect(resolveEscapeConversation({
      activeConversationId: undefined,
      sideChatConversationId: 'sidechat:1',
      focusedConversationId: undefined,
      focusedLane: 'main',
      lifecycle,
    })).toBeUndefined()
  })

  it('skips a queued main message while another main turn is still running', () => {
    const queue = [
      { conversationId: 'main' },
      { conversationId: 'sidechat:1' },
    ]
    expect(findNextRunnableQueueIndex(queue, new Set(['main']))).toBe(1)
  })
})
