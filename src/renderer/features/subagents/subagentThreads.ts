import type {
  StoredConversation,
  SubagentThread,
  SubagentThreadEvent,
  SubagentThreadStatus,
  SubagentThreadUpdate,
} from '../../../shared/types'
import { stripTerminalControl, truncateToolOutput } from '../transcript/toolOutput'

const THREAD_STATUSES = new Set<SubagentThreadStatus>([
  'queued',
  'thinking',
  'reading',
  'searching',
  'running',
  'completed',
  'failed',
  'cancelled',
])

const EVENT_KINDS = new Set<SubagentThreadEvent['kind']>([
  'mission',
  'agent-message',
  'tool-call',
  'tool-result',
  'status',
  'final',
  'error',
])

export function applySubagentThreadUpdate(
  conversation: StoredConversation,
  parentTurnId: string,
  update: SubagentThreadUpdate,
): StoredConversation {
  const currentThreads = conversation.subagents ?? []
  const existingIndex = currentThreads.findIndex(thread => thread.id === update.threadId)
  const receivedAt = update.event?.timestamp ?? Date.now()
  const existing = existingIndex >= 0 ? currentThreads[existingIndex] : undefined
  const event = update.event ? sanitizeEvent(update.event) : undefined

  let events = existing?.events ?? []
  if (event && !events.some(current => current.id === event.id)) {
    if (event.kind === 'final') {
      let lastMessageIndex = -1
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].kind === 'agent-message') {
          lastMessageIndex = index
          break
        }
      }
      const lastMessage = lastMessageIndex >= 0 ? events[lastMessageIndex] : undefined
      if (lastMessage?.text === event.text) {
        events = events.map((current, index) =>
          index === lastMessageIndex ? { ...current, kind: 'final' } : current,
        )
      } else {
        events = [...events, event]
      }
    } else {
      events = [...events, event]
    }
    events = [...events].sort(compareEvents)
  }

  const mission = clean(update.mission ?? existing?.mission ?? '')
  const next: SubagentThread = {
    id: update.threadId,
    runtimeAgentId: cleanOptional(update.runtimeAgentId ?? existing?.runtimeAgentId),
    parentTurnId: existing?.parentTurnId ?? parentTurnId,
    toolUseId: cleanOptional(update.toolUseId ?? existing?.toolUseId),
    label: clean(update.label ?? existing?.label ?? fallbackLabel(update.threadId)),
    mission,
    status: update.status ?? existing?.status ?? 'queued',
    events,
    createdAt: existing?.createdAt ?? receivedAt,
    updatedAt: Math.max(existing?.updatedAt ?? receivedAt, receivedAt),
  }

  const subagents = existingIndex >= 0
    ? currentThreads.map((thread, index) => index === existingIndex ? next : thread)
    : [...currentThreads, next]

  return { ...conversation, subagents }
}

export function sanitizeSubagentThreads(value: unknown): SubagentThread[] {
  if (!Array.isArray(value)) return []
  return value
    .map(sanitizeThread)
    .filter((thread): thread is SubagentThread => Boolean(thread))
}

export function isSubagentThreadWorking(thread: SubagentThread): boolean {
  return !['completed', 'failed', 'cancelled'].includes(thread.status)
}

export function latestSubagentThread(threads: SubagentThread[]): SubagentThread | undefined {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export function subagentThreadCounts(threads: SubagentThread[]): { total: number; working: number } {
  return {
    total: threads.length,
    working: threads.filter(isSubagentThreadWorking).length,
  }
}

function sanitizeThread(value: unknown): SubagentThread | undefined {
  if (!isRecord(value)) return undefined
  if (!isString(value.id) || !isString(value.parentTurnId) || !isString(value.label)) return undefined
  if (!isString(value.mission) || !isStatus(value.status)) return undefined
  if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt)) return undefined

  const events = Array.isArray(value.events)
    ? value.events
      .map(sanitizeEvent)
      .filter((event): event is SubagentThreadEvent => Boolean(event))
      .sort(compareEvents)
    : []

  return {
    id: clean(value.id),
    runtimeAgentId: cleanOptional(value.runtimeAgentId),
    parentTurnId: clean(value.parentTurnId),
    toolUseId: cleanOptional(value.toolUseId),
    label: clean(value.label),
    mission: clean(value.mission),
    status: value.status,
    events: dedupeEvents(events),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function sanitizeEvent(value: unknown): SubagentThreadEvent | undefined {
  if (!isRecord(value)) return undefined
  if (!isString(value.id) || !isEventKind(value.kind) || !isString(value.text)) return undefined
  if (!isFiniteNumber(value.timestamp)) return undefined

  const text = value.kind === 'tool-result'
    ? truncateToolOutput(value.text, value.isError === true)
    : clean(value.text)

  return {
    id: clean(value.id),
    kind: value.kind,
    text,
    timestamp: value.timestamp,
    toolName: cleanOptional(value.toolName),
    toolUseId: cleanOptional(value.toolUseId),
    isError: typeof value.isError === 'boolean' ? value.isError : undefined,
  }
}

function dedupeEvents(events: SubagentThreadEvent[]): SubagentThreadEvent[] {
  const seen = new Set<string>()
  return events.filter(event => {
    if (seen.has(event.id)) return false
    seen.add(event.id)
    return true
  })
}

function compareEvents(a: SubagentThreadEvent, b: SubagentThreadEvent): number {
  return a.timestamp - b.timestamp || a.id.localeCompare(b.id)
}

function fallbackLabel(threadId: string): string {
  const suffix = threadId.split(':').at(-1)?.trim()
  return suffix ? `Agent ${suffix.slice(0, 8)}` : 'Agent'
}

function clean(value: string): string {
  return stripTerminalControl(value)
}

function cleanOptional(value: unknown): string | undefined {
  return isString(value) ? clean(value) : undefined
}

function isStatus(value: unknown): value is SubagentThreadStatus {
  return isString(value) && THREAD_STATUSES.has(value as SubagentThreadStatus)
}

function isEventKind(value: unknown): value is SubagentThreadEvent['kind'] {
  return isString(value) && EVENT_KINDS.has(value as SubagentThreadEvent['kind'])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
