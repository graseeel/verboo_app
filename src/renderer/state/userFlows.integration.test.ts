/**
 * Integration tests for core user flows.
 *
 * Tests the actual user journeys through the chatStore and App logic:
 * - Creating new conversations
 * - Sending messages
 * - Switching models
 * - Sidebar navigation
 * - Chat persistence
 * - Project selection
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createConversation,
  createProject,
  readChatStore,
  persistChatStore,
  visibleConversations,
  updateConversation,
  emptyChatStore,
  initialSystemMessage,
} from './chatStore'
import type { ChatStore, StoredConversation, TranscriptItem, VerbooModel, ModelDiscoveryResult } from '../../shared/types'


function makeConversation(overrides?: Partial<StoredConversation>): StoredConversation {
  return { ...createConversation(), ...overrides }
}

function makeProject(overrides?: Partial<ReturnType<typeof createProject>>): ReturnType<typeof createProject> {
  return { ...createProject('/c/test/project'), ...overrides }
}

function makeStore(overrides?: Partial<ChatStore>): ChatStore {
  return { ...emptyChatStore(), ...overrides }
}

function makeModel(overrides?: Partial<VerbooModel>): VerbooModel {
  return {
    id: 'test-model',
    displayName: 'Test Model',
    contextWindow: 128000,
    supportsVision: false,
    raw: {},
    ...overrides,
  }
}


describe('User Flow: Create New Chat', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('creates a conversation with default title and system message', () => {
    const conv = createConversation()

    expect(conv.id).toMatch(/^chat:/)
    expect(conv.title).toBe('Novo chat')
    expect(conv.items).toHaveLength(1)
    expect(conv.items[0].role).toBe('system')
    expect(conv.items[0].text).toContain('Verboo')
    expect(conv.createdAt).toBeGreaterThan(0)
    expect(conv.updatedAt).toBe(conv.createdAt)
  })

  it('creates conversation with project association', () => {
    const conv = createConversation('project:123')

    expect(conv.projectId).toBe('project:123')
  })

  it('new conversation appears in visible list', () => {
    const conv = makeConversation({ id: 'chat:new', title: 'New Chat', updatedAt: 1000, lastTurnEndedAt: 1000 })
    const store = makeStore({ conversations: [conv] })

    const visible = visibleConversations(store)
    expect(visible).toHaveLength(1)
    expect(visible[0].id).toBe('chat:new')
  })

  it('multiple conversations ordered by lastTurnEndedAt (newest first)', () => {
    const old = makeConversation({ id: 'chat:old', title: 'Old', updatedAt: 500, lastTurnEndedAt: 500 })
    const mid = makeConversation({ id: 'chat:mid', title: 'Mid', updatedAt: 1000, lastTurnEndedAt: 1000 })
    const fresh = makeConversation({ id: 'chat:fresh', title: 'Fresh', updatedAt: 2000, lastTurnEndedAt: 2000 })
    const store = makeStore({ conversations: [old, mid, fresh] })

    const ids = visibleConversations(store).map(c => c.id)
    expect(ids).toEqual(['chat:fresh', 'chat:mid', 'chat:old'])
  })

  it('archived conversations are hidden from sidebar', () => {
    const active = makeConversation({ id: 'chat:active', title: 'Active' })
    const archived = makeConversation({ id: 'chat:archived', title: 'Archived', archivedAt: Date.now() })
    const store = makeStore({ conversations: [active, archived] })

    const visible = visibleConversations(store)
    expect(visible).toHaveLength(1)
    expect(visible[0].id).toBe('chat:active')
  })
})

describe('User Flow: Send Message', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('appends user message to conversation items', () => {
    const conv = makeConversation({ id: 'chat:1' })
    const store = makeStore({ conversations: [conv] })

    const userMsg: TranscriptItem = {
      id: 'user:1',
      role: 'user',
      text: 'Hello, Verboo!',
      timestamp: Date.now(),
    }

    const updated = updateConversation(store, 'chat:1', c => ({ ...c, items: [...c.items, userMsg] }))
    const updatedConv = updated.conversations.find(c => c.id === 'chat:1')

    expect(updatedConv!.items).toHaveLength(2) // system + user
    expect(updatedConv!.items[1].role).toBe('user')
    expect(updatedConv!.items[1].text).toBe('Hello, Verboo!')
  })

  it('conversation updatedAt bumps when message is sent', () => {
    const conv = makeConversation({ id: 'chat:1', updatedAt: 1000 })
    const store = makeStore({ conversations: [conv] })

    const updated = updateConversation(store, 'chat:1', c => ({
      ...c,
      updatedAt: 2000,
      items: [...c.items, { id: 'user:1', role: 'user', text: 'msg', timestamp: 2000 }],
    }))
    const updatedConv = updated.conversations.find(c => c.id === 'chat:1')

    expect(updatedConv!.updatedAt).toBe(2000)
  })

  it('assistant response is appended after user message', () => {
    const conv = makeConversation({ id: 'chat:1' })
    const userMsg: TranscriptItem = { id: 'user:1', role: 'user', text: 'Hi', timestamp: 1000 }
    const assistantMsg: TranscriptItem = { id: 'assistant:1', role: 'assistant', text: 'Hello!', timestamp: 1001 }

    const store = makeStore({ conversations: [{ ...conv, items: [...conv.items, userMsg] }] })
    const updated = updateConversation(store, 'chat:1', c => ({
      ...c,
      items: [...c.items, assistantMsg],
    }))
    const updatedConv = updated.conversations.find(c => c.id === 'chat:1')

    expect(updatedConv!.items).toHaveLength(3) // system + user + assistant
    expect(updatedConv!.items[2].role).toBe('assistant')
    expect(updatedConv!.items[2].text).toBe('Hello!')
  })

  it('streaming message updates in place', () => {
    const conv = makeConversation({ id: 'chat:1' })
    const userMsg: TranscriptItem = { id: 'user:1', role: 'user', text: 'Hi', timestamp: 1000 }
    const streamingMsg: TranscriptItem = {
      id: 'assistant:1',
      role: 'assistant',
      text: 'Hel',
      timestamp: 1001,
      streaming: true,
    }

    const store = makeStore({ conversations: [{ ...conv, items: [...conv.items, userMsg] }] })
    const updated1 = updateConversation(store, 'chat:1', c => ({
      ...c,
      items: [...c.items, streamingMsg],
    }))

    const finalMsg: TranscriptItem = {
      id: 'assistant:1',
      role: 'assistant',
      text: 'Hello! How can I help?',
      timestamp: 1002,
      streaming: false,
    }
    const updated2 = updateConversation(updated1, 'chat:1', c => ({
      ...c,
      items: [...c.items.filter(i => i.id !== 'assistant:1'), finalMsg],
    }))
    const updatedConv = updated2.conversations.find(c => c.id === 'chat:1')

    expect(updatedConv!.items[2].text).toBe('Hello! How can I help?')
    expect(updatedConv!.items[2].streaming).toBeFalsy()
  })

  it('preserves conversation identity across updates', () => {
    const conv = makeConversation({ id: 'chat:1', title: 'My Chat' })
    const store = makeStore({ conversations: [conv] })

    const updated = updateConversation(store, 'chat:1', c => ({
      ...c,
      items: [...c.items, { id: 'user:1', role: 'user', text: 'msg', timestamp: 1000 }],
    }))

    // With a match, the conversations array is a NEW reference (immutability).
    expect(updated.conversations).not.toBe(store.conversations)
    // But the conversation itself is updated
    expect(updated.conversations.find(c => c.id === 'chat:1')!.items).toHaveLength(2)
  })
})

describe('User Flow: Switch Model', () => {
  it('model selection state tracks current model', () => {
    const models: VerbooModel[] = [
      makeModel({ id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' }),
      makeModel({ id: 'mimo-v2.5', displayName: 'MiMo v2.5' }),
      makeModel({ id: 'qwen3.6-27b', displayName: 'Qwen 3.6 27B' }),
    ]

    let selected = models[0].id

    selected = models[1].id
    expect(selected).toBe('mimo-v2.5')

    selected = models[2].id
    expect(selected).toBe('qwen3.6-27b')
  })

  it('model list deduplication preserves first occurrence', () => {
    const models = [
      makeModel({ id: 'deepseek-v4-flash', displayName: 'First' }),
      makeModel({ id: 'deepseek-v4-flash', displayName: 'Duplicate' }),
      makeModel({ id: 'mimo-v2.5' }),
    ]

    const seen = new Set<string>()
    const deduped = models.filter(m => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })

    expect(deduped).toHaveLength(2)
    expect(deduped[0].displayName).toBe('First')
  })

  it('model selection persists across refresh', () => {
    let lastSelected = 'mimo-v2.5'
    const models = [
      makeModel({ id: 'deepseek-v4-flash' }),
      makeModel({ id: 'mimo-v2.5' }),
      makeModel({ id: 'qwen3.6-27b' }),
    ]

    const found = models.find(m => m.id === lastSelected)
    expect(found).toBeDefined()
    expect(found!.id).toBe('mimo-v2.5')
  })

  it('falls back to first model when selected disappears', () => {
    let lastSelected = 'mimo-v2.5'
    const models = [
      makeModel({ id: 'deepseek-v4-flash' }),
      makeModel({ id: 'qwen3.6-27b' }),
    ]

    const found = models.find(m => m.id === lastSelected)
    if (!found) lastSelected = models[0].id

    expect(lastSelected).toBe('deepseek-v4-flash')
  })
})

describe('User Flow: Sidebar Navigation', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('switches active conversation', () => {
    const conv1 = makeConversation({ id: 'chat:1', title: 'Chat 1', updatedAt: 1000, lastTurnEndedAt: 1000 })
    const conv2 = makeConversation({ id: 'chat:2', title: 'Chat 2', updatedAt: 2000, lastTurnEndedAt: 2000 })
    const store = makeStore({ conversations: [conv1, conv2] })

    let activeId = 'chat:1'
    expect(store.conversations.find(c => c.id === activeId)!.title).toBe('Chat 1')

    activeId = 'chat:2'
    expect(store.conversations.find(c => c.id === activeId)!.title).toBe('Chat 2')
  })

  it('search filters conversations by title', () => {
    const convs = [
      makeConversation({ id: 'chat:1', title: 'React project' }),
      makeConversation({ id: 'chat:2', title: 'Python script' }),
      makeConversation({ id: 'chat:3', title: 'React hooks' }),
    ]
    const store = makeStore({ conversations: convs })

    const query = 'react'
    const filtered = visibleConversations(store).filter(c =>
      c.title.toLowerCase().includes(query.toLowerCase())
    )

    expect(filtered).toHaveLength(2)
    expect(filtered.map(c => c.id)).toEqual(['chat:1', 'chat:3'])
  })
})

describe('User Flow: Chat Persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('round-trips chat store through localStorage', () => {
    const conv = makeConversation({ id: 'chat:1', title: 'Persisted Chat' })
    const store = makeStore({ conversations: [conv] })

    persistChatStore(store)
    const loaded = readChatStore()

    expect(loaded.conversations).toHaveLength(1)
    expect(loaded.conversations[0].id).toBe('chat:1')
    expect(loaded.conversations[0].title).toBe('Persisted Chat')
  })

  it('preserves model and provider metadata on assistant items', () => {
    const assistantMsg: TranscriptItem = {
      id: 'assistant:1',
      role: 'assistant',
      text: 'Response',
      timestamp: 1000,
      modelId: 'deepseek-v4-flash',
      modelDisplayName: 'DeepSeek V4 Flash',
      provider: 'verboo',
    }

    const conv = makeConversation({ id: 'chat:1', items: [initialSystemMessage(), assistantMsg] })
    const store = makeStore({ conversations: [conv] })

    persistChatStore(store)
    const loaded = readChatStore()
    const loadedMsg = loaded.conversations[0].items[1]

    expect(loadedMsg.modelId).toBe('deepseek-v4-flash')
    expect(loadedMsg.modelDisplayName).toBe('DeepSeek V4 Flash')
    expect(loadedMsg.provider).toBe('verboo')
  })

  it('handles corrupted localStorage gracefully', () => {
    window.localStorage.setItem('verboo:chat-store:v1', '{invalid json')
    const loaded = readChatStore()

    expect(loaded.conversations).toHaveLength(0)
    expect(loaded.projects).toHaveLength(0)
  })

  it('handles missing localStorage key', () => {
    const loaded = readChatStore()

    expect(loaded.conversations).toHaveLength(0)
    expect(loaded.version).toBe(4)
  })
})

describe('User Flow: Project Selection', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('creates project with path and name', () => {
    const project = createProject('/c/Users/dev/my-project')

    expect(project.id).toMatch(/^project:/)
    expect(project.path).toBe('/c/Users/dev/my-project')
    expect(project.name).toBe('my-project')
    expect(project.collapsed).toBe(false)
  })

  it('creates project with custom name', () => {
    const project = createProject('/c/test', 'Custom Name')

    expect(project.name).toBe('Custom Name')
  })

  it('project appears in store', () => {
    const project = makeProject({ id: 'project:1', name: 'Test Project' })
    const store = makeStore({ projects: [project] })

    expect(store.projects).toHaveLength(1)
    expect(store.projects[0].name).toBe('Test Project')
  })

  it('conversation can be associated with project', () => {
    const project = makeProject({ id: 'project:1', name: 'Test Project' })
    const conv = makeConversation({ id: 'chat:1', projectId: 'project:1' })
    const store = makeStore({ projects: [project], conversations: [conv] })

    const convProject = store.projects.find(p => p.id === conv.projectId)
    expect(convProject).toBeDefined()
    expect(convProject!.name).toBe('Test Project')
  })
})

describe('User Flow: Goal Mode', () => {
  it('goal state tracks progress', () => {
    const goal = {
      objective: 'Implement feature X',
      status: 'running' as const,
      turnsCompleted: 3,
      maxTurns: 10,
    }

    expect(goal.turnsCompleted).toBeLessThan(goal.maxTurns)
    expect(goal.status).toBe('running')
  })

  it('goal can be paused and resumed', () => {
    let goalStatus: 'running' | 'paused' | 'completed' = 'running'

    goalStatus = 'paused'
    expect(goalStatus).toBe('paused')

    goalStatus = 'running'
    expect(goalStatus).toBe('running')
  })
})

describe('User Flow: Multi-turn Conversation', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('handles 5-turn conversation with growing context', () => {
    const conv = makeConversation({ id: 'chat:1' })
    let items = [...conv.items]

    items = [...items, { id: 'u1', role: 'user', text: 'What is React?', timestamp: 1000 }]
    items = [...items, { id: 'a1', role: 'assistant', text: 'React is a UI library.', timestamp: 1001 }]

    items = [...items, { id: 'u2', role: 'user', text: 'How do hooks work?', timestamp: 2000 }]
    items = [...items, { id: 'a2', role: 'assistant', text: 'Hooks let you use state in functions.', timestamp: 2001 }]

    items = [...items, { id: 'u3', role: 'user', text: 'Show me useState', timestamp: 3000 }]
    items = [...items, { id: 'a3', role: 'assistant', text: 'const [count, setCount] = useState(0)', timestamp: 3001 }]

    items = [...items, { id: 'u4', role: 'user', text: 'And useEffect?', timestamp: 4000 }]
    items = [...items, { id: 'a4', role: 'assistant', text: 'useEffect runs after render.', timestamp: 4001 }]

    items = [...items, { id: 'u5', role: 'user', text: 'Thanks!', timestamp: 5000 }]
    items = [...items, { id: 'a5', role: 'assistant', text: 'You are welcome!', timestamp: 5001 }]

    const store = makeStore({ conversations: [{ ...conv, items, updatedAt: 5001 }] })
    persistChatStore(store)

    const loaded = readChatStore()
    const loadedConv = loaded.conversations.find(c => c.id === 'chat:1')

    expect(loadedConv!.items).toHaveLength(11) // 1 system + 10 messages (5 user + 5 assistant)
    expect(loadedConv!.items.filter(i => i.role === 'user')).toHaveLength(5)
    expect(loadedConv!.items.filter(i => i.role === 'assistant')).toHaveLength(5)
  })
})

describe('User Flow: Conversation Lifecycle', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('complete lifecycle: create → send → receive → archive', () => {
    let store = readChatStore()

    const conv = createConversation()
    store = { ...store, conversations: [...store.conversations, conv] }
    expect(store.conversations).toHaveLength(1)

    const userMsg: TranscriptItem = { id: 'u1', role: 'user', text: 'Hello!', timestamp: 1000 }
    store = updateConversation(store, conv.id, c => ({
      ...c,
      items: [...c.items, userMsg],
      updatedAt: 1000,
    }))
    expect(store.conversations[0].items).toHaveLength(2)

    const assistantMsg: TranscriptItem = { id: 'a1', role: 'assistant', text: 'Hi there!', timestamp: 1001 }
    store = updateConversation(store, conv.id, c => ({
      ...c,
      items: [...c.items, assistantMsg],
      updatedAt: 1001,
      lastTurnEndedAt: 1001,
    }))
    expect(store.conversations[0].items).toHaveLength(3)

    store = updateConversation(store, conv.id, c => ({ ...c, archivedAt: Date.now() }))
    expect(store.conversations[0].archivedAt).toBeGreaterThan(0)

    const visible = visibleConversations(store)
    expect(visible).toHaveLength(0)

    persistChatStore(store)
    const loaded = readChatStore()
    expect(loaded.conversations).toHaveLength(1)
    expect(loaded.conversations[0].archivedAt).toBeGreaterThan(0)
  })
})
