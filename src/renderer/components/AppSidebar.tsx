import {
  Archive,
  Bug,
  ChevronDown,
  ChevronRight,
  FolderClosed,
  FolderPlus,
  LogOut,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Search,
  Settings,
  Trash2,
  UserRound,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatProject, CliAuthStatus, ProfileResult, StoredConversation } from '../../shared/types'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'
import packageJson from '../../../package.json'

export type AppView = 'chat' | 'profile' | 'settings'

type AppSidebarProps = {
  activeView: AppView
  projects: ChatProject[]
  conversations: StoredConversation[]
  activeConversationId?: string
  selectedProjectId?: string
  profile: ProfileResult
  cliAuth: CliAuthStatus
  compact?: boolean
  onSelectView: (view: AppView) => void
  onOpenSettings: () => void
  onOpenArchivedChats: () => void
  onOpenFeedback: () => void
  onLogout: () => void
  onNewChat: (projectId?: string) => void
  onOpenProject: () => void
  onSelectConversation: (conversationId: string) => void
  onToggleProject: (projectId: string) => void
  onRenameProject: (projectId: string, name: string) => void
  onArchiveProject: (projectId: string) => void
  onDeleteProject: (projectId: string) => void
  onArchiveConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
}

export function AppSidebar({
  activeView,
  projects,
  conversations,
  activeConversationId,
  selectedProjectId,
  profile,
  cliAuth,
  compact = false,
  onSelectView,
  onOpenSettings,
  onOpenArchivedChats,
  onOpenFeedback,
  onLogout,
  onNewChat,
  onOpenProject,
  onSelectConversation,
  onToggleProject,
  onRenameProject,
  onArchiveProject,
  onDeleteProject,
  onArchiveConversation,
  onDeleteConversation,
}: AppSidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [editingProjectId, setEditingProjectId] = useState<string | undefined>()
  const [projectDraft, setProjectDraft] = useState('')
  const profileMenuRef = useRef<HTMLDivElement | null>(null)
  const profileName = profile.user?.name ?? profile.user?.email ?? cliAuth.email ?? 'Perfil Verboo'
  useOutsideDismiss(profileMenuRef, profileMenuOpen, () => setProfileMenuOpen(false))
  const filteredConversations = useMemo(
    () => filterConversations(conversations, query),
    [conversations, query],
  )
  const filteredProjects = useMemo(
    () => filterProjects(projects, filteredConversations, query),
    [projects, filteredConversations, query],
  )
  const looseChats = filteredConversations.filter(conversation => !conversation.projectId)

  useEffect(() => {
    if (!compact) return
    setSearchOpen(false)
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

  return (
    <aside className={`app-sidebar ${compact ? 'compact' : ''} ${activeView === 'settings' ? 'is-dimmed' : ''}`}>
      <div className="sidebar-scroll">
        <nav className="sidebar-primary" aria-label="Navegação principal">
          <button className="sidebar-action" type="button" onClick={() => onNewChat(selectedProjectId)} title="Novo chat">
            <MessageSquarePlus size={16} />
            <span>Novo chat</span>
          </button>
          <button className="sidebar-action" type="button" onClick={() => setSearchOpen(open => !open)} title="Pesquisar">
            <Search size={16} />
            <span>Pesquisar</span>
          </button>
          {searchOpen && (
            <input
              className="sidebar-search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              autoFocus
              placeholder="Buscar chats e projetos"
              aria-label="Buscar chats e projetos"
            />
          )}
        </nav>

        <section className="sidebar-section project-section">
          <div className="sidebar-section-heading">
            <h2>Projetos</h2>
            <button className="sidebar-mini-button" type="button" onClick={onOpenProject} title="Abrir pasta">
              <FolderPlus size={14} />
            </button>
          </div>

          {filteredProjects.length === 0 ? (
            <p className="sidebar-empty">Abra uma pasta para criar um projeto.</p>
          ) : (
            filteredProjects.map(project => {
              const projectChats = filteredConversations.filter(conversation => conversation.projectId === project.id)
              return (
                <div key={project.id} className="sidebar-project">
                  <div className={`project-row ${selectedProjectId === project.id ? 'active' : ''}`}>
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
                      <button type="button" onClick={() => onNewChat(project.id)} title="Novo chat neste projeto">
                        <MessageSquarePlus size={13} />
                      </button>
                      <button type="button" onClick={() => startProjectEdit(project)} title="Renomear projeto">
                        <Pencil size={13} />
                      </button>
                      <button type="button" onClick={() => onArchiveProject(project.id)} title="Arquivar projeto">
                        <Archive size={13} />
                      </button>
                      <button type="button" onClick={() => onDeleteProject(project.id)} title="Apagar projeto">
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
                          onSelect={onSelectConversation}
                          onArchive={onArchiveConversation}
                          onDelete={onDeleteConversation}
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
          <h2>Chats</h2>
          {looseChats.length === 0 ? (
            <p className="sidebar-empty">Nenhum chat sem projeto.</p>
          ) : (
            looseChats.map(conversation => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeConversationId && activeView === 'chat'}
                onSelect={onSelectConversation}
                onArchive={onArchiveConversation}
                onDelete={onDeleteConversation}
              />
            ))
          )}
        </section>
      </div>

      <footer className="sidebar-account-wrap" ref={profileMenuRef}>
        {profileMenuOpen && (
          <div className="profile-menu popover-panel t-dropdown is-open" data-origin="bottom-left">
            <button type="button" onClick={() => { onSelectView('profile'); setProfileMenuOpen(false) }}>
              <UserRound size={15} />
              Perfil
            </button>
            <button type="button" onClick={() => { onOpenSettings(); setProfileMenuOpen(false) }}>
              <Settings size={15} />
              Configurações
            </button>
            <button type="button" onClick={() => { onOpenArchivedChats(); setProfileMenuOpen(false) }}>
              <Archive size={15} />
              Chats arquivados
            </button>
            <button type="button" onClick={() => { onOpenFeedback(); setProfileMenuOpen(false) }}>
              <Bug size={15} />
              Ajuda e feedback
            </button>
            <div className="profile-menu-separator" />
            <button type="button" onClick={() => { onLogout(); setProfileMenuOpen(false) }}>
              <LogOut size={15} />
              Sair
            </button>
          </div>
        )}
        <button
          className={`sidebar-account ${profileMenuOpen ? 'active' : ''}`}
          type="button"
          onClick={() => setProfileMenuOpen(open => !open)}
          aria-expanded={profileMenuOpen}
        >
          <span className="account-brand">
            <img src={mascotUrl} alt="" />
            <strong>Verboo<span>:code</span></strong>
            <small>{`v${packageJson.version}`}</small>
          </span>
          <small className="account-disclaimer">Versão independente em desenvolvimento</small>
          <span className="account-profile">
            <span className="account-avatar">{initials(profileName)}</span>
            <span>
              <strong>{profileName}</strong>
              <small>{profile.plan?.name ?? (cliAuth.loggedIn ? 'CLI conectado' : profile.status === 'unauthenticated' ? 'Sem chave de API' : 'Plano indisponível')}</small>
            </span>
          </span>
        </button>
      </footer>
    </aside>
  )
}

type ConversationRowProps = {
  conversation: StoredConversation
  active: boolean
  onSelect: (conversationId: string) => void
  onArchive: (conversationId: string) => void
  onDelete: (conversationId: string) => void
}

function ConversationRow({ conversation, active, onSelect, onArchive, onDelete }: ConversationRowProps) {
  return (
    <div className={`conversation-row ${active ? 'active' : ''}`}>
      <button type="button" className="conversation-main" onClick={() => onSelect(conversation.id)}>
        <MessageSquare size={14} />
        <span>{conversation.title}</span>
        <small>{relativeTime(conversation.updatedAt)}</small>
      </button>
      <div className="sidebar-row-actions">
        <button type="button" onClick={() => onArchive(conversation.id)} title="Arquivar chat">
          <Archive size={13} />
        </button>
        <button type="button" onClick={() => onDelete(conversation.id)} title="Apagar chat">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

function filterConversations(conversations: StoredConversation[], query: string): StoredConversation[] {
  const normalized = query.trim().toLowerCase()
  return conversations
    .filter(conversation => !conversation.archivedAt)
    .filter(conversation => !normalized || conversation.title.toLowerCase().includes(normalized))
}

function filterProjects(projects: ChatProject[], conversations: StoredConversation[], query: string): ChatProject[] {
  const normalized = query.trim().toLowerCase()
  return projects
    .filter(project => !project.archivedAt)
    .filter(project => {
      if (!normalized) return true
      if (project.name.toLowerCase().includes(normalized)) return true
      return conversations.some(conversation => conversation.projectId === project.id)
    })
}

function relativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

function initials(value: string): string {
  const parts = value.split(/\s+/).filter(Boolean)
  if (!parts.length) return 'V'
  return parts.slice(0, 2).map(part => part[0]?.toUpperCase()).join('')
}
