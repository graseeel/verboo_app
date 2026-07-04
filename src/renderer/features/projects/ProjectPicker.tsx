import { Check, FolderClosed, FolderPlus, Plus, Search, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { ChatProject } from '../../../shared/types'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { useI18n } from '../../i18n'

type ProjectPickerProps = {
  projects: ChatProject[]
  selectedProjectId?: string
  onSelectProject: (projectId: string) => void
  onClearProject: () => void
  onUseExistingFolder: () => Promise<void> | void
  onCreateProject: () => Promise<void> | void
}

export function ProjectPicker({
  projects,
  selectedProjectId,
  onSelectProject,
  onClearProject,
  onUseExistingFolder,
  onCreateProject,
}: ProjectPickerProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const selected = projects.find(project => project.id === selectedProjectId)
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return projects.slice(0, 8)
    return projects
      .filter(project => project.name.toLowerCase().includes(normalized) || project.path?.toLowerCase().includes(normalized))
      .slice(0, 8)
  }, [projects, query])
  useOutsideDismiss(wrapRef, open, () => {
    setOpen(false)
    setCreateOpen(false)
  })

  return (
    <div className="project-picker" ref={wrapRef}>
      <button className="project-pill" type="button" onClick={() => setOpen(value => !value)}>
        <FolderClosed size={15} />
        <span>{selected?.name ?? t('project.none')}</span>
      </button>

      {open && (
        <div className="project-picker-menu popover-panel t-dropdown is-open" data-origin="top-left">
          <label className="project-search">
            <Search size={14} />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              autoFocus
              placeholder={t('project.search')}
            />
          </label>

          <div className="project-picker-list">
            {filtered.map(project => (
              <button
                key={project.id}
                className="project-choice"
                type="button"
                onClick={() => {
                  onSelectProject(project.id)
                  setOpen(false)
                }}
              >
                <FolderClosed size={14} />
                <span>{project.name}</span>
                {project.id === selectedProjectId && <Check size={14} />}
              </button>
            ))}
            {filtered.length === 0 && <div className="project-empty">{t('project.noneRecent')}</div>}
          </div>

          <div className="project-picker-actions">
            <button className="project-action" type="button" onClick={() => setCreateOpen(value => !value)}>
              <Plus size={15} />
              <span>{t('project.new')}</span>
            </button>
            <button
              className="project-action"
              type="button"
              onClick={() => {
                onClearProject()
                setOpen(false)
              }}
            >
              <X size={15} />
              <span>{t('project.withoutProject')}</span>
            </button>
          </div>

          {createOpen && (
            <div className="project-create-menu popover-panel t-dropdown is-open" data-origin="top-left">
              <button
                type="button"
                onClick={() => {
                  void onCreateProject()
                  setOpen(false)
                }}
              >
                <FolderPlus size={15} />
                {t('project.startEmpty')}
              </button>
              <button
                type="button"
                onClick={() => {
                  void onUseExistingFolder()
                  setOpen(false)
                }}
              >
                <FolderClosed size={15} />
                {t('project.useFolder')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
