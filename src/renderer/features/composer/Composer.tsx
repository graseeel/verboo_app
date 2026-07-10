import { ArrowUp, Paperclip, Target, X } from 'lucide-react'
import { type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentMeta, SkillSummary } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { QueuePanel } from '../queue/QueuePanel'
import { parseReservedSlashCommand, type ReservedSlashCommand } from './slashCommands'

// Reserved slash commands surfaced in the "/" palette, exactly like the skills
// below them. Selecting one fills its token so the user can type any arguments.
type SlashCommand = { name: string; description: string }

type SlashMenuItem =
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'skill'; skill: SkillSummary }

type ComposerProps = {
  disabled: boolean
  busy?: boolean
  /** Controlled value — if provided, the component uses this as its text value */
  value?: string
  /** Controlled onChange — required when value is provided */
  onValueChange?: (value: string) => void
  skills: SkillSummary[]
  selectedSkills: SkillSummary[]
  attachments: AttachmentMeta[]
  ocrProcessingPaths?: string[]
  onSelectedSkillsChange: (skills: SkillSummary[]) => void
  onAttachFiles: () => void
  onDropFiles: (paths: string[], files: File[]) => void
  onRemoveAttachment: (path: string) => void
  onSubmit: (message: string) => void
  onPasteFiles: (paths: string[], files: File[]) => void
  onGoalCommand: (command: Extract<ReservedSlashCommand, { kind: 'goal' }>) => void
  onPetCommand: () => void
  leftToolbar: ReactNode
  centerToolbar?: ReactNode
  rightToolbar: ReactNode
  /** Queued follow-ups awaiting to be sent to the model */
  queue?: { id: string; message: string }[]
  onQueueSendNow?: (queueItemId: string) => void
  onQueueEdit?: (queueItemId: string, newText: string) => void
  onQueueRemove?: (queueItemId: string) => void
}

export function Composer({
  disabled,
  busy = false,
  value: externalValue,
  onValueChange,
  skills,
  selectedSkills,
  attachments,
  ocrProcessingPaths = [],
  onSelectedSkillsChange,
  onAttachFiles,
  onDropFiles,
  onRemoveAttachment,
  onSubmit,
  onPasteFiles,
  onGoalCommand,
  onPetCommand,
  leftToolbar,
  centerToolbar,
  rightToolbar,
  queue,
  onQueueSendNow,
  onQueueEdit,
  onQueueRemove,
}: ComposerProps) {
  const { t } = useI18n()
  const [internalValue, setInternalValue] = useState('')
  const value = externalValue ?? internalValue
  const setValue = onValueChange ?? setInternalValue
  const [highlighted, setHighlighted] = useState(0)
  const [dragDepth, setDragDepth] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Tauri native drag-drop: the webview fires 'enter'/'over'/'drop'/'leave'
  // via onDragDropEvent (not HTML5 events) for Finder→app drops. The bridge
  // relays them as DOM CustomEvents so this effect controls the overlay.
  useEffect(() => {
    function onTauriDrag(e: Event) {
      const detail = (e as CustomEvent).detail as { type: string; paths: string[] }
      if (detail.type === 'enter' || detail.type === 'over') {
        setDragDepth(d => d + 1)
      } else if (detail.type === 'leave') {
        setDragDepth(d => Math.max(0, d - 1))
      } else if (detail.type === 'drop') {
        setDragDepth(0)
        if (!disabled && detail.paths.length) {
          onDropFiles(detail.paths, [])
        }
      }
    }
    window.addEventListener('verboo:drag-event', onTauriDrag)
    return () => window.removeEventListener('verboo:drag-event', onTauriDrag)
  }, [disabled, onDropFiles])
  const highlightRef = useRef<HTMLDivElement>(null)
  const slashQuery = getSlashQuery(value)
  const slashCommands = useMemo<SlashCommand[]>(() => [
    {
      name: 'goal',
      description: t('composer.goalDescription'),
    },
    {
      name: 'pet',
      description: t('composer.petDescription'),
    },
  ], [t])
  const matchingCommands = useMemo(() => {
    if (slashQuery === undefined) return []
    return slashCommands.filter(command => matchesSlashCommand(command, slashQuery))
  }, [slashCommands, slashQuery])
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
    () => renderHighlightedValue(value, skills, slashCommands),
    [skills, slashCommands, value],
  )
  const goalModeActive = isGoalCommandDraft(value)
  const dropActive = dragDepth > 0

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
    if (reserved?.kind === 'pet') {
      onPetCommand()
      setValue('')
      return
    }

    onSubmit(trimmed)
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

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    // Files pasted from Finder appear in clipboardData.files with real paths.
    const files = Array.from(event.clipboardData.files)
    const paths = files
      .map(f => (f as File & { path?: string }).path)
      .filter((p): p is string => Boolean(p))
    if (paths.length || files.length) onPasteFiles(paths, files)
  }

  function handleDragEnter(event: DragEvent<HTMLFormElement>) {
    if (!dragEventHasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setDragDepth(depth => depth + 1)
  }

  function handleDragOver(event: DragEvent<HTMLFormElement>) {
    if (!dragEventHasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  function handleDragLeave(event: DragEvent<HTMLFormElement>) {
    if (!dragEventHasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    setDragDepth(depth => Math.max(0, depth - 1))
  }

  function handleDrop(event: DragEvent<HTMLFormElement>) {
    if (!dragEventHasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    setDragDepth(0)
    if (disabled) return

    const paths = getDroppedFilePaths(event.dataTransfer)
    const files = Array.from(event.dataTransfer.files)
    if (paths.length || files.length) onDropFiles(paths, files)
  }

  return (
    <form
      className="composer"
      data-command-mode={goalModeActive ? 'goal' : undefined}
      data-drop-active={dropActive ? 'true' : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onSubmit={submit}
    >
      {/* Queue lives INSIDE the composer shell so it is always exactly the
          composer's size; the reveal wrapper animates it growing out of the
          composer's top edge. */}
      {queue && queue.length > 0 && (
        <div className="queue-reveal">
          <div className="queue-reveal-inner">
            <QueuePanel
              items={queue}
              conversationId={queue[0]?.id}
              onSendNow={(_, id) => onQueueSendNow?.(id)}
              onEditQueued={onQueueEdit ?? (() => {})}
              onRemoveItem={id => onQueueRemove?.(id)}
            />
          </div>
        </div>
      )}
      {dropActive && (
        <div className="composer-drop-overlay" aria-hidden="true">
          <span className="composer-drop-icon"><Paperclip size={18} /></span>
          <strong>{t('composer.dropTitle')}</strong>
          <small>{t('composer.dropBody')}</small>
        </div>
      )}
      {slashQuery !== undefined && (
        <div className="skills-menu popover-panel t-dropdown is-open" data-origin="bottom-center">
          {menuItems.length === 0 ? (
            <div className="empty-menu">{t('composer.emptyMenu')}</div>
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
                  <span className="skill-source command">{t('composer.command')}</span>
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
          {attachments.map(attachment => {
            const isImage = attachment.kind === 'image'
            const status = attachment.extractionStatus
            const isOcrProcessing = ocrProcessingPaths.includes(attachment.path)
            // No extractionStatus + no extractedText + not image → definitively
            // unreadable (backends that don't set extractionStatus yet).
            const isUnreadable = !isImage && !attachment.extractedText && !status && !isOcrProcessing
            // extractionStatus 'extracted' or legacy extractedText → content is real.
            const isExtracted = status === 'extracted' || (!status && Boolean(attachment.extractedText))
            // extractionStatus 'warning' → Ezio found the file but couldn't
            // read it (scanned/corrupt/too-large); extractedText holds a warning.
            const isWarning = status === 'warning' && !isOcrProcessing
            return (
              <button
                key={attachment.path}
                className={`skill-chip attachment-chip${isUnreadable ? ' attachment-unreadable' : ''}${isWarning ? ' attachment-warning' : ''}${isOcrProcessing ? ' attachment-ocr' : ''}${isImage ? ' attachment-image' : ''}`}
                type="button"
                onClick={() => onRemoveAttachment(attachment.path)}
                title={
                  isUnreadable ? `${attachment.path}\n${t('composer.attachmentUnreadable')}` :
                  isWarning ? `${attachment.path}\n${t('composer.attachmentWarningStatus')}` :
                  isOcrProcessing ? `${attachment.path}\n${t('ocr.processing')}` :
                  attachment.path
                }
              >
                {attachment.name}
                {isOcrProcessing && (
                  <span className="attachment-badge attachment-badge-ocr">{t('ocr.processing')}</span>
                )}
                {isUnreadable && (
                  <span className="attachment-badge attachment-badge-warn">{t('composer.attachmentUnreadable')}</span>
                )}
                {isWarning && (
                  <span className="attachment-badge attachment-badge-amber">{t('composer.attachmentWarningStatus')}</span>
                )}
                {isExtracted && (
                  <span className="attachment-badge attachment-badge-ok">
                    {isImage ? t('ocr.extracted') : t('composer.attachmentTextExtracted')}
                  </span>
                )}
                <X size={12} />
              </button>
            )
          })}
        </div>
      )}

      {goalModeActive && (
        <div className="composer-goal-mode" aria-label={t('composer.goalActive')}>
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
          onPaste={handlePaste}
          onScroll={event => {
            if (highlightRef.current) highlightRef.current.scrollTop = event.currentTarget.scrollTop
          }}
          placeholder={busy ? t('composer.placeholder.busy') : t('composer.placeholder.idle')}
          rows={1}
        />
      </div>

      <div className="composer-toolbar">
        <div className="composer-tools left">
          <button className="composer-icon-button" type="button" title={t('composer.attachFile')} onClick={onAttachFiles}>
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
            title={busy ? t('composer.queue') : t('composer.send')}
          >
            <ArrowUp size={17} />
          </button>
        </div>
      </div>
    </form>
  )
}

function dragEventHasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

function getDroppedFilePaths(dataTransfer: DataTransfer): string[] {
  const paths = Array.from(dataTransfer.files)
    .map(file => (file as File & { path?: string }).path)
    .filter((path): path is string => Boolean(path))

  if (paths.length) return Array.from(new Set(paths))

  const uriList = dataTransfer.getData('text/uri-list')
  if (!uriList) return []

  return Array.from(new Set(uriList
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      try {
        const url = new URL(line)
        return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : undefined
      } catch {
        return undefined
      }
    })
    .filter((path): path is string => Boolean(path))))
}

function getSlashQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)\/([A-Za-z0-9_:-]*)$/)
  return match ? match[1] : undefined
}

function isGoalCommandDraft(value: string): boolean {
  return /^\s*\/goal(?:\s|$)/.test(value)
}

function removeSlashQuery(value: string): string {
  return value.replace(/(?:^|\s)\/([A-Za-z0-9_:-]*)$/, match => (match.startsWith(' ') ? ' ' : '')).trimStart()
}

function replaceSlashQueryWithToken(value: string, token: string): string {
  if (getSlashQuery(value) === undefined) return `${value}${value.endsWith(' ') || !value ? '' : ' '}${token}`
  return value.replace(/(?:^|\s)\/([A-Za-z0-9_:-]*)$/, match => {
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
  for (const match of value.matchAll(/(?:^|\s)\/([A-Za-z0-9_:-]+)/g)) {
    names.add(match[1].toLowerCase())
  }
  return names
}

function sameSkillIds(left: SkillSummary[], right: SkillSummary[]): boolean {
  if (left.length !== right.length) return false
  const rightIds = new Set(right.map(skill => skill.id))
  return left.every(skill => rightIds.has(skill.id))
}

function renderHighlightedValue(value: string, skills: SkillSummary[], slashCommands: SlashCommand[]): ReactNode[] {
  if (!value) return []
  const knownNames = new Set([
    ...skills.map(skill => skill.name.toLowerCase()),
    ...slashCommands.map(command => command.name.toLowerCase()),
  ])
  const parts: ReactNode[] = []
  let cursor = 0

  for (const match of value.matchAll(/(?:^|\s)\/([A-Za-z0-9_:-]+)/g)) {
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
