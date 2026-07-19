import { describe, it, expect } from 'vitest'
import {
  CHAT_STORE_KEY,
  visibleConversations,
  createConversation,
  readChatStore,
  sanitizeConversation,
} from './chatStore'
import type { ChatStore, StoredConversation } from '../../shared/types'

/**
 * Regression tests for stable sidebar ordering.
 *
 * Bug history: the sidebar was sorted by `updatedAt`, which is bumped on every
 * streaming token / tool call / appended item. With 2+ chats running in
 * parallel, their `updatedAt` raced and the sidebar kept reshuffling. The fix
 * introduces a separate `lastTurnEndedAt` field that is only bumped when a
 * turn concludes (result / error events), so streaming activity no longer
 * disturbs the visible order.
 */

function conversation(overrides: Partial<StoredConversation>): StoredConversation {
  const base = createConversation()
  return { ...base, ...overrides }
}

function storeWith(conversations: StoredConversation[]): ChatStore {
  return { version: 3, projects: [], conversations }
}

describe('visibleConversations — stable sidebar order', () => {
  it('does NOT reshuffle when only `updatedAt` changes (streaming tokens)', () => {
    const a = conversation({ id: 'chat:a', title: 'A', updatedAt: 1_000, lastTurnEndedAt: 1_000 })
    const b = conversation({ id: 'chat:b', title: 'B', updatedAt: 2_000, lastTurnEndedAt: 2_000 })
    const store = storeWith([a, b])

    const before = visibleConversations(store).map(c => c.id)
    expect(before).toEqual(['chat:b', 'chat:a']) // newer first

    // Simulate streaming: both chats receive token deltas — updatedAt changes
    // radically but lastTurnEndedAt stays. Order must NOT reshuffle.
    const streaming = storeWith([
      { ...a, updatedAt: 9_500 },
      { ...b, updatedAt: 9_900 },
    ])
    const after = visibleConversations(streaming).map(c => c.id)
    expect(after).toEqual(before)
  })

  it('does NOT reshuffle when only one conversation changes `updatedAt`', () => {
    const a = conversation({ id: 'chat:a', title: 'A', updatedAt: 1_000, lastTurnEndedAt: 1_000 })
    const b = conversation({ id: 'chat:b', title: 'B', updatedAt: 2_000, lastTurnEndedAt: 2_000 })
    const c = conversation({ id: 'chat:c', title: 'C', updatedAt: 3_000, lastTurnEndedAt: 3_000 })

    // A streams (updatedAt skyrockets) but order stays because
    // lastTurnEndedAt didn't change.
    const streamed = storeWith([
      { ...a, updatedAt: 9_999 },
      b,
      c,
    ])
    expect(visibleConversations(streamed).map(c => c.id)).toEqual(['chat:c', 'chat:b', 'chat:a'])
  })

  it('reorders when `lastTurnEndedAt` advances (a new turn concludes)', () => {
    const a = conversation({ id: 'chat:a', title: 'A', updatedAt: 1_000, lastTurnEndedAt: 1_000 })
    const b = conversation({ id: 'chat:b', title: 'B', updatedAt: 2_000, lastTurnEndedAt: 2_000 })
    const store = storeWith([a, b])
    expect(visibleConversations(store).map(c => c.id)).toEqual(['chat:b', 'chat:a'])

    // A finishes a turn — lastTurnEndedAt advances past B's.
    const afterTurn = storeWith([
      { ...a, updatedAt: 3_000, lastTurnEndedAt: 3_000 },
      { ...b, updatedAt: 3_500, lastTurnEndedAt: 2_000 },
    ])
    expect(visibleConversations(afterTurn).map(c => c.id)).toEqual(['chat:a', 'chat:b'])
  })

  it('falls back to `updatedAt` when `lastTurnEndedAt` is undefined (legacy)', () => {
    // These are legacy conversations as they'd come from the store pre-migration
    // — lastTurnEndedAt is absent, and sanitizeConversation() hasn't set it yet.
    const a = conversation({ id: 'chat:legacy-a', title: 'Legacy A', updatedAt: 1_000 })
    const b = conversation({ id: 'chat:legacy-b', title: 'Legacy B', updatedAt: 5_000 })
    const c = conversation({ id: 'chat:legacy-c', title: 'Legacy C', updatedAt: 3_000 })
    // Remove lastTurnEndedAt explicitly to simulate true legacy data
    const legacyA: StoredConversation = { ...a } as StoredConversation
    delete (legacyA as { lastTurnEndedAt?: number }).lastTurnEndedAt
    const legacyB: StoredConversation = { ...b } as StoredConversation
    delete (legacyB as { lastTurnEndedAt?: number }).lastTurnEndedAt
    const legacyC: StoredConversation = { ...c } as StoredConversation
    delete (legacyC as { lastTurnEndedAt?: number }).lastTurnEndedAt

    const store = storeWith([legacyA, legacyB, legacyC])
    expect(visibleConversations(store).map(c => c.id)).toEqual([
      'chat:legacy-b',
      'chat:legacy-c',
      'chat:legacy-a',
    ])
  })

  it('places a brand-new conversation at the top', () => {
    const existing = conversation({
      id: 'chat:existing',
      title: 'Existing',
      createdAt: 1_000,
      updatedAt: 4_000,
      lastTurnEndedAt: 4_000,
    })
    const fresh = conversation({ id: 'chat:fresh', title: 'Fresh', createdAt: 5_000, updatedAt: 5_000 })
    // A new conversation should have lastTurnEndedAt set (= createdAt by default
    // from createConversation), so it sorts by creation time until a turn ends.
    const store = storeWith([existing, fresh])
    expect(visibleConversations(store).map(c => c.id)).toEqual(['chat:fresh', 'chat:existing'])
  })

  it('hides archived conversations from the visible list', () => {
    const a = conversation({ id: 'chat:a', title: 'A', updatedAt: 5_000, lastTurnEndedAt: 5_000 })
    const b = conversation({
      id: 'chat:b',
      title: 'B',
      updatedAt: 9_000,
      lastTurnEndedAt: 9_000,
      archivedAt: 9_500,
    })
    const store = storeWith([a, b])
    expect(visibleConversations(store).map(c => c.id)).toEqual(['chat:a'])
  })
})

describe('createConversation — new conversations', () => {
  it('sets `lastTurnEndedAt` equal to `createdAt` for new conversations', () => {
    const conv = createConversation()
    expect(conv.lastTurnEndedAt).toBe(conv.createdAt)
  })
})

describe('sanitizeConversation — legacy migration', () => {
  it('fills `lastTurnEndedAt` from `updatedAt` when the field is absent', () => {
    const legacy = conversation({ id: 'chat:x', updatedAt: 1_234 })
    delete (legacy as { lastTurnEndedAt?: number }).lastTurnEndedAt
    const sanitized = sanitizeConversation(legacy)
    expect(sanitized.lastTurnEndedAt).toBe(1_234)
  })

  it('preserves an existing `lastTurnEndedAt` value', () => {
    const conv = conversation({ id: 'chat:x', updatedAt: 5_000, lastTurnEndedAt: 4_500 })
    const sanitized = sanitizeConversation(conv)
    expect(sanitized.lastTurnEndedAt).toBe(4_500)
  })
})

describe('readChatStore — subagent persistence migration', () => {
  it.each([1, 2])('migrates a v%s store to v3 with empty subagent collections', version => {
    window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify({
      version,
      projects: [],
      conversations: [{
        ...createConversation(),
        subagents: undefined,
      }],
    }))

    const store = readChatStore()

    expect(store.version).toBe(3)
    expect(store.conversations[0].subagents).toEqual([])
  })
})
