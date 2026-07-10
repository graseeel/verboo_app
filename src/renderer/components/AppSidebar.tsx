import {
  Archive,
  Bug,
  Camera,
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
  Pencil,
  RotateCcw,
  Search,
  Settings,
  Trash2,
  UserRound,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ChatProject, CliAuthStatus, ProfileResult, StoredConversation, AvatarSettings } from '../../shared/types'
import { AvatarIcon } from './AvatarIcon'
import { AVATAR_PALETTE, AVATAR_PRESETS, renderPreset } from '../features/profile/avatarPresets'
import { ContextMenu, type ContextMenuState } from './ContextMenu'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss'
import { useI18n } from '../i18n'
import { DEFAULT_CONVERSATION_TITLE } from '../state/chatStore'
import mascotUrl from '../../../assets/branding/verboo-mascot.png'
import packageJson from '../../../package.json'

export type AppView = 'chat' | 'profile' | 'settings'

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
  onSelectView: (view: AppView) => void
  onOpenSettings: () => void
  onOpenArchivedChats: () => void
  onOpenFeedback: () => void
  onLogout: () => void
  onNewChat: (projectId?: string) => void
  onToggleSidebar: () => void
  onOpenProject: () => void
  onSelectConversation: (conversationId: string) => void
  onToggleProject: (projectId: string) => void
  onRenameProject: (projectId: string, name: string) => void
  onArchiveProject: (projectId: string) => void
  onDeleteProject: (projectId: string) => void
  onArchiveConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
  onRenameConversation: (conversationId: string, title: string) => void
  avatarSettings?: AvatarSettings
  onUpdateAvatarSettings?: (settings: AvatarSettings) => void
  onSaveAvatarUpload?: () => Promise<string | undefined>
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
  onSelectView,
  onOpenSettings,
  onOpenArchivedChats,
  onOpenFeedback,
  onLogout,
  onNewChat,
  onToggleSidebar,
  onOpenProject,
  onSelectConversation,
  onToggleProject,
  onRenameProject,
  onArchiveProject,
  onDeleteProject,
  onArchiveConversation,
  onDeleteConversation,
  onRenameConversation,
  avatarSettings,
  onUpdateAvatarSettings,
}: AppSidebarProps) {
  const { t } = useI18n()
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [editingProjectId, setEditingProjectId] = useState<string | undefined>()
  const [projectDraft, setProjectDraft] = useState('')
  const [editingConversationId, setEditingConversationId] = useState<string | undefined>()
  const [conversationDraft, setConversationDraft] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | undefined>()
  const profileMenuRef = useRef<HTMLDivElement | null>(null)
  const profileName = profile.user?.name ?? profile.user?.email ?? cliAuth.email ?? t('sidebar.profile')
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
    <aside className={`app-sidebar ${compact ? 'compact' : ''} ${activeView === 'settings' ? 'is-dimmed' : ''}`}>
      <div className="sidebar-scroll">
        <nav className="sidebar-primary" aria-label={t('sidebar.nav')}>
          <div className="sidebar-newchat-row">
            <button className="sidebar-action" type="button" onClick={() => onNewChat(selectedProjectId)} title={t('sidebar.newChat')}>
              <MessageSquarePlus size={16} />
              <span>{t('sidebar.newChat')}</span>
            </button>
            <button
              className="sidebar-collapse-button ui-tooltip"
              type="button"
              onClick={onToggleSidebar}
              data-tooltip={t('topbar.hideSidebar')}
              aria-label={t('topbar.hideSidebar')}
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
          <button className="sidebar-action" type="button" onClick={() => setSearchOpen(open => !open)} title={t('sidebar.search')}>
            <Search size={16} />
            <span>{t('sidebar.search')}</span>
          </button>
          {searchOpen && (
            <input
              className="sidebar-search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              autoFocus
              placeholder={t('sidebar.searchPlaceholder')}
              aria-label={t('sidebar.searchPlaceholder')}
            />
          )}
        </nav>

        <section className="sidebar-section project-section">
          <div className="sidebar-section-heading">
            <h2>{t('sidebar.projects')}</h2>
            <button className="sidebar-mini-button" type="button" onClick={onOpenProject} title={t('sidebar.openFolder')}>
              <FolderPlus size={14} />
            </button>
          </div>

          {filteredProjects.length === 0 ? (
            <p className="sidebar-empty">{t('sidebar.noProjects')}</p>
          ) : (
            filteredProjects.map(project => {
              const projectChats = filteredConversations.filter(conversation => conversation.projectId === project.id)
              return (
                <div key={project.id} className="sidebar-project">
                  <div
                    className={`project-row ${selectedProjectId === project.id ? 'active' : ''}`}
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
        </section>
      </div>

      <footer className="sidebar-account-wrap" ref={profileMenuRef}>
        {profileMenuOpen && (
          <div className="profile-menu popover-panel t-dropdown is-open" data-origin="bottom-left">
            <button type="button" onClick={() => { onSelectView('profile'); setProfileMenuOpen(false) }}>
              <UserRound size={15} />
              {t('sidebar.profile')}
            </button>
            <button type="button" onClick={() => { onOpenSettings(); setProfileMenuOpen(false) }}>
              <Settings size={15} />
              {t('sidebar.settings')}
            </button>
            <button type="button" onClick={() => { onOpenArchivedChats(); setProfileMenuOpen(false) }}>
              <Archive size={15} />
              {t('sidebar.archivedChats')}
            </button>
            <button type="button" onClick={() => { onOpenFeedback(); setProfileMenuOpen(false) }}>
              <Bug size={15} />
              {t('sidebar.helpFeedback')}
            </button>
            <div className="profile-menu-separator" />

            {/* ── Avatar settings ────────────────────── */}
            {onUpdateAvatarSettings && (
              <div className="profile-avatar-section">
                <div className="profile-avatar-preview">
                  <AvatarIcon settings={avatarSettings} name={profileName} className="account-avatar" />
                  <label className="profile-avatar-upload" title={t('settings.avatarUpload')}>
                    <Camera size={12} />
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only"
                      onChange={async e => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        if (file.size > 10 * 1024 * 1024) return
                        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return
                        const img = await createImageBitmap(file)
                        const size = Math.min(img.width, img.height)
                        const sx = (img.width - size) / 2
                        const sy = (img.height - size) / 2
                        const canvas = document.createElement('canvas')
                        canvas.width = 120; canvas.height = 120
                        const ctx = canvas.getContext('2d')!
                        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
                        ctx.drawImage(img, sx, sy, size, size, 0, 0, 120, 120)
                        const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, file.type, 0.92))
                        if (!blob) return
                        const base64 = await new Promise<string>(r => {
                          const fr = new FileReader()
                          fr.onload = () => r((fr.result as string).split(',')[1])
                          fr.readAsDataURL(blob!)
                        })
                        const path = await window.verboo.saveAvatarBlob(base64, file.type)
                        onUpdateAvatarSettings({ kind: 'upload', uploadPath: path })
                      }}
                    />
                  </label>
                </div>

                <div className="profile-avatar-colors">
                  {AVATAR_PALETTE.map(color => (
                    <button key={color} type="button"
                      className={`profile-color-swatch ${(avatarSettings?.presetColor ?? '#6B7280') === color ? 'is-active' : ''}`}
                      style={{ backgroundColor: color }}
                      onClick={() => onUpdateAvatarSettings({ kind: 'preset', presetId: avatarSettings?.presetId ?? 'cat', presetColor: color })}
                      aria-label={color}
                    />
                  ))}
                </div>

                <div className="profile-avatar-icons">
                  {Object.entries(AVATAR_PRESETS).slice(0, 12).map(([id, preset]) => (
                    <button key={id} type="button"
                      className={`profile-icon-btn ${avatarSettings?.presetId === id ? 'is-active' : ''}`}
                      onClick={() => onUpdateAvatarSettings({ kind: 'preset', presetId: id, presetColor: avatarSettings?.presetColor ?? '#6B7280' })}
                      title={t(preset.labelKey)}
                    >
                      {renderPreset(id, avatarSettings?.presetColor ?? '#6B7280')}
                    </button>
                  ))}
                </div>

                {(avatarSettings && avatarSettings.kind !== 'initials') && (
                  <button type="button" className="profile-avatar-reset" onClick={() => onUpdateAvatarSettings({ kind: 'initials' })}>
                    <RotateCcw size={11} />
                    {t('settings.avatarReset')}
                  </button>
                )}
              </div>
            )}

            <div className="profile-menu-separator" />
            <button type="button" onClick={() => { onLogout(); setProfileMenuOpen(false) }}>
              <LogOut size={15} />
              {t('sidebar.logout')}
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
          <small className="account-disclaimer">{t('sidebar.devBuild')}</small>
          <span className="account-profile">
            <AvatarIcon settings={avatarSettings} name={profileName} className="account-avatar" />
            <span>
              <strong>{profileName}</strong>
              <small>{profile.plan?.name ?? (cliAuth.loggedIn ? t('sidebar.cliConnected') : profile.status === 'unauthenticated' ? t('sidebar.noApiKey') : t('sidebar.planUnavailable'))}</small>
            </span>
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

function filterConversations(conversations: StoredConversation[], query: string): StoredConversation[] {
  const normalized = query.trim().toLowerCase()
  return conversations
    .filter(conversation => !conversation.archivedAt)
    .filter(conversation => !normalized || conversation.title.toLowerCase().includes(normalized))
}

function displayConversationTitle(title: string, t: (key: string) => string): string {
  return title === DEFAULT_CONVERSATION_TITLE ? t('sidebar.newChat') : title
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

function relativeTime(timestamp: number, t: (key: string, values?: Record<string, string | number | undefined>) => string): string {
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t('sidebar.now')
  if (minutes < 60) return t('sidebar.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('sidebar.hours', { count: hours })
  return t('sidebar.days', { count: Math.floor(hours / 24) })
}

