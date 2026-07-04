import { useState } from 'react'
import type { TranscriptItem, TurnAction } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { groupTurnBlocks, summarizeActions } from './turnBlocks'
import { ActionIcon } from './TranscriptIcons'
import { CommandBlock } from './CommandBlock'
import mascotUrl from '../../../../assets/branding/verboo-mascot.png'

export function StepFlow({ items, streaming = false }: { items: TranscriptItem[]; streaming?: boolean }) {
  const blocks = groupTurnBlocks(items)
  // While the turn streams, the last actions block is the one "in flight":
  // its icon pulses purple and its label shimmers (see flow.css).
  const lastBlock = blocks[blocks.length - 1]
  const activeBlockId = streaming && lastBlock?.kind === 'actions' ? lastBlock.id : undefined
  return (
    <div className="step-flow">
      {blocks.map(block => block.kind === 'text'
        ? (block.text ? <div key={block.id} className={`step-text ${block.streaming ? 'streaming-text' : ''}`}>{block.text}</div> : null)
        : <ActionRow key={block.id} actions={block.actions} active={block.id === activeBlockId} />)}
    </div>
  )
}

function ActionRow({ actions, active = false }: { actions: TurnAction[]; active?: boolean }) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()
  const commands = actions.filter(a => a.command)
  const details = actions.filter(a => a.detail && !a.command)
  const expandable = commands.length > 0 || details.length > 0
  const isAgent = actions[0].kind === 'agent-open' || actions[0].kind === 'agent-close'
  return (
    <div className={`step-actions ${active ? 'is-active' : ''}`}>
      <button type="button" className="step-actions-row" onClick={() => expandable && setOpen(v => !v)} disabled={!expandable}>
        <span className="step-actions-icon">
          {isAgent ? <img className="step-actions-avatar" src={mascotUrl} alt="" /> : <ActionIcon kind={actions[0].kind} />}
        </span>
        <span className={`step-actions-label ${active ? 'shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm' : ''}`}>
          {summarizeActions(actions, t)}
        </span>
        {expandable && <span className={`step-actions-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />}
      </button>
      {open && (
        <div className="step-actions-detail">
          {commands.map((a, i) => a.command ? <CommandBlock key={`c${i}`} run={a.command} /> : null)}
          {details.map((a, i) => <div key={`d${i}`} className="step-actions-detail-line">{a.detail}</div>)}
        </div>
      )}
    </div>
  )
}
