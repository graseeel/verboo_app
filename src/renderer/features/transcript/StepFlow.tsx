import { useState } from 'react'
import type { TranscriptItem, TurnAction, TurnBlock } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { groupTurnBlocks, summarizeActions } from './turnBlocks'
import { ActionIcon } from './TranscriptIcons'
import { CommandBlock } from './CommandBlock'
import { MarkdownMessage } from './MarkdownMessage'
import mascotUrl from '../../../../assets/branding/verboo-mascot.png'

export function StepFlow({ items, streaming = false }: { items: TranscriptItem[]; streaming?: boolean }) {
  const blocks = groupTurnBlocks(items)
  // While the turn streams, the last actions block is the one "in flight":
  // its icon pulses purple and its label shimmers (see flow.css).
  const lastBlock = blocks[blocks.length - 1]
  const activeBlockId = streaming && lastBlock?.kind === 'actions' ? lastBlock.id : undefined
  return (
    <div className="step-flow">
      {blocks.map(block => {
        if (block.kind === 'text') {
          return block.text
            ? <div key={block.id} className={`step-text ${block.streaming ? 'streaming-text' : ''}`}><MarkdownMessage text={block.text} /></div>
            : null
        }
        if (block.kind === 'thinking') {
          return <ReasoningContent key={block.id} text={block.text} />
        }
        return <ActionRow key={block.id} actions={block.actions} active={block.id === activeBlockId} />
      })}
    </div>
  )
}

// Extract the persisted thinking block (if any) from a turn's items. Used by
// Transcript.tsx to render the reasoning content inside showFlow.
export function findPersistedThinking(items: TranscriptItem[]): Extract<TurnBlock, { kind: 'thinking' }> | undefined {
  const blocks = groupTurnBlocks(items)
  return blocks.find((b): b is Extract<TurnBlock, { kind: 'thinking' }> => b.kind === 'thinking')
}

// Reasoning block — markdown text rendered inline inside the "Worked for Xs"
// expansion, in the correct chronological position (before the actions it
// generated). No separate toggle: visibility follows the parent switch.
function ReasoningContent({ text }: { text: string }) {
  // Strip self-emitted heading so the user doesn't see a duplicate label.
  const clean = text.replace(/^\s*(#*\s*)?(RACIOC[IÍ]NIO|Reasoning|Raciocínio)\s*$/im, '').trim()
  if (!clean) return null
  return (
    <div className="thinking-disclosure-body">
      <MarkdownMessage text={clean} />
    </div>
  )
}

function ActionRow({ actions, active = false }: { actions: TurnAction[]; active?: boolean }) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()
  const isAgent = actions[0].kind === 'agent-open' || actions[0].kind === 'agent-close'
  const hasAnyContent = actions.some(a => a.command || a.detail || a.toolOutput)
  return (
    <div className={`step-actions ${active ? 'is-active' : ''}`}>
      <button type="button" className="step-actions-row" onClick={() => hasAnyContent && setOpen(v => !v)} disabled={!hasAnyContent}>
        <span className="step-actions-icon">
          {isAgent ? <img className="step-actions-avatar" src={mascotUrl} alt="" /> : <ActionIcon kind={actions[0].kind} />}
        </span>
        <span className={`step-actions-label ${active ? 'shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm' : ''}`}>
          {summarizeActions(actions, t)}
        </span>
        {hasAnyContent && <span className={`step-actions-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />}
      </button>
      {open && (
        <div className="step-actions-detail">
          {actions.map((a, i) => (
            <div key={`a${i}`} className="step-actions-per-action">
              {a.command ? <CommandBlock run={a.command} /> : null}
              {a.detail && !a.command ? <div className="step-actions-detail-line">{a.detail}</div> : null}
              {a.toolOutput ? <div className="step-actions-detail-line step-actions-tool-output">{a.toolOutput}</div> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
