import { Check, CheckCircle2, ChevronDown, ChevronRight, Clipboard, Clock3, FileSearch, FileText, GitBranch, Image as ImageIcon, LoaderCircle, Pencil, Search, SendHorizontal, Terminal, Wrench } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TranscriptItem, WorkspaceChangeEntry, WorkspaceReviewMetadata } from '../../shared/types'
import { MarkdownMessage } from '../features/transcript/MarkdownMessage'
import { StepFlow } from '../features/transcript/StepFlow'
import { ThinkingIcon } from '../features/transcript/TranscriptIcons'
import { useI18n, type Translator } from '../i18n'

type TranscriptProps = {
  items: TranscriptItem[]
  conversationId?: string
  onOpenReview?: (files: WorkspaceChangeEntry[], index: number) => void
  reviewMetadata?: WorkspaceReviewMetadata
  thinkingTurnId?: string
  thinkingSnippets?: string[]
  compactingTurnId?: string
  imageReadingTurnId?: string
  onSendNow?: (conversationId: string, queueItemId: string) => void
  onInterject?: (conversationId: string, queueItemId: string) => void
  onEditQueued?: (queueItemId: string, newText: string) => void
  onEditSent?: (conversationId: string, itemId: string, newText: string) => void
}

const MAX_ACTIVITY_DETAIL_LINES = 8
const MAX_SUMMARY_DETAIL_LINES = 3

export const Transcript = memo(function Transcript({ items, onOpenReview, reviewMetadata, thinkingTurnId, thinkingSnippets, compactingTurnId, imageReadingTurnId, conversationId, onSendNow, onInterject, onEditQueued, onEditSent }: TranscriptProps) {
  // `items` is a new array reference only when the conversation actually changes,
  // so this recomputes on real content changes but is skipped when the parent
  // re-renders for unrelated reasons (context-usage ticks, subagent updates…).
  const visibleItems = useMemo(() => buildTranscriptEntries(items), [items])

  return (
    <div className="transcript">
      {visibleItems.map(entry => (
        entry.kind === 'assistant-turn'
          ? <TurnView
              key={entry.turnId}
              entry={entry}
              thinking={thinkingTurnId === entry.turnId}
              thinkingSnippets={thinkingSnippets}
              compacting={compactingTurnId === entry.turnId}
              readingImage={imageReadingTurnId === entry.turnId}
              onOpenReview={onOpenReview}
              reviewMetadata={reviewMetadata}
            />
          : <MessageArticle key={entry.item.id} item={entry.item} conversationId={conversationId} onSendNow={onSendNow} onInterject={onInterject} onCopy={() => {}} onEditQueued={onEditQueued} onEditSent={onEditSent} />
      ))}
    </div>
  )
})

type TranscriptEntry =
  | { kind: 'message'; item: TranscriptItem }
  | { kind: 'assistant-turn'; turnId: string; items: TranscriptItem[]; summary?: TranscriptItem }

// Rotates through real model thinking snippets every ~4s, like ChatGPT.
// New snippets are appended to the end; the timer cycles through them in
// order. No reset-to-latest — that would skip earlier thoughts.
function ThinkingRotator({ snippets }: { snippets: string[] }) {
  const [index, setIndex] = useState(0)
  // Clamp index when snippets shrink (turn ended/cleared) so we never read
  // out of bounds. When new snippets arrive, the index stays where it is so
  // the user can finish reading the current one before rotation continues.
  useEffect(() => {
    if (snippets.length === 0) return
    if (index >= snippets.length) setIndex(snippets.length - 1)
  }, [snippets.length, index])
  useEffect(() => {
    if (snippets.length <= 1) return
    const timer = setInterval(() => {
      setIndex(prev => (prev + 1) % snippets.length)
    }, 4000)
    return () => clearInterval(timer)
  }, [snippets.length])
  const text = snippets[index] ?? snippets[snippets.length - 1] ?? ''
  return (
    <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm thinking-snippet" title={text}>
      {text}
    </span>
  )
}

function TurnView({ entry, thinking, thinkingSnippets, compacting, readingImage, onOpenReview, reviewMetadata }: {
  entry: Extract<TranscriptEntry, { kind: 'assistant-turn' }>
  thinking: boolean
  thinkingSnippets?: string[]
  compacting: boolean
  readingImage: boolean
  onOpenReview?: TranscriptProps['onOpenReview']
  reviewMetadata?: WorkspaceReviewMetadata
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const streaming = entry.items.some(item => item.streaming)
  const textItems = entry.items.filter(item => item.role === 'assistant' && item.text.trim().length > 0)
  const hasText = textItems.length > 0
  // The collapsed summary is the model's own final message (natural language),
  // not an app-generated action count. When expanded, the full flow already
  // includes this text as its last block, so the standalone recap is hidden.
  const finalText = hasText ? textItems[textItems.length - 1].text : ''
  const modelItem = entry.items.find(item => item.role === 'assistant' && item.modelDisplayName)
  const label = modelItem?.modelDisplayName ? `Verboo - ${modelItem.modelDisplayName}` : 'Verboo'
  const summary = entry.summary
  const showFlow = streaming || expanded
  return (
    <article className="message-row assistant turn-view">
      {/* No "generating" badge here: while streaming, the thinking marker and
          the active action row below already signal progress — two indicators
          side-by-side read as noise. */}
      <div className="message-meta">
        <span>{label}</span>
        {compacting && (
          <span className="message-status-marker compaction-marker" role="status">
            <span className="message-status-marker-icon" aria-hidden="true">
              <LoaderCircle size={12} />
            </span>
            <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm" data-text={t('transcript.compacting')}>
              {t('transcript.compacting')}
            </span>
          </span>
        )}
      </div>

      {!streaming && entry.items.length > 0 && (
        <button type="button" className="turn-collapsed" onClick={() => setExpanded(value => !value)}>
          <ChevronRight size={14} className={expanded ? 'is-open' : ''} />
          <span>{summary?.text ?? t('transcript.worked')}</span>
        </button>
      )}

      {thinking && !hasText && (
        <div className={`step-thinking ${readingImage ? 'is-reading-image' : ''}`} role="status">
          <span className="step-marker-icon" aria-hidden="true">
            {readingImage ? <ImageIcon size={14} strokeWidth={1.8} /> : <ThinkingIcon />}
          </span>
          {readingImage ? (
            <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm">
              {t('transcript.imageReading')}
            </span>
          ) : thinkingSnippets && thinkingSnippets.length > 0 ? (
            <ThinkingRotator snippets={thinkingSnippets} />
          ) : (
            <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm">
              {t('transcript.thinking')}
            </span>
          )}
        </div>
      )}

      {showFlow && <StepFlow items={entry.items} streaming={streaming} />}

      {!streaming && !expanded && finalText && (
        <div className="step-text turn-recap"><MarkdownMessage text={finalText} /></div>
      )}

      {!streaming && summary?.changeSummary?.totalFiles ? (
        <section className="turn-completion-summary" aria-label={t('transcript.turnSummary')}>
          <ChangeSummaryCard summary={summary.changeSummary} onOpenReview={onOpenReview} reviewMetadata={reviewMetadata} />
        </section>
      ) : null}
    </article>
  )
}

export type MessageArticleProps = {
  item: TranscriptItem
  conversationId?: string
  children?: ReactNode
  onSendNow?: (conversationId: string, queueItemId: string) => void
  onInterject?: TranscriptProps['onInterject']
  onCopy?: (text: string) => void
  onEditQueued?: (queueItemId: string, newText: string) => void
  onEditSent?: (conversationId: string, itemId: string, newText: string) => void
}

const MessageArticle = memo(function MessageArticle({ item, conversationId, onSendNow, onInterject, onCopy, onEditQueued, onEditSent, children }: MessageArticleProps) {
  const { t } = useI18n()
  const visibleText = visibleTextForItem(item)
  const [editMode, setEditMode] = useState(false)
  const [editText, setEditText] = useState(visibleText)
  const [copyFlash, setCopyFlash] = useState(false)
  // Extract queue item id from queued activity markers (stored as `${id}:queued`).
  const queueItemId = item.activityKind === 'queued' && item.id.endsWith(':queued')
    ? item.id.slice(0, -':queued'.length)
    : undefined
  const isQueued = Boolean(queueItemId)
  const isUserMessage = item.role === 'user' && item.kind !== 'activity' && item.kind !== 'summary'

  function handleCopy() {
    const text = visibleText || item.text
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopyFlash(true)
      setTimeout(() => setCopyFlash(false), 1200)
    }).catch(() => {})
  }

  function handleSaveEdit() {
    const newText = editText.trim()
    if (!newText) return
    if (isQueued && queueItemId && onEditQueued) {
      onEditQueued(queueItemId, newText)
    } else if (isUserMessage && conversationId && onEditSent) {
      onEditSent(conversationId, item.id, newText)
    }
    setEditMode(false)
  }

  // Inline edit UI
  if (editMode) {
    return (
      <article className={`message-row ${item.role} ${item.kind ?? 'message'}`} data-activity={item.activityKind}>
        <div className="message-meta"><span>{isQueued ? t('transcript.editQueued') : t('transcript.editMessage')}</span></div>
        <textarea className="message-edit-textarea" value={editText} onChange={e => setEditText(e.target.value)} autoFocus />
        <div className="message-edit-actions">
          <button type="button" className="queued-action-inline save" onClick={handleSaveEdit} disabled={!editText.trim()}>{t('common.save')}</button>
          <button type="button" className="queued-action-inline cancel" onClick={() => setEditMode(false)}>{t('common.cancel')}</button>
        </div>
        {children}
      </article>
    )
  }

  return (
    <article
      className={`message-row ${item.role} ${item.kind ?? 'message'}`}
      data-activity={item.activityKind}
      data-command={isInitialGoalUserItem(item) ? 'goal' : undefined}
    >
      <div className="message-meta">
        {item.kind === 'activity' && <ActivityIcon item={item} />}
        {item.kind === 'summary' && <CheckCircle2 size={14} strokeWidth={1.8} />}
        <span>{labelForItem(item, t)}</span>
        {item.streaming && (
          <span className="message-status-marker" role="status">
            <span className="message-status-marker-icon" aria-hidden="true"><LoaderCircle size={12} /></span>
            <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm" data-text={t('transcript.generating')}>{t('transcript.generating')}</span>
          </span>
        )}
      </div>

      {item.attachments?.length ? (
        <div className="message-attachments">
          {item.attachments.map(att => {
            const isImage = att.kind === 'image'
            return (
              <button key={att.path} type="button" className={`message-attachment-chip ${isImage ? 'message-attachment-image' : 'message-attachment-file'}`}
                onClick={() => window.verboo?.openExternalFile?.('', att.path)} title={att.path}>
                {isImage ? <img src={window.verboo?.fileUrl?.(att.path) ?? ''} alt="" className="message-attachment-thumb" loading="lazy" />
                  : <span className="message-attachment-icon" aria-hidden="true"><FileText size={14} /></span>}
                <span className="message-attachment-name">{att.name}</span>
              </button>
            )
          })}
        </div>
      ) : null}

      {item.skills && item.skills.length > 0 && (
        <div className="message-skills">{item.skills.map(s => <span key={s.id}>/{s.name}</span>)}</div>
      )}

      <div className={`message-text ${item.streaming ? 'streaming-text' : ''}`}>
        {item.kind === 'summary' && item.activityDetail ? item.activityDetail
          : visibleText ? <MarkdownMessage text={visibleText} />
          : item.streaming ? t('transcript.thinking') : ''}
        {item.kind !== 'summary' && item.activityDetail && <span className="message-detail">{item.activityDetail}</span>}
      </div>

      {/* ── Action icons ──────────────────────────────────── */}
      {(isUserMessage || isQueued) && !item.streaming && (
        <div className="message-actions">
          {isQueued && onSendNow && conversationId && queueItemId && (
            <button type="button" className="msg-action" onClick={() => onSendNow(conversationId, queueItemId)} title={t('transcript.sendNow')}>
              <SendHorizontal size={14} />
            </button>
          )}
          {/* Manter na fila — clock icon shows the item is waiting */}
          {isQueued && (
            <span className="msg-action msg-action-indicator" title={t('transcript.queuedWaiting')}>
              <Clock3 size={14} />
            </span>
          )}
          <button type="button" className="msg-action" onClick={handleCopy} title={t('transcript.copyText')}>
            {copyFlash ? <Check size={14} /> : <Clipboard size={14} />}
          </button>
          <button type="button" className="msg-action" onClick={() => { setEditText(visibleText || item.text); setEditMode(true) }} title={t('transcript.editMessage')}>
            <Pencil size={14} />
          </button>
        </div>
      )}

      {children}
    </article>
  )
})

function visibleTextForItem(item: TranscriptItem): string {
  if (isInitialGoalUserItem(item)) return visibleInitialGoalCommand(item.text)
  return item.text
}

function isInitialGoalUserItem(item: TranscriptItem): boolean {
  return item.role === 'user' && item.id.startsWith('user:goal:')
}

function isInternalGoalContinuationItem(item: TranscriptItem): boolean {
  return item.role === 'user' && item.id.startsWith('user:goal-continue:')
}

function visibleInitialGoalCommand(text: string): string {
  const goalLine = text.match(/^## Goal:\s*(.+)$/m)
  if (goalLine?.[1]) return `/goal ${goalLine[1].trim()}`
  return text.trim().startsWith('/goal') ? text.trim() : `/goal ${text.trim()}`
}

function ActivityPanel({ activities, summary }: { activities: TranscriptItem[]; summary?: TranscriptItem }) {
  const { t } = useI18n()
  if (activities.length === 0 && !summary) return null
  const detailLines = activityDetailLines(activities, summary, t)
  const primaryActivity = activities.find(item => item.activityKind !== 'thinking') ?? activities[0]
  const title = summary?.text ?? activityPanelTitle(activities, summary, t)

  return (
    <details className="turn-activity-panel">
      <summary>
        <span className="turn-activity-label">
          {primaryActivity ? <ActivityIcon item={primaryActivity} /> : <CheckCircle2 size={14} strokeWidth={1.8} />}
          {title}
        </span>
        <ChevronDown className="turn-activity-chevron" size={14} strokeWidth={1.9} />
      </summary>
      {detailLines.length > 0 && (
        <div className="turn-activity-details">
          {detailLines.map((line, index) => (
            <div key={`${index}:${line}`}>{line}</div>
          ))}
        </div>
      )}
    </details>
  )
}

function CompletionSummary({ summary, onOpenReview, reviewMetadata }: { summary: TranscriptItem; onOpenReview?: TranscriptProps['onOpenReview']; reviewMetadata?: WorkspaceReviewMetadata }) {
  const { t } = useI18n()
  const lines = summary.activityDetail
    ?.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    ?? []

  if (lines.length === 0 && !summary.changeSummary?.totalFiles) return null

  return (
    <section className="turn-completion-summary" aria-label={t('transcript.turnSummary')}>
      <div className="turn-completion-header">
        <CheckCircle2 size={14} strokeWidth={1.8} />
        <span>{summary.text}</span>
      </div>
      {lines.length > 0 && (
        <div className="turn-completion-lines">
          {lines.map(line => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {summary.changeSummary?.totalFiles ? <ChangeSummaryCard summary={summary.changeSummary} onOpenReview={onOpenReview} reviewMetadata={reviewMetadata} /> : null}
    </section>
  )
}

function changeSummaryTitle(summary: NonNullable<TranscriptItem['changeSummary']>, metadata: WorkspaceReviewMetadata | undefined, t: Translator): string {
  if (metadata?.scope === 'github-repo') return t('transcript.uncommittedChanges')
  if (metadata?.scope === 'git-repo') return t('transcript.repoChanges')
  return `${summary.totalFiles} ${summary.totalFiles === 1 ? t('transcript.fileWithChange') : t('transcript.filesWithChanges')}`
}

function changeSummarySubtitle(summary: NonNullable<TranscriptItem['changeSummary']>, metadata: WorkspaceReviewMetadata | undefined, t: Translator): string {
  if (metadata?.scope === 'github-repo' || metadata?.scope === 'git-repo') {
    return `${summary.totalFiles} ${summary.totalFiles === 1 ? t('transcript.fileWithChange') : t('transcript.filesWithChanges')}`
  }
  return t('transcript.localProject')
}

function ChangeSummaryCard({ summary, onOpenReview, reviewMetadata }: { summary: NonNullable<TranscriptItem['changeSummary']>; onOpenReview?: TranscriptProps['onOpenReview']; reviewMetadata?: WorkspaceReviewMetadata }) {
  const { t } = useI18n()
  const visibleFiles = summary.files.slice(0, 3)
  const hiddenCount = Math.max(0, summary.totalFiles - visibleFiles.length)
  const canOpenReview = Boolean(onOpenReview && reviewMetadata?.capabilities.canDiff !== false)

  const handleClickFile = (index: number) => {
    if (!canOpenReview) return
    onOpenReview?.(summary.files, index)
  }

  return (
    <div className="change-summary-card">
      <div className="change-summary-card-header"
        role={canOpenReview ? 'button' : undefined}
        tabIndex={canOpenReview ? 0 : undefined}
        title={canOpenReview ? t('transcript.review') : ''}
        onClick={() => handleClickFile(0)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClickFile(0) } }}
      >
        <span>
          {changeSummaryTitle(summary, reviewMetadata, t)}
          <small>{changeSummarySubtitle(summary, reviewMetadata, t)}</small>
        </span>
        <span className="change-summary-totals">
          <span className="added">+{summary.additions}</span>
          <span className="deleted">-{summary.deletions}</span>
        </span>
      </div>
      <div className="change-summary-files">
        {visibleFiles.map((file, index) => (
          <button
            key={file.path}
            type="button"
            className="change-summary-file"
            disabled={!canOpenReview}
            onClick={() => handleClickFile(index)}
            title={file.path}
          >
            <span>{compactPath(file.path)}</span>
            <span className="change-summary-totals">
              <span className="added">+{file.additions}</span>
              <span className="deleted">-{file.deletions}</span>
            </span>
          </button>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            className="change-summary-more"
            disabled={!canOpenReview}
            onClick={() => handleClickFile(visibleFiles.length)}
          >{t('transcript.showMoreFiles', { count: hiddenCount, files: hiddenCount === 1 ? t('transcript.fileSingular') : t('transcript.filePlural') })}</button>
        )}
      </div>
    </div>
  )
}

function ActivityIcon({ item }: { item: TranscriptItem }) {
  if (item.activityKind === 'read') return <FileText size={14} strokeWidth={1.8} />
  if (item.activityKind === 'edit') return <Pencil size={14} strokeWidth={1.8} />
  if (item.activityKind === 'search') return <Search size={14} strokeWidth={1.8} />
  if (item.activityKind === 'command') return <Terminal size={14} strokeWidth={1.8} />
  if (item.activityKind === 'terminal') return <Terminal size={14} strokeWidth={1.8} />
  if (item.activityKind === 'image') return <ImageIcon size={14} strokeWidth={1.8} />
  if (item.activityKind === 'thinking') return <Clock3 size={14} strokeWidth={1.8} />
  if (item.activityKind === 'permission') return <FileSearch size={14} strokeWidth={1.8} />
  if (item.activityKind === 'subagent') return <GitBranch size={14} strokeWidth={1.8} />
  return <Wrench size={14} strokeWidth={1.8} />
}

function turnIdFromText(item: TranscriptItem): string | undefined {
  return item.id.match(/^(.*):text:\d+$/)?.[1]
}

// The turn an item belongs to. Assistant text now streams as `turnId:text:N`
// segments; legacy persisted turns used a bare `turnId` assistant item, so fall
// back to the id itself for backward compatibility.
function turnIdOf(item: TranscriptItem): string | undefined {
  if (item.kind === 'activity') return turnIdFromActivity(item) ?? turnIdFromThinking(item)
  if (item.kind === 'summary') return turnIdFromSummary(item)
  if (item.role === 'assistant') return turnIdFromText(item) ?? item.id
  return undefined
}

function buildTranscriptEntries(items: TranscriptItem[]): TranscriptEntry[] {
  const turns = new Map<string, { turnId: string; items: TranscriptItem[]; summary?: TranscriptItem }>()
  for (const item of items) {
    const turnId = turnIdOf(item)
    if (!turnId) continue
    let turn = turns.get(turnId)
    if (!turn) { turn = { turnId, items: [], summary: undefined }; turns.set(turnId, turn) }
    if (item.kind === 'summary') turn.summary = item
    else turn.items.push(item)
  }

  const emitted = new Set<string>()
  const entries: TranscriptEntry[] = []
  for (const item of items) {
    if (item.role === 'system' && item.kind !== 'summary') continue
    if (isInternalGoalContinuationItem(item)) continue
    const turnId = turnIdOf(item)
    if (turnId && turns.has(turnId)) {
      if (emitted.has(turnId)) continue
      emitted.add(turnId)
      const turn = turns.get(turnId)!
      entries.push({ kind: 'assistant-turn', turnId, items: turn.items, summary: turn.summary })
      continue
    }
    entries.push({ kind: 'message', item })
  }

  return entries
}

function labelForItem(item: TranscriptItem, t: Translator): string {
  if (item.kind === 'activity') return item.text
  if (item.kind === 'summary') return item.text
  if (item.role === 'assistant') {
    return item.modelDisplayName ? `Verboo - ${item.modelDisplayName}` : 'Verboo'
  }
  if (item.role === 'tool') return t('transcript.tool')
  if (item.role === 'system') return t('transcript.system')
  return t('transcript.you')
}

function turnIdFromActivity(item: TranscriptItem): string | undefined {
  return item.id.match(/^(.*):activity:\d+$/)?.[1]
}

function turnIdFromThinking(item: TranscriptItem): string | undefined {
  return item.id.match(/^(.*):thinking$/)?.[1]
}

function turnIdFromSummary(item: TranscriptItem): string | undefined {
  return item.id.match(/^(.*):summary$/)?.[1]
}

function activityPanelTitle(activities: TranscriptItem[], summary: TranscriptItem | undefined, t: Translator): string {
  const counts = countActivities(activities)
  const parts = [
    formatCount(counts.image, t('transcript.imageOne'), t('transcript.imageMany')),
    formatCount(counts.read, t('transcript.readOne'), t('transcript.readMany')),
    formatCount(counts.edit, t('transcript.editOne'), t('transcript.editMany')),
    formatCount(counts.search, t('transcript.searchOne'), t('transcript.searchMany')),
    formatCount(counts.command, t('transcript.commandOne'), t('transcript.commandMany')),
    formatCount(counts.terminal, t('transcript.terminalOne'), t('transcript.terminalMany')),
    formatCount(counts.subagent, t('transcript.subagentOne'), t('transcript.subagentMany')),
    formatCount(counts.permission, t('transcript.permissionOne'), t('transcript.permissionMany')),
    formatCount(counts.tool, t('transcript.toolOne'), t('transcript.toolMany')),
  ].filter((part): part is string => Boolean(part))

  if (parts.length > 0) return joinParts(parts, t)
  return summary?.text ?? t('transcript.agentActivity')
}

function activityDetailLines(activities: TranscriptItem[], summary: TranscriptItem | undefined, t: Translator): string[] {
  const title = activityPanelTitle(activities, summary, t)
  const seen = new Set<string>()
  const activityLines: string[] = []

  for (const item of activities) {
    if (item.activityKind === 'thinking' || !item.activityDetail) continue
    const line = `${item.text}: ${item.activityDetail}`
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    activityLines.push(line)
  }

  const hiddenCount = Math.max(0, activityLines.length - MAX_ACTIVITY_DETAIL_LINES)
  const visibleActivityLines = activityLines.slice(0, MAX_ACTIVITY_DETAIL_LINES)
  if (hiddenCount > 0) {
    visibleActivityLines.push(t('transcript.hiddenActions', { count: hiddenCount }))
  }

  const summaryLines = summary?.activityDetail
    ?.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith(t('transcript.summaryPrefix')) && line !== t('transcript.stopReason', { reason: 'end_turn' }))
    .slice(0, MAX_SUMMARY_DETAIL_LINES)
    ?? []

  return [
    ...(title ? [title] : []),
    ...visibleActivityLines,
    ...summaryLines,
  ]
}

function countActivities(activities: TranscriptItem[]): Partial<Record<NonNullable<TranscriptItem['activityKind']>, number>> {
  return activities.reduce<Partial<Record<NonNullable<TranscriptItem['activityKind']>, number>>>((counts, item) => {
    if (!item.activityKind || item.activityKind === 'thinking') return counts
    if (!item.activityDetail && item.activityKind !== 'permission' && item.activityKind !== 'subagent' && item.activityKind !== 'image') return counts
    counts[item.activityKind] = (counts[item.activityKind] ?? 0) + 1
    return counts
  }, {})
}

function formatCount(count: number | undefined, singular: string, plural: string): string | undefined {
  if (!count) return undefined
  if (singular === plural) return count > 1 ? `${plural} ${count}x` : singular
  return count === 1 ? singular : `${plural} (${count})`
}

function joinParts(parts: string[], t: Translator): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} ${t('transcript.and')} ${parts[parts.length - 1]}`
}

function compactPath(path: string): string {
  if (path.length <= 58) return path
  return `...${path.slice(-55)}`
}
