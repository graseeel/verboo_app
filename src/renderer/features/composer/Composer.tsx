import { ArrowUp, Paperclip, X } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, type ReactNode, useMemo, useState } from 'react'
import type { AttachmentMeta, SkillSummary } from '../../../shared/types'

type ComposerProps = {
  disabled: boolean
  skills: SkillSummary[]
  selectedSkills: SkillSummary[]
  attachments: AttachmentMeta[]
  onSelectedSkillsChange: (skills: SkillSummary[]) => void
  onAttachFiles: () => void
  onRemoveAttachment: (path: string) => void
  onSubmit: (message: string) => void
  onPetCommand: (command: string) => void
  leftToolbar: ReactNode
  rightToolbar: ReactNode
}

export function Composer({
  disabled,
  skills,
  selectedSkills,
  attachments,
  onSelectedSkillsChange,
  onAttachFiles,
  onRemoveAttachment,
  onSubmit,
  onPetCommand,
  leftToolbar,
  rightToolbar,
}: ComposerProps) {
  const [value, setValue] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const slashQuery = getSlashQuery(value)
  const matchingSkills = useMemo(() => {
    if (slashQuery === undefined) return []
    return rankSkills(skills, slashQuery).slice(0, 8)
  }, [skills, slashQuery])

  function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    if (trimmed.startsWith('/pet')) {
      onPetCommand(trimmed)
      setValue('')
      return
    }
    onSubmit(trimmed)
    setValue('')
  }

  function selectSkill(skill: SkillSummary) {
    if (!selectedSkills.some(item => item.id === skill.id)) {
      onSelectedSkillsChange([...selectedSkills, skill])
    }
    setValue(removeSlashQuery(value))
    setHighlighted(0)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && value.trim().startsWith('/pet')) {
      submit(event)
      return
    }

    if (slashQuery !== undefined && matchingSkills.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlighted(index => (index + 1) % matchingSkills.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlighted(index => (index - 1 + matchingSkills.length) % matchingSkills.length)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        selectSkill(matchingSkills[highlighted] ?? matchingSkills[0])
        return
      }
      if (event.key === 'Escape') {
        setValue(removeSlashQuery(value))
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      submit(event)
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      {slashQuery !== undefined && (
        <div className="skills-menu popover-panel t-dropdown is-open" data-origin="bottom-center">
          <div className="popover-title">Skills</div>
          {matchingSkills.length === 0 ? (
            <div className="empty-menu">Nenhuma skill encontrada.</div>
          ) : (
            matchingSkills.map((skill, index) => (
              <button
                key={skill.id}
                className={`skill-option ${index === highlighted ? 'highlighted' : ''}`}
                type="button"
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => selectSkill(skill)}
              >
                <span className="skill-name">/{skill.name}</span>
                <span className="skill-description">{skill.description}</span>
                <span className={`skill-source ${skill.trusted ? '' : 'untrusted'}`}>
                  {skill.source}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {(selectedSkills.length > 0 || attachments.length > 0) && (
        <div className="selected-skills">
          {selectedSkills.map(skill => (
            <button
              key={skill.id}
              className="skill-chip"
              type="button"
              onClick={() => onSelectedSkillsChange(selectedSkills.filter(item => item.id !== skill.id))}
              title={skill.description}
            >
              /{skill.name}
              <X size={12} />
            </button>
          ))}
          {attachments.map(attachment => (
            <button
              key={attachment.path}
              className="skill-chip attachment-chip"
              type="button"
              onClick={() => onRemoveAttachment(attachment.path)}
              title={attachment.path}
            >
              {attachment.name}
              <X size={12} />
            </button>
          ))}
        </div>
      )}

      <textarea
        value={value}
        disabled={disabled}
        onChange={event => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Peça ao Verboo ou digite / para usar skills"
        rows={2}
      />

      <div className="composer-toolbar">
        <div className="composer-tools left">
          <button className="composer-icon-button" type="button" title="Anexar arquivo" onClick={onAttachFiles}>
            <Paperclip size={17} />
          </button>
          {leftToolbar}
        </div>
        <div className="composer-tools right">
          {rightToolbar}
          <button className="send-button" type="submit" disabled={disabled || !value.trim()}>
            <ArrowUp size={17} />
          </button>
        </div>
      </div>
    </form>
  )
}

function getSlashQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/)
  return match ? match[1] : undefined
}

function removeSlashQuery(value: string): string {
  return value.replace(/(?:^|\s)\/([A-Za-z0-9_-]*)$/, match => (match.startsWith(' ') ? ' ' : '')).trimStart()
}

function rankSkills(skills: SkillSummary[], query: string): SkillSummary[] {
  const normalizedQuery = query.toLowerCase()
  return skills
    .map(skill => {
      const name = skill.name.toLowerCase()
      const description = skill.description.toLowerCase()
      const score =
        name === normalizedQuery ? 0 :
        name.startsWith(normalizedQuery) ? 1 :
        name.includes(normalizedQuery) ? 2 :
        description.includes(normalizedQuery) ? 3 :
        fuzzyMatch(name, normalizedQuery) || fuzzyMatch(description, normalizedQuery) ? 4 :
        99
      return { skill, score }
    })
    .filter(item => item.score < 99)
    .sort((a, b) => a.score - b.score || a.skill.name.localeCompare(b.skill.name))
    .map(item => item.skill)
}

function fuzzyMatch(value: string, query: string): boolean {
  if (!query) return true
  let index = 0
  for (const char of value) {
    if (char === query[index]) index += 1
    if (index === query.length) return true
  }
  return false
}
