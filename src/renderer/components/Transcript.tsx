import { CheckCircle2, ChevronDown, Clock3, FileSearch, FileText, GitBranch, Pencil, Search, Terminal, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import { SlotText } from 'slot-text/react'
import type { TranscriptItem } from '../../shared/types'

type TranscriptProps = {
  items: TranscriptItem[]
}

const MAX_ACTIVITY_DETAIL_LINES = 8
const MAX_SUMMARY_DETAIL_LINES = 3

export function Transcript({ items }: TranscriptProps) {
  const visibleItems = buildTranscriptEntries(items)

  return (
    <div className="transcript">
      {visibleItems.map(entry => (
        entry.kind === 'assistant-turn'
          ? (
              <MessageArticle key={entry.item.id} item={entry.item}>
                <ActivityPanel activities={entry.activities} summary={entry.summary} />
              </MessageArticle>
            )
          : <MessageArticle key={entry.item.id} item={entry.item} />
      ))}
    </div>
  )
}

type TranscriptEntry =
  | { kind: 'message'; item: TranscriptItem }
  | { kind: 'assistant-turn'; item: TranscriptItem; activities: TranscriptItem[]; summary?: TranscriptItem }

function MessageArticle({ item, children }: { item: TranscriptItem; children?: ReactNode }) {
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
          <span className="streaming-dot">
            <SlotText text="gerando" options={{ direction: 'up', duration: 180, stagger: 18 }} />
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
}

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

function buildTranscriptEntries(items: TranscriptItem[]): TranscriptEntry[] {
  const turnData = new Map<string, { activities: TranscriptItem[]; summary?: TranscriptItem; assistant?: TranscriptItem }>()

  for (const item of items) {
    if (item.kind === 'activity') {
      const turnId = turnIdFromActivity(item)
      if (!turnId) continue
      const current = turnData.get(turnId) ?? { activities: [] }
      current.activities.push(item)
      turnData.set(turnId, current)
    }
    if (item.kind === 'summary') {
      const turnId = turnIdFromSummary(item)
      if (!turnId) continue
      const current = turnData.get(turnId) ?? { activities: [] }
      current.summary = item
      turnData.set(turnId, current)
    }
    if (item.role === 'assistant') {
      const current = turnData.get(item.id) ?? { activities: [] }
      current.assistant = item
      turnData.set(item.id, current)
    }
  }

  const entries: TranscriptEntry[] = []
  for (const item of items) {
    if (item.role === 'system' && item.kind !== 'summary') continue

    if (item.kind === 'activity') {
      const turnId = turnIdFromActivity(item)
      if (turnId && turnData.get(turnId)?.assistant) continue
    }

    if (item.kind === 'summary') {
      const turnId = turnIdFromSummary(item)
      if (turnId && turnData.get(turnId)?.assistant) continue
    }

    if (item.role === 'assistant') {
      const data = turnData.get(item.id)
      entries.push({
        kind: 'assistant-turn',
        item,
        activities: data?.activities ?? [],
        summary: data?.summary,
      })
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
  return 'Voce'
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
    formatCount(counts.permission, 'Pediu permissao', 'Pediu permissoes'),
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
    visibleActivityLines.push(`+${hiddenCount} acoes ocultas`)
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
