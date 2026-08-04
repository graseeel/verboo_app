import { afterEach, describe, expect, it } from 'vitest'

import type { AgentTurnRequest, Annotation } from '../../../shared/types'
import { emptyChatStore, persistChatStore, readChatStore, visibleConversations } from '../../state/chatStore'
import { buildSideChatRequest, createSideChatState, resolveSideChatSessionId, resolveSideChatWorkingDirectory, shouldDiscardSideChatForNavigation } from './sideChat'

function selectedText(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'annotation-sidechat-1',
    segmentId: 'turn-main:text:0',
    quote: 'the selected answer excerpt',
    prefix: 'Before ',
    suffix: ' after',
    occurrenceIndex: 0,
    comment: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function baseRequest(conversationId: string): AgentTurnRequest {
  return {
    conversationId,
    message: 'Explain this excerpt',
    accessMode: 'approval',
    workingDirectory: '/tmp/project',
    skills: [],
  }
}

afterEach(() => window.localStorage.clear())

describe('side chat state', () => {
  it('stays outside the sidebar store and does not return after state reload', () => {
    const mainStore = emptyChatStore()
    const sideChat = createSideChatState(selectedText(), 'sidechat:test-1', 1_700_000_000_001)

    expect(sideChat.conversation.id).toBe('sidechat:test-1')
    expect(visibleConversations(mainStore).some(item => item.id === sideChat.conversation.id)).toBe(false)

    persistChatStore(mainStore)
    const reloaded = readChatStore()
    expect(reloaded.conversations.some(item => item.id === sideChat.conversation.id)).toBe(false)
  })

  it('sends the exact selected quote as structured context in the side chat request', () => {
    const sideChat = createSideChatState(selectedText(), 'sidechat:test-2', 1_700_000_000_001)

    const request = buildSideChatRequest(
      baseRequest(sideChat.conversation.id),
      sideChat.context,
    )

    expect(request.conversationId).toBe('sidechat:test-2')
    expect(request.message).toBe('Explain this excerpt')
    expect(request.annotations).toStrictEqual([selectedText()])
  })

  it('never falls back to the main session for the side-chat conversation', () => {
    const sideChat = createSideChatState(selectedText(), 'sidechat:session', 1_700_000_000_001)

    expect(resolveSideChatSessionId(sideChat, sideChat.conversation.id, 'main-session')).toBeUndefined()

    const continued = {
      ...sideChat,
      conversation: { ...sideChat.conversation, cliSessionId: 'side-session' },
    }
    expect(resolveSideChatSessionId(continued, continued.conversation.id, 'main-session')).toBe('side-session')
  })

  it('closes when navigation leaves the source conversation or workspace', () => {
    const sideChat = createSideChatState(selectedText(), 'sidechat:origin', 1_700_000_000_001, 'main-a', '/project-a')

    expect(shouldDiscardSideChatForNavigation(sideChat, 'main-a', '/project-a')).toBe(false)
    expect(shouldDiscardSideChatForNavigation(sideChat, 'main-b', '/project-b')).toBe(true)
    expect(shouldDiscardSideChatForNavigation(sideChat, undefined, '/project-a')).toBe(true)
  })

  it('keeps the source workspace for a side request instead of the current project', () => {
    const sideChat = createSideChatState(selectedText(), 'sidechat:origin-dir', 1_700_000_000_001, 'main-a', '/project-a')

    expect(resolveSideChatWorkingDirectory(sideChat, sideChat.conversation.id, '/project-b')).toBe('/project-a')
    expect(resolveSideChatWorkingDirectory(undefined, sideChat.conversation.id, '/project-b')).toBe('/project-b')
  })
})
