import { Blocks, Ghost, MessageSquare, MessageSquarePlus, Moon, PanelLeft, Search, Settings, Shrink, SquareTerminal, FileDiff } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { StoredConversation } from '../../shared/types'
import { useI18n } from '../i18n'
import { DEFAULT_CONVERSATION_TITLE } from '../state/chatStore'

export type PaletteAction = {
  key: string
  label: string
  icon: ReactNode
  run: () => void
}

type CommandPaletteProps = {
  open: boolean
  conversations: StoredConversation[]
  actions: PaletteAction[]
  onSelectConversation: (conversationId: string) => void
  onClose: () => void
}

// cmd+K palette (shadcn Command pattern): one input, actions + chat search,
// full keyboard navigation. Rendered as a top-centered modal.
export function CommandPalette({ open, conversations, actions, onSelectConversation, onClose }: CommandPaletteProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlighted(0)
    inputRef.current?.focus()
  }, [open])

  const normalizedQuery = query.trim().toLowerCase()

  const visibleActions = useMemo(
    () => actions.filter(action => !normalizedQuery || action.label.toLowerCase().includes(normalizedQuery)),
    [actions, normalizedQuery],
  )

  const visibleChats = useMemo(() => {
    const active = conversations.filter(conversation => !conversation.archivedAt)
    const matches = normalizedQuery
      ? active.filter(conversation => displayConversationTitle(conversation.title, t).toLowerCase().includes(normalizedQuery))
      : active
    return matches.slice(0, 8)
  }, [conversations, normalizedQuery, t])

  // Recents: top 5 chats by updatedAt, shown only when the query is empty.
  // Gives the empty-state palette immediate utility — the user sees their most
  // recent conversations without typing. Distinct from visibleChats (which is
  // the filtered search list) so the two sections can render independently.
  const recentChats = useMemo(() => {
    if (normalizedQuery) return []
    return conversations
      .filter(conversation => !conversation.archivedAt)
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5)
  }, [conversations, normalizedQuery])

  type Row = { kind: 'action'; action: PaletteAction } | { kind: 'chat'; chat: StoredConversation }
  const rows: Row[] = useMemo(() => [
    ...visibleActions.map(action => ({ kind: 'action' as const, action })),
    ...recentChats.map(chat => ({ kind: 'chat' as const, chat })),
    ...visibleChats.map(chat => ({ kind: 'chat' as const, chat })),
  ], [visibleActions, recentChats, visibleChats])

  const activeIndex = rows.length ? Math.min(highlighted, rows.length - 1) : 0

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  function runRow(row: Row) {
    onClose()
    if (row.kind === 'action') row.action.run()
    else onSelectConversation(row.chat.id)
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { onClose(); return }
    if (!rows.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted(index => (index + 1) % rows.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted(index => (index - 1 + rows.length) % rows.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      runRow(rows[activeIndex])
    }
  }

  let cursor = -1

  return (
    <div className="modal-backdrop palette-backdrop" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div className="command-palette t-modal is-open" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input-row">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('palette.placeholder')}
            onChange={event => { setQuery(event.target.value); setHighlighted(0) }}
            onKeyDown={handleKeyDown}
          />
          <kbd>esc</kbd>
        </div>
        <div ref={listRef} className="palette-list">
          {rows.length === 0 && <div className="palette-empty">{t('palette.empty')}</div>}
          {/* Empty query: Recents (top 5 chats by updatedAt) + Suggestions (all actions).
              Typed query: filtered Actions + filtered Chats (no Recents — the
              filtered chats list already serves that role). */}
          {!normalizedQuery && recentChats.length > 0 && (
            <>
              <div className="palette-group-label">{t('palette.recents')}</div>
              {recentChats.map(chat => {
                cursor += 1
                const index = cursor
                return (
                  <button
                    key={`recent-${chat.id}`}
                    type="button"
                    data-index={index}
                    className={`palette-item ${index === activeIndex ? 'highlighted' : ''}`}
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => runRow({ kind: 'chat', chat })}
                  >
                    <span className="palette-item-icon" aria-hidden="true"><MessageSquare size={14} /></span>
                    <span className="palette-item-label">{displayConversationTitle(chat.title, t)}</span>
                  </button>
                )
              })}
            </>
          )}
          {visibleActions.length > 0 && <div className="palette-group-label">{normalizedQuery ? t('palette.actions') : t('palette.suggestions')}</div>}
          {visibleActions.map(action => {
            cursor += 1
            const index = cursor
            return (
              <button
                key={action.key}
                type="button"
                data-index={index}
                className={`palette-item ${index === activeIndex ? 'highlighted' : ''}`}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => runRow({ kind: 'action', action })}
              >
                <span className="palette-item-icon" aria-hidden="true">{action.icon}</span>
                {action.label}
              </button>
            )
          })}
          {normalizedQuery && visibleChats.length > 0 && <div className="palette-group-label">{t('palette.chats')}</div>}
          {normalizedQuery && visibleChats.map(chat => {
            cursor += 1
            const index = cursor
            return (
              <button
                key={chat.id}
                type="button"
                data-index={index}
                className={`palette-item ${index === activeIndex ? 'highlighted' : ''}`}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => runRow({ kind: 'chat', chat })}
              >
                <span className="palette-item-icon" aria-hidden="true"><MessageSquare size={14} /></span>
                <span className="palette-item-label">{displayConversationTitle(chat.title, t)}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function displayConversationTitle(title: string, t: (key: string) => string): string {
  return title === DEFAULT_CONVERSATION_TITLE ? t('sidebar.newChat') : title
}

export const paletteIcons = {
  newChat: <MessageSquarePlus size={14} />,
  plugins: <Blocks size={14} />,
  settings: <Settings size={14} />,
  theme: <Moon size={14} />,
  terminal: <SquareTerminal size={14} />,
  review: <FileDiff size={14} />,
  sidebar: <PanelLeft size={14} />,
  pet: <Ghost size={14} />,
  compact: <Shrink size={14} />,
}
