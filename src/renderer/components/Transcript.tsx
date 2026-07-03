import { CheckCircle2, ChevronDown, ChevronRight, Clock3, FileSearch, FileText, GitBranch, LoaderCircle, Pencil, Search, Terminal, Wrench } from 'lucide-react'
import { memo, useMemo, useState, type ReactNode } from 'react'
import type { TranscriptItem, WorkspaceChangeEntry, WorkspaceReviewMetadata } from '../../shared/types'
import { StepFlow } from '../features/transcript/StepFlow'
import { ThinkingIcon } from '../features/transcript/TranscriptIcons'

type TranscriptProps = {
  items: TranscriptItem[]
  onOpenReview?: (files: WorkspaceChangeEntry[], index: number) => void
  reviewMetadata?: WorkspaceReviewMetadata
  thinkingTurnId?: string
}

const MAX_ACTIVITY_DETAIL_LINES = 8
const MAX_SUMMARY_DETAIL_LINES = 3

export const Transcript = memo(function Transcript({ items, onOpenReview, reviewMetadata, thinkingTurnId }: TranscriptProps) {
  // `items` is a new array reference only when the conversation actually changes,
  // so this recomputes on real content changes but is skipped when the parent
  // re-renders for unrelated reasons (context-usage ticks, subagent updates…).
  const visibleItems = useMemo(() => buildTranscriptEntries(items), [items])

  return (
    <div className="transcript">
      {visibleItems.map(entry => (
        entry.kind === 'assistant-turn'
          ? <TurnView key={entry.turnId} entry={entry} thinking={thinkingTurnId === entry.turnId} onOpenReview={onOpenReview} reviewMetadata={reviewMetadata} />
          : <MessageArticle key={entry.item.id} item={entry.item} />
      ))}
    </div>
  )
})

type TranscriptEntry =
  | { kind: 'message'; item: TranscriptItem }
  | { kind: 'assistant-turn'; turnId: string; items: TranscriptItem[]; summary?: TranscriptItem }

function TurnView({ entry, thinking, onOpenReview, reviewMetadata }: {
  entry: Extract<TranscriptEntry, { kind: 'assistant-turn' }>
  thinking: boolean
  onOpenReview?: TranscriptProps['onOpenReview']
  reviewMetadata?: WorkspaceReviewMetadata
}) {
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
      <div className="message-meta">
        <span>{label}</span>
        {streaming && (
          <span className="message-status-marker" role="status">
            <span className="message-status-marker-icon" aria-hidden="true"><LoaderCircle size={12} /></span>
            <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm" data-text="gerando">gerando</span>
          </span>
        )}
      </div>

      {!streaming && entry.items.length > 0 && (
        <button type="button" className="turn-collapsed" onClick={() => setExpanded(value => !value)}>
          <ChevronRight size={14} className={expanded ? 'is-open' : ''} />
          <span>{summary?.text ?? 'Trabalhou'}</span>
        </button>
      )}

      {thinking && !hasText && (
        <div className="step-thinking"><ThinkingIcon /> Pensando…</div>
      )}

      {showFlow && <StepFlow items={entry.items} />}

      {!streaming && !expanded && finalText && (
        <div className="step-text turn-recap">{finalText}</div>
      )}

      {!streaming && summary?.changeSummary?.totalFiles ? (
        <section className="turn-completion-summary" aria-label="Resumo do turno">
          <ChangeSummaryCard summary={summary.changeSummary} onOpenReview={onOpenReview} reviewMetadata={reviewMetadata} />
        </section>
      ) : null}
    </article>
  )
}

const MessageArticle = memo(function MessageArticle({ item, children }: { item: TranscriptItem; children?: ReactNode }) {
  return (
    <article
      className={`message-row ${item.role} ${item.kind ?? 'message'}`}
      data-activity={item.activityKind}
    >
      <div className="message-meta">
        {item.kind === 'activity' && <ActivityIcon item={item} />}
        {item.kind === 'summary' && <CheckCircle2 size={14} strokeWidth={1.8} />}
        <span>{labelForItem(item)}</span>
        {item.streaming && (
          <span className="message-status-marker" role="status">
            <span className="message-status-marker-icon" aria-hidden="true">
              <LoaderCircle size={12} />
            </span>
            <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm" data-text="gerando">
              gerando
            </span>
          </span>
        )}
      </div>
      {item.skills && item.skills.length > 0 && (
        <div className="message-skills">
          {item.skills.map(skill => (
            <span key={skill.id}>/{skill.name}</span>
          ))}
        </div>
      )}
      <div className={`message-text ${item.streaming ? 'streaming-text' : ''}`}>
        {item.kind === 'summary' && item.activityDetail
          ? item.activityDetail
          : item.text || (item.streaming ? '...' : '')}
        {item.kind !== 'summary' && item.activityDetail && <span className="message-detail">{item.activityDetail}</span>}
      </div>
      {children}
    </article>
  )
})

function ActivityPanel({ activities, summary }: { activities: TranscriptItem[]; summary?: TranscriptItem }) {
  if (activities.length === 0 && !summary) return null
  const detailLines = activityDetailLines(activities, summary)
  const primaryActivity = activities.find(item => item.activityKind !== 'thinking') ?? activities[0]
  const title = summary?.text ?? activityPanelTitle(activities, summary)

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
  const lines = summary.activityDetail
    ?.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    ?? []

  if (lines.length === 0 && !summary.changeSummary?.totalFiles) return null

  return (
    <section className="turn-completion-summary" aria-label="Resumo do turno">
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

function changeSummaryTitle(summary: NonNullable<TranscriptItem['changeSummary']>, metadata?: WorkspaceReviewMetadata): string {
  if (metadata?.scope === 'github-repo') return 'Mudanças não commitadas'
  if (metadata?.scope === 'git-repo') return 'Mudanças no repositório'
  return `${summary.totalFiles} ${summary.totalFiles === 1 ? 'arquivo com mudança' : 'arquivos com mudanças'}`
}

function changeSummarySubtitle(summary: NonNullable<TranscriptItem['changeSummary']>, metadata?: WorkspaceReviewMetadata): string {
  if (metadata?.scope === 'github-repo' || metadata?.scope === 'git-repo') {
    return `${summary.totalFiles} ${summary.totalFiles === 1 ? 'arquivo com mudança' : 'arquivos com mudanças'}`
  }
  return metadata?.subtitle ?? 'Projeto local sem repositório'
}

function ChangeSummaryCard({ summary, onOpenReview, reviewMetadata }: { summary: NonNullable<TranscriptItem['changeSummary']>; onOpenReview?: TranscriptProps['onOpenReview']; reviewMetadata?: WorkspaceReviewMetadata }) {
  const visibleFiles = summary.files.slice(0, 3)
  const hiddenCount = Math.max(0, summary.totalFiles - visibleFiles.length)

  const handleClickFile = (index: number) => {
    onOpenReview?.(summary.files, index)
  }

  return (
    <div className="change-summary-card">
      <div className="change-summary-card-header"
        role={onOpenReview ? 'button' : undefined}
        tabIndex={onOpenReview ? 0 : undefined}
        title={onOpenReview ? 'Abrir revisão' : ''}
        onClick={() => handleClickFile(0)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClickFile(0) } }}
      >
        <span>
          {changeSummaryTitle(summary, reviewMetadata)}
          <small>{changeSummarySubtitle(summary, reviewMetadata)}</small>
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
            disabled={!onOpenReview || reviewMetadata?.capabilities.canDiff === false}
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
            disabled={!onOpenReview || reviewMetadata?.capabilities.canDiff === false}
            onClick={() => handleClickFile(visibleFiles.length)}
          >Ver mais {hiddenCount} {hiddenCount === 1 ? 'arquivo' : 'arquivos'}</button>
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
  if (item.kind === 'activity') return turnIdFromActivity(item)
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

function labelForItem(item: TranscriptItem): string {
  if (item.kind === 'activity') return item.text
  if (item.kind === 'summary') return item.text
  if (item.role === 'assistant') {
    return item.modelDisplayName ? `Verboo - ${item.modelDisplayName}` : 'Verboo'
  }
  if (item.role === 'tool') return 'Ferramenta'
  if (item.role === 'system') return 'Sistema'
  return 'Você'
}

function turnIdFromActivity(item: TranscriptItem): string | undefined {
  return item.id.match(/^(.*):activity:\d+$/)?.[1]
}

function turnIdFromSummary(item: TranscriptItem): string | undefined {
  return item.id.match(/^(.*):summary$/)?.[1]
}

function activityPanelTitle(activities: TranscriptItem[], summary?: TranscriptItem): string {
  const counts = countActivities(activities)
  const parts = [
    formatCount(counts.read, 'Leu arquivo', 'Leu arquivos'),
    formatCount(counts.edit, 'Editou arquivo', 'Editou arquivos'),
    formatCount(counts.search, 'Pesquisou', 'Pesquisou'),
    formatCount(counts.command, 'Executou comando', 'Executou comandos'),
    formatCount(counts.terminal, 'Leu terminal', 'Leu terminal'),
    formatCount(counts.subagent, 'Usou subagente', 'Usou subagentes'),
    formatCount(counts.permission, 'Pediu permissão', 'Pediu permissões'),
    formatCount(counts.tool, 'Usou ferramenta', 'Usou ferramentas'),
  ].filter((part): part is string => Boolean(part))

  if (parts.length > 0) return joinParts(parts)
  return summary?.text ?? 'Atividade do agente'
}

function activityDetailLines(activities: TranscriptItem[], summary?: TranscriptItem): string[] {
  const title = activityPanelTitle(activities)
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
    visibleActivityLines.push(`+${hiddenCount} ações ocultas`)
  }

  const summaryLines = summary?.activityDetail
    ?.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('Resumo:') && line !== 'Motivo de parada: end_turn.')
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
    if (!item.activityDetail && item.activityKind !== 'permission' && item.activityKind !== 'subagent') return counts
    counts[item.activityKind] = (counts[item.activityKind] ?? 0) + 1
    return counts
  }, {})
}

function formatCount(count: number | undefined, singular: string, plural: string): string | undefined {
  if (!count) return undefined
  if (singular === plural) return count > 1 ? `${plural} ${count}x` : singular
  return count === 1 ? singular : `${plural} (${count})`
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`
}

function compactPath(path: string): string {
  if (path.length <= 58) return path
  return `...${path.slice(-55)}`
}
