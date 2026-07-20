import { useMemo, useState } from 'react'
import { SlotText } from 'slot-text/react'
import type { TranscriptItem, TurnAction, TurnBlock } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { groupTurnBlocks, parseVisionRelayDetail, summarizeActions } from './turnBlocks'
import { ArrowRight } from 'lucide-react'
import { ActionIcon } from './TranscriptIcons'
import { CommandBlock } from './CommandBlock'
import { MarkdownMessage, normalizeThinkingProse } from './MarkdownMessage'
import mascotUrl from '../../../../assets/branding/verboo-mascot.png'

export function StepFlow({ items, streaming = false, imageReading = false, hideFinalTextId }: {
  items: TranscriptItem[]
  streaming?: boolean
  imageReading?: boolean
  hideFinalTextId?: string
}) {
  const blocks = groupTurnBlocks(items)
  // While the turn streams, the last actions block is the one "in flight":
  // its icon pulses purple and its label shimmers (see flow.css).
  const lastBlock = blocks[blocks.length - 1]
  const activeBlockId = streaming && lastBlock?.kind === 'actions' ? lastBlock.id : undefined
  return (
    <div className="step-flow">
      {blocks.map(block => {
        // When expanded, the parent shows the recap as a standalone paragraph
        // below the panel. Hide the matching text block here by id identity
        // Match by id identity (never by text equality or blind position).
        if (block.kind === 'text' && hideFinalTextId && block.id === hideFinalTextId) return null
        if (block.kind === 'text') {
          return block.text
            ? <div key={block.id} className={`step-text ${block.streaming ? 'streaming-text' : ''}`}><MarkdownMessage text={block.text} /></div>
            : null
        }
        if (block.kind === 'thinking') {
          return <ReasoningContent key={block.id} text={block.text} />
        }
        if (block.actions.length === 1) {
          const relay = parseVisionRelayDetail(block.actions[0].detail ?? '')
          if (relay) {
            return <VisionRelayRow key={block.id} relay={relay} readingImage={imageReading} />
          }
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
  // Strip self-emitted heading so the user doesn't see a duplicate label,
  // then normalize line-per-line model output into flowing prose. The
  // normalizer applies densifyMarkdown + joins short chopped lines while
  // preserving real markdown structure (lists, code blocks, headings).
  const clean = text.replace(/^\s*(#*\s*)?(RACIOC[IÍ]NIO|Reasoning|Raciocínio)\s*$/im, '').trim()
  if (!clean) return null
  return (
    <div className="thinking-disclosure-body">
      <MarkdownMessage text={normalizeThinkingProse(clean)} />
    </div>
  )
}

function ActionRow({ actions, active = false }: { actions: TurnAction[]; active?: boolean }) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()
  const isAgent = actions[0].kind === 'agent-open' || actions[0].kind === 'agent-close'
  const hasAnyContent = actions.some(a => a.command || a.detail || a.toolOutput || a.diffPreview)

  // Aggregate diff stats from all edit-type actions (optional fields shipped
  // by Geralt's edit service). Rendered as animated SlotText below the label
  // — grows up in green (+N) or down in red (-N) when values change.
  const diffAdd = useMemo(() => actions.reduce((s, a) => s + (a.additions ?? 0), 0), [actions])
  const diffDel = useMemo(() => actions.reduce((s, a) => s + (a.deletions ?? 0), 0), [actions])

  // When there's exactly one edit/create action with a detail path, append
  // the basename so the user reads "Editou foo.js +87 -32" instead of just
  // "Editou arquivo +87 -32". Multi-action blocks keep the plain summary.
  const linkAction = actions.length === 1 ? actions[0] : null
  const linkPath = linkAction && (linkAction.kind === 'edit' || linkAction.kind === 'create')
    ? linkAction.detail
    : undefined
  const labelBase = summarizeActions(actions, t)
  const labelText = linkPath
    ? `${labelBase} ${linkPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''}`
    : labelBase

  return (
    <div className={`step-actions ${active ? 'is-active' : ''}`}>
      <button type="button" className="step-actions-row" onClick={() => hasAnyContent && setOpen(v => !v)} disabled={!hasAnyContent}>
        <span className="step-actions-icon">
          {isAgent ? <img className="step-actions-avatar" src={mascotUrl} alt="" /> : <ActionIcon kind={actions[0].kind} />}
        </span>
        <span className={`step-actions-label ${active ? 'shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm' : ''}`}>
          {labelText}
        </span>
        {(diffAdd > 0 || diffDel > 0) && (
          <span className="step-actions-diffs">
            {diffAdd > 0 && (
              <span className="step-diff-add">
                <SlotText
                  text={`+${diffAdd}`}
                  options={{ direction: 'up', duration: 180, stagger: 14, bounce: 0.2, interrupt: true }}
                />
              </span>
            )}
            {diffDel > 0 && (
              <span className="step-diff-del">
                <SlotText
                  text={`-${diffDel}`}
                  options={{ direction: 'down', duration: 180, stagger: 14, bounce: 0.2, interrupt: true }}
                />
              </span>
            )}
          </span>
        )}
        {hasAnyContent && <span className={`step-actions-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />}
      </button>
      {open && (
        <div className="step-actions-detail">
          {actions.map((a, i) => (
            <div key={`a${i}`} className="step-actions-per-action">
              {a.command ? <CommandBlock run={a.command} /> : null}
              {a.detail && !a.command ? <div className="step-actions-detail-line">{a.detail}</div> : null}
              {a.diffPreview ? renderActionDiff(a.diffPreview) : a.toolOutput ? <div className="step-actions-detail-line step-actions-tool-output step-actions-tool-output-plain">{a.toolOutput}</div> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Render an action's toolOutput as a compact diff block when lines begin
 *  with `+` or `-` (at least two such lines). Plain tool output without
 *  diff markers renders with improved typography (no box-shadow, quiet). */
function renderActionDiff(output: string) {
  const lines = output.split('\n')
  const looksLikeDiff = lines.filter(l => /^[+-]/.test(l)).length >= 2
  if (!looksLikeDiff) {
    return <div className="step-actions-detail-line step-actions-tool-output step-actions-tool-output-plain">{output}</div>
  }
  return (
    <div className="step-actions-diff-block">
      {lines.map((line, i) => {
        if (/^\+/.test(line)) return <span key={i} className="step-diff-line step-diff-line-add">{line}</span>
        if (/^-/.test(line)) return <span key={i} className="step-diff-line step-diff-line-del">{line}</span>
        return <span key={i} className="step-diff-line step-diff-line-ctx">{line}</span>
      })}
    </div>
  )
}

/** Vision-relay row: shown when the turn streams an image through a helper
 *  model (vision fallback path). Quiet row with primary → arrow → helper.
 *  While `readingImage` is true the row shimmers. After done the arrow
 *  settles. The old "Lendo imagem…" live chip is not shown alongside. */
function VisionRelayRow({ relay, readingImage }: {
  relay: NonNullable<ReturnType<typeof parseVisionRelayDetail>>
  readingImage?: boolean
}) {
  const { t } = useI18n()
  const consulting = t('transcript.visionConsulting')
  const consulted = t('transcript.visionConsulted')
  const statusText = readingImage ? consulting : consulted
  return (
    <div className={`vision-relay-row ${readingImage ? 'is-active' : ''}`} role="status">
      <span className="vision-relay-status">{statusText}</span>
      <span className="vision-relay-name vision-relay-primary">{relay.primaryDisplay}</span>
      <span className="vision-relay-arrow" aria-hidden="true">
        {readingImage
          ? <span className="shimmer shimmer-color-purple shimmer-spread-24 shimmer-duration-calm">
              <ArrowRight size={13} strokeWidth={2} />
            </span>
          : <ArrowRight size={13} strokeWidth={2} />
        }
      </span>
      <span className="vision-relay-name vision-relay-helper">{relay.helperDisplay}</span>
    </div>
  )
}
