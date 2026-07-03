import { ArrowUp, Paperclip, Target, X } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentMeta, SkillSummary } from '../../../shared/types'
import { parseReservedSlashCommand, type ReservedSlashCommand } from './slashCommands'

// Reserved slash commands surfaced in the "/" palette, exactly like the skills
// below them. Selecting one fills its token so the user can type any arguments.
type SlashCommand = { name: string; description: string }

const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'goal',
    description: 'Defina um objetivo e o Verboo trabalha em ciclos autônomos até concluí-lo.',
  },
]

type SlashMenuItem =
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'skill'; skill: SkillSummary }

type ComposerProps = {
  disabled: boolean
  busy?: boolean
  skills: SkillSummary[]
  selectedSkills: SkillSummary[]
  attachments: AttachmentMeta[]
  onSelectedSkillsChange: (skills: SkillSummary[]) => void
  onAttachFiles: () => void
  onRemoveAttachment: (path: string) => void
  onSubmit: (message: string) => void
  onGoalCommand: (command: Extract<ReservedSlashCommand, { kind: 'goal' }>) => void
  leftToolbar: ReactNode
  centerToolbar?: ReactNode
  rightToolbar: ReactNode
}

export function Composer({
  disabled,
  busy = false,
  skills,
  selectedSkills,
  attachments,
  onSelectedSkillsChange,
  onAttachFiles,
  onRemoveAttachment,
  onSubmit,
  onGoalCommand,
  leftToolbar,
  centerToolbar,
  rightToolbar,
}: ComposerProps) {
  const [value, setValue] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const slashQuery = getSlashQuery(value)
  const matchingCommands = useMemo(() => {
    if (slashQuery === undefined) return []
    return SLASH_COMMANDS.filter(command => matchesSlashCommand(command, slashQuery))
  }, [slashQuery])
  const matchingSkills = useMemo(() => {
    if (slashQuery === undefined) return []
    return rankSkills(skills, slashQuery).slice(0, 8)
  }, [skills, slashQuery])
  const menuItems = useMemo<SlashMenuItem[]>(() => [
    ...matchingCommands.map(command => ({ kind: 'command' as const, command })),
    ...matchingSkills.map(skill => ({ kind: 'skill' as const, skill })),
  ], [matchingCommands, matchingSkills])
  const activeIndex = menuItems.length ? Math.min(highlighted, menuItems.length - 1) : 0
  const highlightedValue = useMemo(
    () => renderHighlightedValue(value, skills),
    [skills, value],
  )
  const goalModeActive = isGoalCommandDraft(value)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [value])

  function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return

    const reserved = parseReservedSlashCommand(trimmed)
    if (reserved?.kind === 'goal') {
      onGoalCommand(reserved)
      setValue('')
      return
    }

    const message = stripSelectedSkillTokens(trimmed, selectedSkills).trim()
    if (!message) return

    onSubmit(message)
    setValue('')
    onSelectedSkillsChange([])
  }

  function selectMenuItem(item: SlashMenuItem) {
    if (item.kind === 'command') {
      selectCommand(item.command)
      return
    }
    selectSkill(item.skill)
  }

  function selectCommand(command: SlashCommand) {
    // Fill "/goal " and keep focus so the user can type the objective. The
    // command runs on Enter once the menu has closed (see submit()).
    const nextValue = replaceSlashQueryWithToken(value, `/${command.name} `)
    setValue(nextValue)
    setHighlighted(0)
    textareaRef.current?.focus()
  }

  function selectSkill(skill: SkillSummary) {
    const nextValue = replaceSlashQueryWithToken(value, `/${skill.name} `)
    setValue(nextValue)
    syncSelectedSkills(nextValue)
    setHighlighted(0)
  }

  function updateValue(nextValue: string) {
    setValue(nextValue)
    syncSelectedSkills(nextValue)
  }

  function syncSelectedSkills(nextValue: string) {
    const nextSkillNames = extractSkillTokenNames(nextValue)
    const nextSkills = skills.filter(skill => nextSkillNames.has(skill.name.toLowerCase()))
    if (sameSkillIds(nextSkills, selectedSkills)) return
    onSelectedSkillsChange(nextSkills)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // While the "/" palette is open, the arrows/Enter/Escape drive it.
    if (slashQuery !== undefined && menuItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlighted(index => (index + 1) % menuItems.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlighted(index => (index - 1 + menuItems.length) % menuItems.length)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        selectMenuItem(menuItems[activeIndex] ?? menuItems[0])
        return
      }
      if (event.key === 'Escape') {
        updateValue(removeSlashQuery(value))
        return
      }
    }

    // Palette closed: Enter submits — submit() runs reserved commands like /goal.
    if (event.key === 'Enter' && !event.shiftKey) {
      submit(event)
    }
  }

  return (
    <form className="composer" data-command-mode={goalModeActive ? 'goal' : undefined} onSubmit={submit}>
      {slashQuery !== undefined && (
        <div className="skills-menu popover-panel t-dropdown is-open" data-origin="bottom-center">
          {menuItems.length === 0 ? (
            <div className="empty-menu">Nenhum comando ou habilidade encontrado.</div>
          ) : (
            menuItems.map((item, index) =>
              item.kind === 'command' ? (
                <button
                  key={`command:${item.command.name}`}
                  className={`skill-option ${index === activeIndex ? 'highlighted' : ''}`}
                  type="button"
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => selectMenuItem(item)}
                >
                  <span className="skill-name">/{item.command.name}</span>
                  <span className="skill-description">{item.command.description}</span>
                  <span className="skill-source command">comando</span>
                </button>
              ) : (
                <button
                  key={`skill:${item.skill.id}`}
                  className={`skill-option ${index === activeIndex ? 'highlighted' : ''}`}
                  type="button"
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => selectMenuItem(item)}
                >
                  <span className="skill-name">/{item.skill.name}</span>
                  <span className="skill-description">{item.skill.description}</span>
                  <span className={`skill-source ${item.skill.trusted ? '' : 'untrusted'}`}>
                    {item.skill.source}
                  </span>
                </button>
              ),
            )
          )}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="selected-skills">
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

      {goalModeActive && (
        <div className="composer-goal-mode" aria-label="Comando goal ativo">
          <Target size={13} />
          <span>/goal</span>
        </div>
      )}

      <div className="composer-text-wrap">
        <div ref={highlightRef} className="composer-highlight" aria-hidden="true">
          {highlightedValue}
          {value.endsWith('\n') ? '\u00a0' : null}
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          disabled={disabled}
          onChange={event => updateValue(event.target.value)}
          onKeyDown={handleKeyDown}
          onScroll={event => {
            if (highlightRef.current) highlightRef.current.scrollTop = event.currentTarget.scrollTop
          }}
          placeholder={busy ? 'Digite uma mensagem para entrar na fila' : 'Peça ao Verboo ou digite / para usar habilidades'}
          rows={1}
        />
      </div>

      <div className="composer-toolbar">
        <div className="composer-tools left">
          <button className="composer-icon-button" type="button" title="Anexar arquivo" onClick={onAttachFiles}>
            <Paperclip size={17} />
          </button>
          {leftToolbar}
        </div>
        {centerToolbar && <div className="composer-tools center">{centerToolbar}</div>}
        <div className="composer-tools right">
          {rightToolbar}
          <button
            className="send-button"
            type="submit"
            disabled={disabled || !value.trim()}
            title={busy ? 'Adicionar à fila' : 'Enviar'}
          >
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

function isGoalCommandDraft(value: string): boolean {
  return /^\s*\/goal(?:\s|$)/.test(value)
}

function removeSlashQuery(value: string): string {
  return value.replace(/(?:^|\s)\/([A-Za-z0-9_-]*)$/, match => (match.startsWith(' ') ? ' ' : '')).trimStart()
}

function replaceSlashQueryWithToken(value: string, token: string): string {
  if (getSlashQuery(value) === undefined) return `${value}${value.endsWith(' ') || !value ? '' : ' '}${token}`
  return value.replace(/(?:^|\s)\/([A-Za-z0-9_-]*)$/, match => {
    const prefix = match.startsWith(' ') ? ' ' : ''
    return `${prefix}${token}`
  })
}

function matchesSlashCommand(command: SlashCommand, query: string): boolean {
  if (!query) return true
  const normalized = query.toLowerCase()
  return (
    command.name.toLowerCase().includes(normalized) ||
    command.description.toLowerCase().includes(normalized) ||
    fuzzyMatch(command.name.toLowerCase(), normalized)
  )
}

function extractSkillTokenNames(value: string): Set<string> {
  const names = new Set<string>()
  for (const match of value.matchAll(/(?:^|\s)\/([A-Za-z0-9_-]+)/g)) {
    names.add(match[1].toLowerCase())
  }
  return names
}

function stripSelectedSkillTokens(value: string, selectedSkills: SkillSummary[]): string {
  if (!selectedSkills.length) return value
  const selectedNames = new Set(selectedSkills.map(skill => skill.name.toLowerCase()))
  return value
    .replace(/(?:^|\s)\/([A-Za-z0-9_-]+)/g, (match, name: string) => (
      selectedNames.has(name.toLowerCase()) ? (match.startsWith(' ') ? ' ' : '') : match
    ))
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function sameSkillIds(left: SkillSummary[], right: SkillSummary[]): boolean {
  if (left.length !== right.length) return false
  const rightIds = new Set(right.map(skill => skill.id))
  return left.every(skill => rightIds.has(skill.id))
}

function renderHighlightedValue(value: string, skills: SkillSummary[]): ReactNode[] {
  if (!value) return []
  const knownNames = new Set([
    ...skills.map(skill => skill.name.toLowerCase()),
    ...SLASH_COMMANDS.map(command => command.name.toLowerCase()),
  ])
  const parts: ReactNode[] = []
  let cursor = 0

  for (const match of value.matchAll(/(?:^|\s)\/([A-Za-z0-9_-]+)/g)) {
    const start = match.index ?? 0
    const text = match[0]
    const leadingSpace = text.startsWith(' ') ? ' ' : ''
    const token = leadingSpace ? text.slice(1) : text
    if (start > cursor) parts.push(value.slice(cursor, start))
    if (leadingSpace) parts.push(leadingSpace)
    parts.push(
      <span key={`${start}:${token}`} className={knownNames.has(match[1].toLowerCase()) ? 'composer-skill-token' : undefined}>
        {token}
      </span>,
    )
    cursor = start + text.length
  }

  if (cursor < value.length) parts.push(value.slice(cursor))
  return parts
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
