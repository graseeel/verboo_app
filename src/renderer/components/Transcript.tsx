import { SlotText } from 'slot-text/react'
import type { TranscriptItem } from '../../shared/types'

type TranscriptProps = {
  items: TranscriptItem[]
}

export function Transcript({ items }: TranscriptProps) {
  const visibleItems = items.filter(item => item.role !== 'system')

  return (
    <div className="transcript">
      {visibleItems.map(item => (
        <article key={item.id} className={`message-row ${item.role}`}>
          <div className="message-meta">
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
          <pre className={item.streaming ? 'streaming-text' : undefined}>
            {item.text || (item.streaming ? '...' : '')}
          </pre>
        </article>
      ))}
    </div>
  )
}

function labelForItem(item: TranscriptItem): string {
  if (item.role === 'assistant') {
    return item.modelDisplayName ? `Verboo - ${item.modelDisplayName}` : 'Verboo'
  }
  if (item.role === 'tool') return 'Ferramenta'
  if (item.role === 'system') return 'Sistema'
  return 'Voce'
}
