import { CheckCircle2, Circle, GitBranch, LoaderCircle, X, XCircle } from 'lucide-react'
import type { SubagentThread, SubagentThreadEvent, SubagentThreadStatus } from '../../../shared/types'
import { useI18n, type Translator } from '../../i18n'
import { MarkdownMessage } from '../transcript/MarkdownMessage'

export function SubagentThreadPanel({
  threads,
  selectedId,
  onSelect,
  onClose,
}: {
  threads: SubagentThread[]
  selectedId: string
  onSelect: (threadId: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const selected = threads.find(thread => thread.id === selectedId) ?? threads[0]
  if (!selected) return null

  return (
    <aside
      className="subagent-thread-panel"
      data-status={selected.status}
      aria-label={t('subagent.threadAria', { name: selected.label })}
    >
      <header className="subagent-thread-header">
        <div className="subagent-thread-title">
          <GitBranch size={14} aria-hidden="true" />
          <strong>{t('subagent.summaryTitle')}</strong>
          <span>{threads.length}</span>
        </div>
        <button type="button" onClick={onClose} aria-label={t('subagent.closeAria')}>
          <X size={16} />
        </button>
      </header>

      <nav className="subagent-thread-tabs" aria-label={t('subagent.activeAria')}>
        {threads.map(thread => (
          <button
            key={thread.id}
            type="button"
            className={thread.id === selected.id ? 'selected' : ''}
            onClick={() => onSelect(thread.id)}
          >
            <StatusIcon status={thread.status} />
            <span>{thread.label}</span>
            <small>{statusLabel(thread.status, t)}</small>
          </button>
        ))}
      </nav>

      <section className="subagent-thread-content" aria-label={t('subagent.historyAria', { name: selected.label })}>
        {selected.events.length === 0 && (
          <ThreadMessage kind="mission" text={selected.mission || t('subagent.defaultMission')} />
        )}
        {selected.events.map(event => (
          <EventMessage key={event.id} event={event} />
        ))}
      </section>

      <footer className="subagent-thread-footer">{t('subagent.readOnlyHistory')}</footer>
    </aside>
  )
}

function EventMessage({ event }: { event: SubagentThreadEvent }) {
  if (event.kind === 'tool-call' || event.kind === 'tool-result') {
    return (
      <details className={`subagent-tool-event ${event.isError ? 'error' : ''}`}>
        <summary>{event.toolName || (event.kind === 'tool-call' ? 'Tool' : 'Result')}</summary>
        {event.text && <pre>{event.text}</pre>}
      </details>
    )
  }
  if (event.kind === 'status') {
    return <div className="subagent-status-event"><Circle size={8} />{event.text}</div>
  }
  return <ThreadMessage kind={event.kind} text={event.text} />
}

function ThreadMessage({ kind, text }: { kind: SubagentThreadEvent['kind']; text: string }) {
  const { t } = useI18n()
  const isMission = kind === 'mission'
  return (
    <article className={`subagent-thread-message ${isMission ? 'mission' : 'agent'}`}>
      <small>{isMission ? t('subagent.mission') : t('subagent.response')}</small>
      <MarkdownMessage text={text} />
    </article>
  )
}

function StatusIcon({ status }: { status: SubagentThreadStatus }) {
  if (!['completed', 'failed', 'cancelled'].includes(status)) {
    return <LoaderCircle className="subagent-status-spinner" size={13} aria-hidden="true" />
  }
  if (status === 'completed') return <CheckCircle2 size={13} aria-hidden="true" />
  return <XCircle size={13} aria-hidden="true" />
}

function statusLabel(status: SubagentThreadStatus, t: Translator): string {
  const key = status === 'completed' ? 'done' : status
  return t(`subagent.${key}`)
}
