import {
  Archive,
  Blocks,
  Bug,
  ChevronDown,
  ChevronRight,
  FolderClosed,
  FolderPlus,
  Loader2,
  LogOut,
  MessageSquare,
  MessageSquareDashed,
  MessageSquarePlus,
  PanelLeftClose,
  Pin,
  Pencil,
  Search,
  Settings,
  Trash2,
  RotateCcw,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { AvatarSettings, ChatProject, CliAuthStatus, ProfileResult, SidebarUpdatePresentation, StoredConversation } from '../../shared/types'
import { AvatarIcon } from './AvatarIcon'
import { ContextMenu, type ContextMenuState } from './ContextMenu'
import { SidebarUpdateControl } from './SidebarUpdateControl'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss'
import { formatDateTime, useI18n } from '../i18n'
import { DEFAULT_CONVERSATION_TITLE } from '../state/chatStore'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'
import packageJson from '../../../package.json'

export type AppView = 'chat' | 'settings' | 'plugins'

type AppSidebarProps = {
  activeView: AppView
  projects: ChatProject[]
  conversations: StoredConversation[]
  activeConversationId?: string
  runningConversationIds?: Set<string>
  selectedProjectId?: string
  profile: ProfileResult
  cliAuth: CliAuthStatus
  compact?: boolean
  peek?: boolean
  onSelectView: (view: AppView) => void
  onOpenSettings: () => void
  onOpenSearch: () => void
  onOpenFeedback: () => void
  onLogout: () => void
  onNewChat: (projectId?: string) => void
  onToggleSidebar: () => void
  onPinSidebar?: () => void
  onOpenProject: () => void
  onSelectConversation: (conversationId: string) => void
  onToggleProject: (projectId: string) => void
  onRenameProject: (projectId: string, name: string) => void
  onArchiveProject: (projectId: string) => void
  onDeleteProject: (projectId: string) => void
  onArchiveConversation: (conversationId: string) => void
  archivedConversations: StoredConversation[]
  onRestoreConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
  onRenameConversation: (conversationId: string, title: string) => void
  avatarSettings?: AvatarSettings
  updatePresentation?: SidebarUpdatePresentation
  onRequestUpdate?: () => void
}

export function AppSidebar({
  activeView,
  projects,
  conversations,
  activeConversationId,
  selectedProjectId,
  runningConversationIds,
  profile,
  cliAuth,
  compact = false,
  peek = false,
  onSelectView,
  onOpenSettings,
  onOpenSearch,
  onOpenFeedback,
  onLogout,
  onNewChat,
  onToggleSidebar,
  onPinSidebar,
  onOpenProject,
  onSelectConversation,
  onToggleProject,
  onRenameProject,
  onArchiveProject,
  onDeleteProject,
  onArchiveConversation,
  archivedConversations,
  onRestoreConversation,
  onDeleteConversation,
  onRenameConversation,
  avatarSettings,
  updatePresentation,
  onRequestUpdate,
}: AppSidebarProps) {
  const { t } = useI18n()
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [editingProjectId, setEditingProjectId] = useState<string | undefined>()
  const [projectDraft, setProjectDraft] = useState('')
  const [editingConversationId, setEditingConversationId] = useState<string | undefined>()
  const [conversationDraft, setConversationDraft] = useState('')
  const [archivedChatsOpen, setArchivedChatsOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | undefined>()
  const profileMenuRef = useRef<HTMLDivElement | null>(null)
  const archivedChatsListId = useId()
  const profileName = profile.user?.name ?? profile.user?.email ?? cliAuth.email ?? t('sidebar.profile')
  useOutsideDismiss(profileMenuRef, profileMenuOpen, () => setProfileMenuOpen(false))
  useEffect(() => {
    if (archivedConversations.length === 0) setArchivedChatsOpen(false)
  }, [archivedConversations.length])
  // Search lives in the command palette (⌘K / ⌘P): clicking "Pesquisar"
  // opens it via onOpenSearch. Conversations/projects render unfiltered
  // here; filtering happens in the palette.
  const visibleConversations = useMemo(() => conversations, [conversations])
  const visibleProjects = useMemo(() => projects, [projects])
  const looseChats = visibleConversations.filter(conversation => !conversation.projectId)

  useEffect(() => {
    if (!compact) return
    setProfileMenuOpen(false)
    setEditingProjectId(undefined)
  }, [compact])

  function startProjectEdit(project: ChatProject) {
    setEditingProjectId(project.id)
    setProjectDraft(project.name)
  }

  function commitProjectEdit(project: ChatProject) {
    onRenameProject(project.id, projectDraft)
    setEditingProjectId(undefined)
    setProjectDraft('')
  }

  function openProjectContextMenu(event: ReactMouseEvent, project: ChatProject) {
    event.preventDefault()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { key: 'new-chat', label: t('sidebar.newChatInProject'), icon: <MessageSquarePlus size={14} />, onSelect: () => onNewChat(project.id) },
        { key: 'rename', label: t('sidebar.renameProject'), icon: <Pencil size={14} />, onSelect: () => startProjectEdit(project) },
        { key: 'archive', label: t('sidebar.archiveProject'), icon: <Archive size={14} />, onSelect: () => onArchiveProject(project.id) },
        { key: 'delete', label: t('sidebar.deleteProject'), icon: <Trash2 size={14} />, danger: true, onSelect: () => onDeleteProject(project.id) },
      ],
    })
  }

  function startConversationEdit(conversation: StoredConversation) {
    setEditingConversationId(conversation.id)
    setConversationDraft(conversation.title === DEFAULT_CONVERSATION_TITLE ? '' : conversation.title)
  }

  function commitConversationEdit(conversation: StoredConversation) {
    const trimmed = conversationDraft.trim()
    if (trimmed) onRenameConversation(conversation.id, trimmed)
    setEditingConversationId(undefined)
    setConversationDraft('')
  }

  function openConversationContextMenu(event: ReactMouseEvent, conversation: StoredConversation) {
    event.preventDefault()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { key: 'open', label: t('common.open'), icon: <MessageSquare size={14} />, onSelect: () => onSelectConversation(conversation.id) },
        { key: 'rename', label: t('sidebar.renameChat'), icon: <Pencil size={14} />, onSelect: () => startConversationEdit(conversation) },
        { key: 'archive', label: t('sidebar.archiveChat'), icon: <Archive size={14} />, onSelect: () => onArchiveConversation(conversation.id) },
        { key: 'delete', label: t('sidebar.deleteChat'), icon: <Trash2 size={14} />, danger: true, onSelect: () => onDeleteConversation(conversation.id) },
      ],
    })
  }

  return (
    <aside className={`app-sidebar ${compact ? 'compact' : ''} ${peek ? 'peek' : ''} ${activeView === 'settings' ? 'is-dimmed' : ''}`}>
      <div className="sidebar-scroll">
        <nav className="sidebar-primary" aria-label={t('sidebar.nav')}>
          <div className="sidebar-newchat-row">
            <button className="sidebar-action" type="button" onClick={() => onNewChat(selectedProjectId)} title={t('sidebar.newChat')}>
              <MessageSquarePlus size={16} />
              <span>{t('sidebar.newChat')}</span>
            </button>
            {peek ? (
              // Pin button: persists expanded mode (clears peek). Only shown
              // while peeking — in normal expanded mode the collapse button
              // is the single control.
              <button
                className="sidebar-pin-button ui-tooltip"
                type="button"
                onClick={onPinSidebar}
                data-tooltip={t('sidebar.pin')}
                aria-label={t('sidebar.pin')}
              >
                <Pin size={16} />
              </button>
            ) : (
              <button
                className="sidebar-collapse-button ui-tooltip"
                type="button"
                onClick={onToggleSidebar}
                data-tooltip={t('topbar.hideSidebar')}
                aria-label={t('topbar.hideSidebar')}
              >
                <PanelLeftClose size={16} />
              </button>
            )}
          </div>
          <button className="sidebar-action" type="button" onClick={onOpenSearch} title={t('sidebar.search')}>
            <Search size={16} />
            <span>{t('sidebar.search')}</span>
          </button>
          <button
            className={`sidebar-action ${activeView === 'plugins' ? 'active' : ''}`}
            type="button"
            onClick={() => onSelectView('plugins')}
            title={t('sidebar.plugins')}
          >
            <Blocks size={16} />
            <span>{t('sidebar.plugins')}</span>
          </button>
        </nav>

        <section className="sidebar-section project-section">
          <div className="sidebar-section-heading">
            <h2>{t('sidebar.projects')}</h2>
            <button className="sidebar-mini-button" type="button" onClick={onOpenProject} title={t('sidebar.openFolder')}>
              <FolderPlus size={14} />
            </button>
          </div>

          {visibleProjects.length === 0 ? (
            <p className="sidebar-empty">{t('sidebar.noProjects')}</p>
          ) : (
            visibleProjects.map(project => {
              const projectChats = visibleConversations.filter(conversation => conversation.projectId === project.id)
              const isProjectActive = selectedProjectId === project.id
                && (!activeConversationId || projectChats.some(c => c.id === activeConversationId))
              return (
                <div key={project.id} className="sidebar-project">
                  <div
                    className={`project-row ${isProjectActive ? 'active' : ''}`}
                    onContextMenu={event => openProjectContextMenu(event, project)}
                  >
                    <button
                      className="project-toggle"
                      type="button"
                      onClick={() => onToggleProject(project.id)}
                      title={project.path}
                    >
                      {project.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <FolderClosed size={15} />
                    </button>

                    {editingProjectId === project.id ? (
                      <input
                        className="project-name-input"
                        value={projectDraft}
                        onChange={event => setProjectDraft(event.target.value)}
                        onBlur={() => commitProjectEdit(project)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') commitProjectEdit(project)
                          if (event.key === 'Escape') setEditingProjectId(undefined)
                        }}
                        autoFocus
                      />
                    ) : (
                      <button
                        className="project-name-button"
                        type="button"
                        onClick={() => onToggleProject(project.id)}
                        onDoubleClick={() => startProjectEdit(project)}
                      >
                        {project.name}
                      </button>
                    )}

                    <div className="sidebar-row-actions">
                      <button type="button" onClick={() => onNewChat(project.id)} title={t('sidebar.newChatInProject')}>
                        <MessageSquarePlus size={13} />
                      </button>
                      <button type="button" onClick={() => startProjectEdit(project)} title={t('sidebar.renameProject')}>
                        <Pencil size={13} />
                      </button>
                      <button type="button" onClick={() => onArchiveProject(project.id)} title={t('sidebar.archiveProject')}>
                        <Archive size={13} />
                      </button>
                      <button type="button" onClick={() => onDeleteProject(project.id)} title={t('sidebar.deleteProject')}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {!project.collapsed && projectChats.length > 0 && (
                    <div className="project-chat-list">
                      {projectChats.map(conversation => (
                        <ConversationRow
                          key={conversation.id}
                          conversation={conversation}
                          active={conversation.id === activeConversationId && activeView === 'chat'}
                          running={runningConversationIds?.has(conversation.id)}
                          editing={editingConversationId === conversation.id}
                          draft={conversationDraft}
                          onDraftChange={setConversationDraft}
                          onCommitEdit={() => commitConversationEdit(conversation)}
                          onCancelEdit={() => { setEditingConversationId(undefined); setConversationDraft('') }}
                          onSelect={onSelectConversation}
                          onArchive={onArchiveConversation}
                          onDelete={onDeleteConversation}
                          onContextMenu={openConversationContextMenu}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </section>

        <section className="sidebar-section">
          <h2>{t('sidebar.chats')}</h2>
          {looseChats.length === 0 ? (
            <div className="empty-state sidebar-empty">
              <span className="empty-state-icon" aria-hidden="true"><MessageSquareDashed size={17} /></span>
              <span className="empty-state-title">{t('sidebar.noLooseChats')}</span>
              <span className="empty-state-hint">{t('sidebar.noLooseChatsHint')}</span>
            </div>
          ) : (
            looseChats.map(conversation => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeConversationId && activeView === 'chat'}
                running={runningConversationIds?.has(conversation.id)}
                editing={editingConversationId === conversation.id}
                draft={conversationDraft}
                onDraftChange={setConversationDraft}
                onCommitEdit={() => commitConversationEdit(conversation)}
                onCancelEdit={() => { setEditingConversationId(undefined); setConversationDraft('') }}
                onSelect={onSelectConversation}
                onArchive={onArchiveConversation}
                onDelete={onDeleteConversation}
                onContextMenu={openConversationContextMenu}
              />
            ))
          )}
          {archivedConversations.length > 0 && (
            <div className="sidebar-archived">
              <button
                className="sidebar-archived-toggle"
                type="button"
                aria-expanded={archivedChatsOpen}
                aria-controls={archivedChatsListId}
                onClick={() => setArchivedChatsOpen(open => !open)}
              >
                <Archive size={14} />
                <span>{t('sidebar.archivedChats')} · {archivedConversations.length}</span>
                {archivedChatsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              {archivedChatsOpen && (
                <ul id={archivedChatsListId} className="sidebar-archived-list" aria-label={t('sidebar.archivedChats')}>
                  {archivedConversations.map(conversation => (
                    <ArchivedConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      onRestore={onRestoreConversation}
                      onDelete={onDeleteConversation}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>

      <footer className="sidebar-account-wrap" ref={profileMenuRef}>
        {profileMenuOpen && (
          <div className="profile-menu popover-panel t-dropdown is-open" data-origin="bottom-left">
            <button type="button" onClick={() => { onOpenSettings(); setProfileMenuOpen(false) }}>
              <Settings size={15} />
              {t('sidebar.settings')}
            </button>
            <button type="button" onClick={() => { onOpenFeedback(); setProfileMenuOpen(false) }}>
              <Bug size={15} />
              {t('sidebar.helpFeedback')}
            </button>
            <div className="profile-menu-separator" />
            <button type="button" onClick={() => { onLogout(); setProfileMenuOpen(false) }}>
              <LogOut size={15} />
              {t('sidebar.logout')}
            </button>
          </div>
        )}
        {updatePresentation && onRequestUpdate && (
          <SidebarUpdateControl presentation={updatePresentation} onAction={onRequestUpdate} />
        )}
        <button
          className={`sidebar-account ${profileMenuOpen ? 'active' : ''}`}
          type="button"
          onClick={() => setProfileMenuOpen(open => !open)}
          aria-expanded={profileMenuOpen}
        >
          <span className="account-profile">
            <AvatarIcon settings={avatarSettings} name={profileName} className="account-avatar" />
            <span>
              <strong>{profileName}</strong>
              <small>
                {profile.plan?.name ?? (
                  profile.status === 'api-key-only'
                    ? t('profile.apiKeyOnlyTitle')
                    : profile.status === 'unauthenticated' && !cliAuth.loggedIn
                      ? t('sidebar.noApiKey')
                      : t('profile.planUnavailable')
                )}
              </small>
            </span>
          </span>
          <span className="account-brand">
            <img src={mascotUrl} alt="" />
            <strong>Verboo<span>:code</span></strong>
            <small>{`v${packageJson.version}`}</small>
          </span>
        </button>
      </footer>

      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(undefined)} />
    </aside>
  )
}

type ConversationRowProps = {
  conversation: StoredConversation
  active: boolean
  running?: boolean
  editing?: boolean
  draft?: string
  onDraftChange?: (value: string) => void
  onCommitEdit?: () => void
  onCancelEdit?: () => void
  onSelect: (conversationId: string) => void
  onArchive: (conversationId: string) => void
  onDelete: (conversationId: string) => void
  onContextMenu: (event: ReactMouseEvent, conversation: StoredConversation) => void
}

function ConversationRow({ conversation, active, running, editing, draft, onDraftChange, onCommitEdit, onCancelEdit, onSelect, onArchive, onDelete, onContextMenu }: ConversationRowProps) {
  const { t } = useI18n()
  const title = displayConversationTitle(conversation.title, t)

  return (
    <div
      className={`conversation-row ${active ? 'active' : ''} ${running ? 'running' : ''}`}
      onContextMenu={event => onContextMenu(event, conversation)}
    >
      {editing ? (
        <input
          className="conversation-name-input"
          value={draft ?? ''}
          onChange={event => onDraftChange?.(event.target.value)}
          onBlur={() => onCommitEdit?.()}
          onKeyDown={event => {
            if (event.key === 'Enter') onCommitEdit?.()
            if (event.key === 'Escape') onCancelEdit?.()
          }}
          autoFocus
        />
      ) : (
        <button type="button" className="conversation-main" onClick={() => onSelect(conversation.id)}>
          {running ? <Loader2 size={14} className="spin-icon" /> : <MessageSquare size={14} />}
          <span>{title}</span>
          <small>{relativeTime(conversation.updatedAt, t)}</small>
        </button>
      )}
      <div className="sidebar-row-actions">
        <button type="button" onClick={() => onArchive(conversation.id)} title={t('sidebar.archiveChat')}>
          <Archive size={13} />
        </button>
        <button type="button" onClick={() => onDelete(conversation.id)} title={t('sidebar.deleteChat')}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

function ArchivedConversationRow({ conversation, onRestore, onDelete }: {
  conversation: StoredConversation
  onRestore: (conversationId: string) => void
  onDelete: (conversationId: string) => void
}) {
  const { language, t } = useI18n()

  return (
    <li className="sidebar-archived-row">
      <MessageSquare size={14} />
      <span>
        <strong>{displayConversationTitle(conversation.title, t)}</strong>
        <small>{formatDateTime(conversation.archivedAt ?? conversation.updatedAt, language)}</small>
      </span>
      <div className="sidebar-archived-row-actions">
        <button type="button" onClick={() => onRestore(conversation.id)} title={t('common.restore')} aria-label={t('common.restore')}>
          <RotateCcw size={13} />
        </button>
        <button type="button" onClick={() => onDelete(conversation.id)} title={t('common.delete')} aria-label={t('common.delete')}>
          <Trash2 size={13} />
        </button>
      </div>
    </li>
  )
}

function displayConversationTitle(title: string, t: (key: string) => string): string {
  return title === DEFAULT_CONVERSATION_TITLE ? t('sidebar.newChat') : title
}

function relativeTime(timestamp: number, t: (key: string, values?: Record<string, string | number | undefined>) => string): string {
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t('sidebar.now')
  if (minutes < 60) return t('sidebar.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('sidebar.hours', { count: hours })
  return t('sidebar.days', { count: Math.floor(hours / 24) })
}
