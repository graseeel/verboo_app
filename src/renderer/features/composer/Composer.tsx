import { ArrowUp, Mic, MicOff, Paperclip, Target, X } from 'lucide-react'
import { type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AttachmentMeta, CustomSlashCommand, SkillSummary } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/Toast'
import { QueuePanel } from '../queue/QueuePanel'
import { parseReservedSlashCommand, parseGoalCommand, type ReservedSlashCommand } from './slashCommands'
import {
  getCustomCommandLabel,
  getCustomCommandToken,
  rankCustomCommands,
} from './customSlashCommands'
import { applyVoiceInterim, commitVoiceFinal, createVoiceInput, detectSupport, nextCatchUpStep, type VoiceInputHandle } from './voiceInput'
import { getAtQuery, removeAtQuery, replaceAtQueryWithToken, rankSkills } from './atMention'
import { PluginIcon } from '../plugins/PluginCard'

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
  /** Skills derived from / and @ tokens in text — managed by syncTokenSkills. */
  tokenSkills: SkillSummary[]
  onTokenSkillsChange: (skills: SkillSummary[]) => void
  attachments: AttachmentMeta[]
  ocrProcessingPaths?: string[]
  onAttachFiles: () => void
  onDropFiles: (paths: string[], files: File[]) => void
  onRemoveAttachment: (path: string) => void
  onSubmit: (message: string) => void
  onPasteFiles: (paths: string[], files: File[]) => void
  onGoalCommand: (command: Extract<ReservedSlashCommand, { kind: 'goal' }>) => void
  onPetCommand: () => void
  onCompactCommand: (command: Extract<ReservedSlashCommand, { kind: 'compact' }>) => void
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
  tokenSkills,
  onTokenSkillsChange,
  attachments,
  ocrProcessingPaths = [],
  customSlashCommands = [],
  onAttachFiles,
  onDropFiles,
  onRemoveAttachment,
  onSubmit,
  onPasteFiles,
  onGoalCommand,
  onPetCommand,
  onCompactCommand,
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
  // Two independent drag models: HTML5 events nest (a child's dragenter fires
  // dragleave on its parent) so they need a depth counter; Tauri's native
  // events are window-level state, so they get a plain flag.
  const [dragDepth, setDragDepth] = useState(0)
  const [nativeDragging, setNativeDragging] = useState(false)
  const [palettePos, setPalettePos] = useState<{ bottom: number; left: number; width: number } | null>(null)
  const [voiceListening, setVoiceListening] = useState(false)
  const [composing, setComposing] = useState(false)
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
  // Voice session state: `voiceCommittedRef` is the stable base text
  // captured at session start + all committed finals. `voiceInterimRef`
  // is the current interim text (for display only). The textarea shows
  // `applyVoiceInterim(committed, interim)` while listening; on final,
  // the interim is replaced by the final and committed. On stop/end,
  // residual interim is committed so the user sees what they said.
  const voiceCommittedRef = useRef('')
  const voiceInterimRef = useRef('')
  // Catch-up typewriter: rAF loop that moves chars per frame so interim
  // text appears fluidly rather than freezing the whole block. The loop
  // is interruptible (cancelled + restarted on each new interim/final).
  const catchUpRafId = useRef<number | undefined>(undefined)
  const catchUpTargetRef = useRef('')
  // Check once at mount — reduced-motion users snap directly without rAF.
  const reduceMotion = useRef(
    typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
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
      // 'over' repeats for every pointer move, so this must stay a flag: a
      // counter would climb with each move and the single 'leave' emitted on
      // abort could never bring it back to zero, pinning the overlay open.
      if (detail.type === 'enter' || detail.type === 'over') {
        setNativeDragging(true)
      } else if (detail.type === 'leave') {
        setNativeDragging(false)
      } else if (detail.type === 'drop') {
        setNativeDragging(false)
        if (!disabled && detail.paths.length) {
          onDropFiles(detail.paths, [])
        }
      }
    }
    window.addEventListener('verboo:drag-event', onTauriDrag)
    return () => window.removeEventListener('verboo:drag-event', onTauriDrag)
  }, [disabled, onDropFiles])

  // Focus the composer textarea on request — used by "Testar agora" in the
  // plugins view to seed a prompt and focus the input without sending.
  useEffect(() => {
    function onFocusRequest() {
      textareaRef.current?.focus()
      // Move caret to end so seeded text is appended-after, not mid-string.
      const ta = textareaRef.current
      if (ta) {
        const end = ta.value.length
        ta.setSelectionRange(end, end)
      }
    }
    window.addEventListener('verboo:focus-composer', onFocusRequest)
    return () => window.removeEventListener('verboo:focus-composer', onFocusRequest)
  }, [])
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
    {
      name: 'compact',
      description: t('composer.compactDescription'),
    },
  ], [t])
  const matchingCommands = useMemo(() => {
    if (slashQuery === undefined) return []
    return slashCommands.filter(command => matchesSlashCommand(command, slashQuery))
  }, [slashCommands, slashQuery])
  const matchingSkills = useMemo(() => {
    if (slashQuery === undefined) return []
    return rankSkills(skills, slashQuery)
  }, [skills, slashQuery])
  const matchingCustom = useMemo(() => {
    if (slashQuery === undefined) return []
    return rankCustomCommands(customSlashCommands, slashQuery)
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
  const dropActive = dragDepth > 0 || nativeDragging

  // ── @-mention skill palette ─────────────────────────────────────────────
  const atQuery = getAtQuery(value)

  const matchingAtSkills = useMemo(() => {
    if (atQuery === undefined) return []
    return rankSkills(skills, atQuery)
  }, [skills, atQuery])
  const atActiveIndex = matchingAtSkills.length ? Math.min(atHighlighted, matchingAtSkills.length - 1) : 0
  const paletteOpen = slashQuery !== undefined || atQuery !== undefined

  // Scroll the highlighted item into view on keyboard nav (D.3) — applies
  // to both the @ skill palette and the / command/skill palette.
  useEffect(() => {
    atMenuRef.current?.querySelector('.highlighted')?.scrollIntoView({ block: 'nearest' })
  }, [atHighlighted, atActiveIndex])
  useEffect(() => {
    slashMenuRef.current?.querySelector('.highlighted')?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, activeIndex])

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
    if (reserved?.kind === 'compact') {
      onCompactCommand(reserved)
      setValue('')
      return
    }

    // No-slash goal command: `goal implement X` (without leading /) is
    // treated as a goal start. This lets users invoke goal mode without
    // remembering the slash prefix. Any other text falls through to
    // normal chat.
    const noSlashGoal = parseGoalCommand(trimmed)
    if (noSlashGoal?.kind === 'goal') {
      onGoalCommand(noSlashGoal)
      setValue('')
      return
    }

    onSubmit(trimmed)
    setValue('')
    onTokenSkillsChange([])
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

  function selectAtSkill(skill: SkillSummary) {
    const nextValue = replaceAtQueryWithToken(value, `@${skill.name} `)
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

  function stopCatchUp() {
    if (catchUpRafId.current !== undefined) {
      cancelAnimationFrame(catchUpRafId.current)
      catchUpRafId.current = undefined
    }
  }

  function startCatchUp(target: string) {
    catchUpTargetRef.current = target
    if (reduceMotion.current) {
      // Reduced-motion preference: snap to target without animation.
      valueRef.current = target
      setValue(target)
      return
    }
    function tick() {
      const current = valueRef.current
      const step = nextCatchUpStep(current, catchUpTargetRef.current)
      if (step !== current) {
        valueRef.current = step
        setValue(step)
      }
      if (step !== catchUpTargetRef.current) {
        catchUpRafId.current = requestAnimationFrame(tick)
      } else {
        catchUpRafId.current = undefined
        // Position caret at the end once we've caught up.
        const textarea = textareaRef.current
        if (textarea) {
          const end = textarea.value.length
          textarea.selectionStart = end
          textarea.selectionEnd = end
        }
      }
    }
    catchUpRafId.current = requestAnimationFrame(tick)
  }

  function appendVoiceText(text: string) {
    // A final chunk arrived. Commit to the base and set the catch-up target
    // to the committed value (replacing any interim that was on display).
    // NOTE: we do NOT reset valueRef here — the textarea still shows the
    // previous interim text. The rAF loop in startCatchUp will fill chars
    // from the displayed value toward the committed target. If the target
    // is shorter (final has fewer chars than the interim), gap ≤ 0 triggers
    // a snap on the first tick.
    stopCatchUp()
    voiceCommittedRef.current = commitVoiceFinal(voiceCommittedRef.current, text)
    voiceInterimRef.current = ''
    startCatchUp(voiceCommittedRef.current)
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
        onInterim: text => {
          // Display only: show committed + interim in the textarea WITHOUT
          // committing the interim to voiceCommittedRef. The next final
          // (or the residual-interim commit on end) will replace it.
          // Uses the catch-up typewriter for a fluid reveal instead of a
          // frozen block-swap (which looked like a stutter).
          stopCatchUp()
          voiceInterimRef.current = text
          const display = applyVoiceInterim(voiceCommittedRef.current, text)
          startCatchUp(display)
        },
        onStart: () => setVoiceListening(true),
        onError: info => {
          // no-speech is normal with continuous+auto-restart — skip toast
          // and don't reset listening (auto-restart handles it transparently).
          if (info.code === 'no-speech') return
          setVoiceListening(false)
          toast(mapVoiceError(info), 'error')
        },
        onEnd: () => {
          // Commit residual interim so the user sees what they said even
          // if the session ended mid-phrase. Stop the catch-up first so
          // the snap-to-target happens immediately.
          stopCatchUp()
          if (voiceInterimRef.current) {
            voiceCommittedRef.current = commitVoiceFinal(voiceCommittedRef.current, voiceInterimRef.current)
            voiceInterimRef.current = ''
            valueRef.current = voiceCommittedRef.current
            setValue(voiceCommittedRef.current)
          }
          setVoiceListening(false)
        },
      })
    }
    if (voiceRef.current.isListening()) {
      voiceRef.current.stop()
      return
    }
    // Capture the committed base at session start. All finals/interims
    // build on top of this; the user's pre-existing text is preserved.
    // NOTE: if the user types manually while listening, the dictation
    // owns the tail — manual edits during interim will be overwritten
    // by the next interim/final. Stop dictation before typing manually.
    voiceCommittedRef.current = valueRef.current
    voiceInterimRef.current = ''
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
    syncTokenSkills(nextValue)
    setHighlighted(0)
  }

  function updateValue(nextValue: string) {
    setValue(nextValue)
    syncTokenSkills(nextValue)
  }

  function syncTokenSkills(nextValue: string) {
    const nextSkillNames = extractSkillTokenNames(nextValue)
    const atSkillNames = extractAtSkillNames(nextValue, skills)
    const combined = new Set([...nextSkillNames, ...atSkillNames])
    const nextSkills = skills.filter(skill => combined.has(skill.name.toLowerCase()))
    if (sameSkillIds(nextSkills, tokenSkills)) return
    onTokenSkillsChange(nextSkills)
  }

  function extractAtSkillNames(value: string, mentionable: SkillSummary[]): Set<string> {
    const names = new Set<string>()
    const known = new Map(mentionable.map(s => [s.name.toLowerCase(), s]))
    for (const match of value.matchAll(/(?:^|\s)@([A-Za-z0-9_.:-]+)/g)) {
      const tokenName = match[1].toLowerCase()
      if (known.has(tokenName)) names.add(tokenName)
    }
    return names
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // @-palette open: arrows, Enter/Tab, Escape drive the skill palette.
    if (atQuery !== undefined && matchingAtSkills.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setAtHighlighted(prev => (prev + 1) % matchingAtSkills.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setAtHighlighted(prev => (prev - 1 + matchingAtSkills.length) % matchingAtSkills.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        selectAtSkill(matchingAtSkills[atActiveIndex] ?? matchingAtSkills[0])
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
        setHighlighted(prev => (prev + 1) % menuItems.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlighted(prev => (prev - 1 + menuItems.length) % menuItems.length)
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
          {matchingAtSkills.length === 0 ? (
            <div className="empty-menu">{t('composer.emptyPluginMenu')}</div>
          ) : (
            matchingAtSkills.map((skill, index) => (
              <button
                key={skill.id}
                className={`skill-option ${index === atActiveIndex ? 'highlighted' : ''}`}
                type="button"
                onMouseEnter={() => setAtHighlighted(index)}
                onClick={() => selectAtSkill(skill)}
              >
                <span className="skill-name">@{skill.name}</span>
                <span className="skill-description">{skill.description}</span>
                <span className={`skill-source ${skill.trusted ? '' : 'untrusted'}`}>
                  {skill.pluginName ?? skill.source}
                </span>
              </button>
            ))
          )}
        </div>,
        document.body,
      )}

      {attachments.length > 0 && (
        <div className="selected-skills">
          {attachments.map(attachment => {
            const isImage = attachment.kind === 'image'
            const isVideo = attachment.kind === 'video'
            const status = attachment.extractionStatus
            const isOcrProcessing = ocrProcessingPaths.includes(attachment.path)
            // No extractionStatus + no extractedText + not image → definitively
            // unreadable (backends that don't set extractionStatus yet).
            const isUnreadable = !isImage && !isVideo && !attachment.extractedText && !status && !isOcrProcessing
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
                {isVideo && (
                  <span className="attachment-badge attachment-badge-video">
                    {formatVideoAttachment(attachment)}
                  </span>
                )}
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

      <div className={`composer-text-wrap${composing ? ' is-composing' : ''}`}>
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
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          placeholder={busy ? t('composer.placeholder.busy') : t('composer.placeholder.idle')}
          rows={1}
          data-voice-listening={voiceListening || undefined}
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

function formatVideoAttachment(attachment: AttachmentMeta): string {
  const seconds = Math.ceil((attachment.video?.durationMs ?? 0) / 1000)
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const size = attachment.size >= 1024 * 1024
    ? `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(attachment.size / 1024)} KB`
  return `${duration} · ${size}`
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

function fuzzyMatch(value: string, query: string): boolean {
  if (!query) return true
  let index = 0
  for (const char of value) {
    if (char === query[index]) index += 1
    if (index === query.length) return true
  }
  return false
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

  // Match both /skill tokens and @skill tokens (Feedback-3 ITEM 2c).
  // @tokens matching a known skill name render with accent + PluginIcon
  // (when the skill originates from a plugin); unmatched @ are plain text.
  for (const match of value.matchAll(/(?:^|\s)(?:\/([A-Za-z0-9_:-]+)|@([A-Za-z0-9_.:-]+))/g)) {
    const start = match.index ?? 0
    const text = match[0]
    const leadingSpace = text.startsWith(' ') ? ' ' : ''
    const token = leadingSpace ? text.slice(1) : text
    if (start > cursor) parts.push(value.slice(cursor, start))
    if (leadingSpace) parts.push(leadingSpace)

    const slashName = match[1]
    const atName = match[2]
    const skillName = slashName ?? atName
    const isKnown = knownNames.has(skillName.toLowerCase())

    if (isKnown && atName) {
      // @token: distinction is COLOR only (accent-strong) — no font-weight or
      // any metric-changing property, so the overlay's painted text has
      // identical glyph widths to the textarea (caret stays pixel-perfect).
      // The @ glyph stays in the inline flow (preserves its width) but is
      // hidden via color:transparent (NOT opacity:0 — opacity would hide the
      // icon child too). The PluginIcon is an absolute child of the glyph
      // box, pinned to its right edge with a 2px gap → icon's right border
      // sits 2px before the first letter of the name, overflowing left into
      // the composer's padding (no clip).
      const skill = skills.find(s => s.name.toLowerCase() === atName.toLowerCase())
      const atGlyph = token.startsWith('@') ? token[0] : ''
      const tokenText = atGlyph ? token.slice(1) : token
      parts.push(
        <span key={`${start}:${token}`} className="composer-skill-token">
          <span className="at-glyph">
            {atGlyph}
            {skill?.pluginId && (
              <span className="at-icon-deco" aria-hidden="true">
                <PluginIcon name={skill.pluginName ?? skill.name} id={skill.pluginId} size={16} loadIcons />
              </span>
            )}
          </span>
          {tokenText}
        </span>,
      )
    } else if (isKnown && slashName) {
      parts.push(
        <span key={`${start}:${token}`} className="composer-skill-token">{token}</span>,
      )
    } else {
      parts.push(<span key={`${start}:${token}`}>{token}</span>)
    }
    cursor = start + text.length
  }

  if (cursor < value.length) parts.push(value.slice(cursor))
  return parts
}
