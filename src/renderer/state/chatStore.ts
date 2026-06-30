import type { ChatStore, StoredConversation, TranscriptItem } from '../../shared/types'

export const CHAT_STORE_KEY = 'verboo:chat-store:v1'

export function readChatStore(): ChatStore {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_STORE_KEY) ?? '') as unknown
    if (!isChatStore(parsed)) return emptyChatStore()
    return sanitizeChatStore(parsed)
  } catch {
    return emptyChatStore()
  }
}

export function persistChatStore(store: ChatStore): void {
  window.localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(store))
}

export function emptyChatStore(): ChatStore {
  return {
    version: 1,
    projects: [],
    conversations: [],
  }
}

export function createConversation(projectId?: string): StoredConversation {
  const now = Date.now()
  return {
    id: `chat:${crypto.randomUUID()}`,
    title: 'Novo chat',
    projectId,
    items: [initialSystemMessage()],
    createdAt: now,
    updatedAt: now,
  }
}

export function createProject(path: string, name = basename(path)): ChatStore['projects'][number] {
  const now = Date.now()
  return {
    id: `project:${crypto.randomUUID()}`,
    name: name || 'Projeto',
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
    text: 'Pronto para codar com Verboo. Use / para chamar skills e /pet para mostrar o mascote.',
    timestamp: Date.now(),
  }
}

export function titleFromMessage(message: string): string {
  const firstLine = message.trim().split('\n')[0] ?? ''
  const compact = firstLine.replace(/\s+/g, ' ')
  if (!compact) return 'Novo chat'
  return compact.length > 42 ? `${compact.slice(0, 39)}...` : compact
}

export function visibleConversations(store: ChatStore): StoredConversation[] {
  return store.conversations
    .filter(conversation => !conversation.archivedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function archivedConversations(store: ChatStore): StoredConversation[] {
  return store.conversations
    .filter(conversation => conversation.archivedAt)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

export function activeProjects(store: ChatStore): ChatStore['projects'] {
  return store.projects
    .filter(project => !project.archivedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function isChatStore(value: unknown): value is ChatStore {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ChatStore>
  return candidate.version === 1 && Array.isArray(candidate.projects) && Array.isArray(candidate.conversations)
}

function sanitizeChatStore(store: ChatStore): ChatStore {
  return {
    ...store,
    conversations: store.conversations.map(conversation => ({
      ...conversation,
      items: conversation.items.map(item => ({
        ...item,
        text: stripTerminalControl(item.text),
      })),
    })),
  }
}

function stripTerminalControl(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').replace(/\u001b/g, '')
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}
