import type { ChatProject, ChatStore, StoredConversation, TranscriptItem } from '../../shared/types'
import { sanitizeSubagentThreads } from '../features/subagents/subagentThreads'

export const CHAT_STORE_KEY = 'verboo:chat-store:v1'
export const DEFAULT_CONVERSATION_TITLE = 'Novo chat'
export const DEFAULT_PROJECT_NAME = 'Projeto'

type LegacyStoredConversation = Omit<StoredConversation, 'subagents'> & { subagents?: unknown }
type LegacyChatStore = {
  version: 1 | 2
  projects: ChatProject[]
  conversations: LegacyStoredConversation[]
}
type PersistedChatStore = ChatStore | LegacyChatStore

export function readChatStore(): ChatStore {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_STORE_KEY) ?? '') as unknown
    if (!isPersistedChatStore(parsed)) return emptyChatStore()
    return sanitizeChatStore(migrateChatStore(parsed))
  } catch {
    return emptyChatStore()
  }
}

export function persistChatStore(store: ChatStore): void {
  try {
    window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(store))
  } catch {
    // localStorage can throw (quota exceeded on a very long history, or a
    // restricted mode). Never let a persistence failure crash the app or an
    // in-flight streaming turn — the store stays in memory regardless.
  }
}

export function emptyChatStore(): ChatStore {
  return {
    version: 3,
    projects: [],
    conversations: [],
  }
}

export function createConversation(projectId?: string): StoredConversation {
  const now = Date.now()
  return {
    id: `chat:${crypto.randomUUID()}`,
    title: DEFAULT_CONVERSATION_TITLE,
    projectId,
    items: [initialSystemMessage()],
    subagents: [],
    createdAt: now,
    updatedAt: now,
    lastTurnEndedAt: now,
  }
}

export function createProject(path: string, name = basename(path)): ChatStore['projects'][number] {
  const now = Date.now()
  return {
    id: `project:${crypto.randomUUID()}`,
    name: name || DEFAULT_PROJECT_NAME,
    path,
    collapsed: false,
    createdAt: now,
    updatedAt: now,
  }
}

export function initialSystemMessage(): TranscriptItem {
  return {
    id: 'welcome',
    role: 'system',
    text: 'Pronto para codar com Verboo. Use / para chamar habilidades.',
    timestamp: Date.now(),
  }
}

export function titleFromMessage(message: string): string {
  const firstLine = message.trim().split('\n')[0] ?? ''
  const compact = firstLine.replace(/\s+/g, ' ')
  if (!compact) return DEFAULT_CONVERSATION_TITLE
  return compact.length > 42 ? `${compact.slice(0, 39)}...` : compact
}

export function visibleConversations(store: ChatStore): StoredConversation[] {
  return store.conversations
    .filter(conversation => !conversation.archivedAt)
    .sort((a, b) => (b.lastTurnEndedAt ?? b.updatedAt) - (a.lastTurnEndedAt ?? a.updatedAt))
}

export function archivedConversations(store: ChatStore): StoredConversation[] {
  return store.conversations
    .filter(conversation => conversation.archivedAt)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

export function activeProjects(store: ChatStore): ChatStore['projects'] {
  return store.projects.filter(project => !project.archivedAt)
}

function isPersistedChatStore(value: unknown): value is PersistedChatStore {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedChatStore>
  return (
    (candidate.version === 1 || candidate.version === 2 || candidate.version === 3) &&
    Array.isArray(candidate.projects) &&
    Array.isArray(candidate.conversations)
  )
}

function migrateChatStore(store: PersistedChatStore): ChatStore {
  if (store.version === 3) return store
  return {
    ...store,
    version: 3,
    conversations: store.conversations.map(conversation => ({
      ...conversation,
      goal: store.version === 1 ? undefined : conversation.goal,
      subagents: [],
    })),
  }
}

/** Ensure a conversation has `lastTurnEndedAt` set (legacy migration).
 *  Conversations persisted before the field existed may lack it; the sort
 *  in visibleConversations falls back to updatedAt, but by filling it here
 *  we guarantee the invariant that all persisted conversations have the field. */
export function sanitizeConversation(conversation: StoredConversation): StoredConversation {
  return {
    ...conversation,
    lastTurnEndedAt: conversation.lastTurnEndedAt ?? conversation.updatedAt,
    subagents: sanitizeSubagentThreads(conversation.subagents),
  }
}

function sanitizeChatStore(store: ChatStore): ChatStore {
  return {
    ...store,
    conversations: store.conversations.map(conversation =>
      sanitizeConversation({
        ...conversation,
        items: conversation.items
          .filter(item => !item.id.endsWith(':queued'))
          .map(item => ({
            ...item,
            text: stripTerminalControl(item.text),
          })),
      }),
    ),
  }
}

function stripTerminalControl(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').replace(/\u001b/g, '')
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}
