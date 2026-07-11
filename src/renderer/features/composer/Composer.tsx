import { ArrowUp, Mic, MicOff, Paperclip, Target, X } from 'lucide-react'
import { type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AttachmentMeta, CustomSlashCommand, SkillSummary } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/Toast'
import { QueuePanel } from '../queue/QueuePanel'
import { parseReservedSlashCommand, type ReservedSlashCommand } from './slashCommands'
import {
  getCustomCommandLabel,
  getCustomCommandToken,
  rankCustomCommands,
} from './customSlashCommands'
import { createVoiceInput, composeVoiceAppend, detectSupport, type VoiceInputHandle } from './voiceInput'
import { getAtQuery, removeAtQuery, replaceAtQueryWithToken, rankFiles, extractAtTokens } from './atMention'

// Reserved slash commands surfaced in the "/" palette, exactly like the skills
// below them. Selecting one fills its token so the user can type any arguments.
type SlashCommand = { name: string; description: string }

type SlashMenuItem =
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'skill'; skill: SkillSummary }
  | { kind: 'custom'; command: CustomSlashCommand }

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
  /** Working directory for the @-mention file palette. Falls back to empty
   *  string (no files) when unset / first render before config loads. */
  workingDirectory?: string
  /** User-defined slash commands persisted in `UserSettings.customSlashCommands`. */
  customSlashCommands?: CustomSlashCommand[]
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
  customSlashCommands = [],
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
  workingDirectory = '',
  queue,
  onQueueSendNow,
  onQueueEdit,
  onQueueRemove,
}: ComposerProps) {
  const { t, language } = useI18n()
  const [internalValue, setInternalValue] = useState('')
  const value = externalValue ?? internalValue
  const setValue = onValueChange ?? setInternalValue
  const [highlighted, setHighlighted] = useState(0)
  const [atHighlighted, setAtHighlighted] = useState(0)
  const [dragDepth, setDragDepth] = useState(0)
  const [palettePos, setPalettePos] = useState<{ bottom: number; left: number; width: number } | null>(null)
  const [atLoading, setAtLoading] = useState(false)
  const [voiceListening, setVoiceListening] = useState(false)
  // SpeechRecognition support is captured once at mount — rechecking per
  // render would race with the bridge and could create handle churn.
  const voiceSupported = useMemo(() => detectSupport(), [])
  // Mirror of the latest composer value, kept in sync at every render so
  // the voice-input onFinal closure (created lazily on first toggle and
  // never re-bound) can READ the freshest text without going stale. The
  // appender also WRITES back synchronously after setValue to cover the
  // window where React has not yet committed the new state and a second
  // onFinal can fire in the same task (continuous-mode dictated text).
  const valueRef = useRef(value)
  valueRef.current = value
  const voiceRef = useRef<VoiceInputHandle | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const atMenuRef = useRef<HTMLDivElement>(null)

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
  const matchingCustom = useMemo(() => {
    if (slashQuery === undefined) return []
    return rankCustomCommands(customSlashCommands, slashQuery).slice(0, 8)
  }, [customSlashCommands, slashQuery])
  const menuItems = useMemo<SlashMenuItem[]>(() => [
    ...matchingCommands.map(command => ({ kind: 'command' as const, command })),
    ...matchingSkills.map(skill => ({ kind: 'skill' as const, skill })),
    ...matchingCustom.map(command => ({ kind: 'custom' as const, command })),
  ], [matchingCommands, matchingSkills, matchingCustom])
  const activeIndex = menuItems.length ? Math.min(highlighted, menuItems.length - 1) : 0
  const highlightedValue = useMemo(
    () => renderHighlightedValue(value, skills, slashCommands, customSlashCommands),
    [skills, slashCommands, customSlashCommands, value],
  )
  const goalModeActive = isGoalCommandDraft(value)
  const dropActive = dragDepth > 0

  // ── @-mention file palette ──────────────────────────────────────────────
  const atQuery = getAtQuery(value)
  const [cachedFiles, setCachedFiles] = useState<string[]>([])
  const atSessionRef = useRef(false)

  // Fetch file list on initial @ of each palette session; clear on close.
  useEffect(() => {
    if (atQuery !== undefined && !atSessionRef.current) {
      atSessionRef.current = true
      setCachedFiles([])
      setAtHighlighted(0)
      setAtLoading(true)
      const listFn = (window.verboo as any)?.listWorkspaceFiles
      if (listFn) {
        listFn(workingDirectory || '')
          .then((files: string[]) => setCachedFiles(files))
          .catch(() => setCachedFiles([]))
          .finally(() => setAtLoading(false))
      } else {
        setCachedFiles([])
        setAtLoading(false)
      }
    }
    if (atQuery === undefined) {
      atSessionRef.current = false
      setAtLoading(false)
    }
  }, [atQuery, workingDirectory])
  const matchingFiles = useMemo(() => {
    if (atQuery === undefined) return []
    return rankFiles(cachedFiles, atQuery).slice(0, 8)
  }, [cachedFiles, atQuery])
  const atActiveIndex = matchingFiles.length ? Math.min(atHighlighted, matchingFiles.length - 1) : 0
  const paletteOpen = slashQuery !== undefined || atQuery !== undefined

  // Portal menus ABOVE the composer — `.composer { overflow: hidden }` clips
  // in-flow absolute menus (queue reveal needs that overflow). Same pattern as ModelSelector.
  useLayoutEffect(() => {
    if (!paletteOpen) {
      setPalettePos(null)
      return
    }
    const form = formRef.current
    if (!form) return
    const compute = () => {
      const rect = form.getBoundingClientRect()
      setPalettePos({
        bottom: window.innerHeight - rect.top + 10,
        left: Math.max(8, rect.left),
        width: Math.max(200, rect.width),
      })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [paletteOpen, value, queue?.length])

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
    if (item.kind === 'custom') {
      selectCustomCommand(item.command)
      return
    }
    selectSkill(item.skill)
  }

  function selectCustomCommand(command: CustomSlashCommand) {
    // Replace the /query with the command's body. The renderer takes care
    // of the trailing space when the body doesn't end in whitespace, so the
    // user can keep typing after a sentence-ended template.
    const token = getCustomCommandToken(command)
    const nextValue = replaceSlashQueryWithToken(value, token)
    setValue(nextValue)
    setHighlighted(0)
    textareaRef.current?.focus()
  }

  function selectAtFile(path: string) {
    const nextValue = replaceAtQueryWithToken(value, `@${path} `)
    setValue(nextValue)
    setAtHighlighted(0)
    textareaRef.current?.focus()
  }

  // ── Voice input (Web Speech API, no backend key) ────────────────────────
  // Lazy handle: created on the first toggle so a session never opens the
  // mic until the user explicitly asks for it. Cleanup runs on unmount and
  // whenever the composer is discarded so we never leave the OS mic open.
  // Errors go through the app toast system (useToast) — no inline notice
  // that would squash the toolbar layout.
  const { toast } = useToast()

  /** Map a SpeechRecognition error event to a user-facing i18n message.
   *  Known codes get dedicated copy; unknown codes fall back to the
   *  generic voiceError template with the raw message. */
  function mapVoiceError(info: { message: string; code?: string }): string {
    const code = info.code ?? ''
    const msg = info.message ?? ''
    if (code === 'not-allowed' || code === 'service-not-allowed' || /permission/i.test(msg)) {
      return t('composer.voicePermissionDenied')
    }
    if (code === 'audio-capture') {
      return t('composer.voiceNoMic')
    }
    if (code === 'network') {
      return t('composer.voiceNetworkError')
    }
    if (code === 'no-speech') {
      return t('composer.voiceNoSpeech')
    }
    return t('composer.voiceError', { message: msg || code })
  }

  /** Trigger the OS microphone permission prompt by requesting a short-lived
   *  audio stream. The tracks are stopped immediately — we only need the
   *  side-effect of the OS dialog, not the audio itself. Returns true when
   *  the user has granted access (or already had it), false on denial. */
  async function requestMicPermission(): Promise<boolean> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return true
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(track => track.stop())
      return true
    } catch {
      return false
    }
  }

  function appendVoiceText(text: string) {
    // Always compute against the freshest composer text — appendVoiceText
    // is captured by the lazy voice handle (built once on first toggle),
    // so the React `value` in this closure would otherwise be stale by the
    // second final chunk of a continuous-mode session.
    const base = valueRef.current
    const next = composeVoiceAppend(base, text)
    if (next === base) {
      // Empty/whitespace addition — nothing to do.
      return
    }
    // Sync the ref BEFORE setValue so back-to-back finals concatenate
    // correctly even if React hasn't re-rendered the controlled textarea yet.
    valueRef.current = next
    setValue(next)
    // Keep caret after the inserted text — on the next paint.
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      const end = textarea.value.length
      textarea.selectionStart = end
      textarea.selectionEnd = end
      textarea.focus()
    })
  }

  async function handleVoiceToggle() {
    if (!voiceSupported) {
      toast(t('composer.voiceUnsupported'))
      return
    }
    if (!voiceRef.current) {
      voiceRef.current = createVoiceInput({
        lang: language,
        onFinal: appendVoiceText,
        onStart: () => setVoiceListening(true),
        // onError fires before onEnd on most implementations; reset the
        // listening flag here too so the button doesn't stay stuck in the
        // MicOff state if the error arrives without a subsequent onEnd.
        onError: info => {
          setVoiceListening(false)
          toast(mapVoiceError(info), 'error')
        },
        onEnd: () => setVoiceListening(false),
      })
    }
    if (voiceRef.current.isListening()) {
      voiceRef.current.stop()
      return
    }
    // Trigger the OS mic permission prompt before starting recognition.
    // On macOS WKWebView, SpeechRecognition.start() can fail with
    // "service permission check has failed" if the app hasn't been granted
    // microphone access. getUserMedia forces the OS dialog to appear.
    const granted = await requestMicPermission()
    if (!granted) {
      toast(t('composer.voicePermissionDenied'), 'error')
      return
    }
    voiceRef.current.start()
  }

  // Stop the mic when the composer unmounts; OS permission stays granted
  // for the next mount, but no audio frames keep flowing.
  useEffect(() => () => {
    voiceRef.current?.stop()
  }, [])

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
    // @-palette open: arrows, Enter/Tab, Escape drive the file palette.
    if (atQuery !== undefined && matchingFiles.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setAtHighlighted(index => (index + 1) % matchingFiles.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setAtHighlighted(index => (index - 1 + matchingFiles.length) % matchingFiles.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        selectAtFile(matchingFiles[atActiveIndex] ?? matchingFiles[0])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        updateValue(removeAtQuery(value))
        return
      }
    }

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

  const paletteStyle: CSSProperties | undefined = palettePos
    ? {
        position: 'fixed',
        bottom: `${palettePos.bottom}px`,
        left: `${palettePos.left}px`,
        width: `${palettePos.width}px`,
        right: 'auto',
        top: 'auto',
      }
    : undefined

  return (
    <form
      ref={formRef}
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
      {slashQuery !== undefined && palettePos && createPortal(
        <div
          ref={slashMenuRef}
          className="skills-menu skills-menu-portal popover-panel t-dropdown is-open"
          data-origin="bottom-center"
          style={paletteStyle}
        >
          {menuItems.length === 0 ? (
            <div className="empty-menu">{t('composer.emptyMenu')}</div>
          ) : (
            menuItems.map((item, index) => {
              if (item.kind === 'command') {
                return (
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
                )
              }
              if (item.kind === 'custom') {
                return (
                  <button
                    key={`custom:${item.command.id}`}
                    className={`skill-option ${index === activeIndex ? 'highlighted' : ''}`}
                    type="button"
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => selectMenuItem(item)}
                  >
                    <span className="skill-name">{getCustomCommandLabel(item.command)}</span>
                    <span className="skill-description">{item.command.description}</span>
                    <span className="skill-source custom">{t('composer.custom')}</span>
                  </button>
                )
              }
              return (
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
              )
            })
          )}
        </div>,
        document.body,
      )}
      {atQuery !== undefined && palettePos && createPortal(
        <div
          ref={atMenuRef}
          className="skills-menu skills-menu-portal popover-panel t-dropdown is-open"
          data-origin="bottom-center"
          style={paletteStyle}
        >
          {atLoading ? (
            <div className="empty-menu">{t('composer.fileMenuLoading')}</div>
          ) : matchingFiles.length === 0 ? (
            <div className="empty-menu">{t('composer.emptyFileMenu')}</div>
          ) : (
            matchingFiles.map((file, index) => {
              const basename = file.split('/').pop() ?? file
              return (
                <button
                  key={file}
                  className={`skill-option ${index === atActiveIndex ? 'highlighted' : ''}`}
                  type="button"
                  onMouseEnter={() => setAtHighlighted(index)}
                  onClick={() => selectAtFile(file)}
                >
                  <span className="skill-name">@{basename}</span>
                  <span className="skill-description">{file}</span>
                  <span className="skill-source command">{t('composer.file')}</span>
                </button>
              )
            })
          )}
        </div>,
        document.body,
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
          <button
            className={`composer-icon-button voice-button ${voiceListening ? 'is-listening' : ''}`}
            type="button"
            disabled={!voiceSupported}
            aria-pressed={voiceListening}
            aria-label={voiceListening ? t('composer.voiceStop') : t('composer.voiceStart')}
            title={voiceSupported
              ? (voiceListening ? t('composer.voiceStop') : t('composer.voiceStart'))
              : t('composer.voiceUnsupportedTitle')}
            onClick={handleVoiceToggle}
          >
            {voiceListening ? <MicOff size={17} /> : <Mic size={17} />}
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

function renderHighlightedValue(
  value: string,
  skills: SkillSummary[],
  slashCommands: SlashCommand[],
  customSlashCommands: CustomSlashCommand[] = [],
): ReactNode[] {
  if (!value) return []
  const knownNames = new Set([
    ...skills.map(skill => skill.name.toLowerCase()),
    ...slashCommands.map(command => command.name.toLowerCase()),
    ...customSlashCommands.map(command => command.name.toLowerCase()),
  ])
  const parts: ReactNode[] = []
  let cursor = 0

  // Match both /slash tokens and @file tokens in a single pass.
  // Group 1 = /slash name, Group 2 = @file path.
  for (const match of value.matchAll(/(?:^|\s)(?:\/([A-Za-z0-9_:-]+)|@([^\s]+))/g)) {
    const start = match.index ?? 0
    const text = match[0]
    const leadingSpace = text.startsWith(' ') ? ' ' : ''
    const token = leadingSpace ? text.slice(1) : text
    if (start > cursor) parts.push(value.slice(cursor, start))
    if (leadingSpace) parts.push(leadingSpace)

    const slashName = match[1]
    const atPath = match[2]
    const isKnown = slashName ? knownNames.has(slashName.toLowerCase()) : false
    // @-path tokens are always highlighted (file references).
    const shouldHighlight = isKnown || atPath !== undefined

    parts.push(
      <span key={`${start}:${token}`} className={shouldHighlight ? 'composer-skill-token' : undefined}>
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
