import type { TranscriptItem, TurnAction, TurnActionKind, TurnBlock } from '../../../shared/types'
import type { Translator } from '../../i18n'

const KIND_MAP: Record<string, TurnActionKind> = {
  read: 'read', search: 'search', edit: 'edit', command: 'command',
  image: 'image', terminal: 'terminal', permission: 'permission', subagent: 'agent-open', tool: 'tool',
  // FRENTE-A (2026-08-02): all Verboo-in-Chrome tools share the browser kind.
  browser: 'browser',
}

// Walks a turn's already-ordered items (text segments + activity items) into an
// ordered list of blocks. Consecutive activity items collapse into one 'actions'
// block; text items become 'text' blocks. Thinking items become 'thinking' blocks
// (persisted by the backend at end-of-turn with the full reasoning text) so the
// renderer can show a collapsible disclosure instead of a transient shimmer.
export function groupTurnBlocks(items: TranscriptItem[]): TurnBlock[] {
  const blocks: TurnBlock[] = []
  for (const item of items) {
    if (item.kind === 'activity') {
      if (item.activityKind === 'thinking') {
        // Skip empty thinking items (no reasoning text to show). The backend
        // commits a single persistent thinking item at end-of-turn with the
        // full accumulated text; transient streaming thinking items have empty
        // text and are already represented by the live ThinkingRotator.
        if (!item.text.trim()) continue
        blocks.push({
          kind: 'thinking',
          id: item.id,
          text: item.text,
          streaming: Boolean(item.streaming),
        })
        continue
      }
      // TodoWrite is presented by ChecklistPanel. Ignore planning items here
      // too, so persisted or replayed events cannot create a duplicate row.
      if (item.activityKind === 'planning') continue
      const action: TurnAction = {
        kind: KIND_MAP[item.activityKind ?? 'tool'] ?? 'tool',
        label: item.text,
        detail: item.activityDetail,
        command: item.command ?? (item.activityKind === 'command'
          ? { input: item.activityDetail ?? item.text, output: '', status: 'success' }
          : undefined),
        toolOutput: item.toolOutput,
        additions: item.activityAdditions,
        deletions: item.activityDeletions,
        diffPreview: item.activityDiffPreview,
      }
      // Single-file edits/creates with a path get their OWN row (not collapsed
      // into the previous actions block) so the user sees "Editou foo.js +87 -32"
      // per file rather than a generic "Editou arquivos (2)" summary. Browser
      // actions also get one row each because the product reference requires
      // every Chrome step to say what it did; unlike edits, they need no detail.
      const isOwnRowAction = action.kind === 'browser'
        || ((action.kind === 'edit' || action.kind === 'create') && Boolean(action.detail))
      const last = blocks[blocks.length - 1]
      const lastBlockContainsBrowser = last?.kind === 'actions'
        && last.actions.some(existing => existing.kind === 'browser')
      if (!isOwnRowAction && !lastBlockContainsBrowser && last && last.kind === 'actions') last.actions.push(action)
      else blocks.push({ kind: 'actions', id: `${item.id}:g`, actions: [action] })
      continue
    }
    if (item.role === 'assistant') {
      // Whitespace-only segments (the CLI emits "\n\n" between tool calls) render
      // nothing but used to split the surrounding actions into separate blocks,
      // producing a long stack of "Executou comandos" rows. Skip them so all
      // actions between two real messages collapse into a single block.
      if (!item.text.trim()) continue
      blocks.push({ kind: 'text', id: item.id, text: item.text, streaming: Boolean(item.streaming) })
    }
  }
  return blocks
}

const PLURAL_KEYS: Partial<Record<TurnActionKind, [string, string]>> = {
  read: ['transcript.readOne', 'transcript.readMany'],
  search: ['transcript.searchOne', 'transcript.searchMany'],
  edit: ['transcript.editOne', 'transcript.editMany'],
  create: ['transcript.createdOne', 'transcript.createdMany'],
  delete: ['transcript.deletedOne', 'transcript.deletedMany'],
  command: ['transcript.commandOne', 'transcript.commandMany'],
  image: ['transcript.imageOne', 'transcript.imageMany'],
  terminal: ['transcript.terminalOne', 'transcript.terminalMany'],
  permission: ['transcript.permissionOne', 'transcript.permissionMany'],
  'agent-open': ['transcript.agentOpenOne', 'transcript.agentOpenMany'],
  'agent-close': ['transcript.agentCloseOne', 'transcript.agentCloseMany'],
  tool: ['transcript.toolOne', 'transcript.toolMany'],
  browser: ['transcript.browserOne', 'transcript.browserMany'],
}

/**
 * Parse a vision‑relay detail string emitted by Geralt for the vision
 * fallback path. Format: `vision-relay|{primaryId}|{primaryDisplay}|{helperId}|{helperDisplay}`
 *
 * Returns null when the detail does not match this format.
 */
export function parseVisionRelayDetail(detail: string): {
  primaryId: string
  primaryDisplay: string
  helperId: string
  helperDisplay: string
} | null {
  const parts = detail.split('|')
  if (parts[0] !== 'vision-relay' || parts.length < 5) return null
  const [, primaryId, primaryDisplay, helperId, helperDisplay] = parts
  if (!primaryId || !helperId) return null
  return {
    primaryId,
    primaryDisplay: primaryDisplay || primaryId,
    helperId,
    helperDisplay: helperDisplay || helperId,
  }
}

/** True when an activity's key signals a vision‑relay event (ends with
 *  `:vision-relay`). Used by both the renderer and the deduplication
 *  logic in `appendActivityItem`. */
export function isVisionRelayKey(key: string): boolean {
  return key.endsWith(':vision-relay')
}

export function summarizeActions(actions: TurnAction[], t: Translator): string {
  const counts = new Map<TurnActionKind, number>()
  for (const a of actions) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1)
  const parts: string[] = []
  for (const [kind, n] of counts) {
    // Browser intentionally keeps every tool label in execution order. A
    // shared block must tell the user which Chrome actions happened instead
    // of collapsing them into a type counter; other kinds keep their summary.
    if (kind === 'browser') {
      const browserLabels = actions
        .filter(action => action.kind === 'browser')
        .map(action => action.label.trim())
        .filter(Boolean)
      parts.push(browserLabels.length > 0 ? browserLabels.join(', ') : 'transcript.browserOne')
      continue
    }
    const forms = PLURAL_KEYS[kind] ?? ['transcript.actionOne', 'transcript.actionMany']
    parts.push(n === 1 ? forms[0] : `${forms[1]} (${n})`)
  }
  const labels = parts.map(part => {
    const match = part.match(/^([^()]+)(?: \((\d+)\))?$/)
    if (!match) return t(part)
    const [, key, count] = match
    return count ? `${t(key)} (${count})` : t(key)
  })
  if (labels.length <= 1) return labels[0] ?? t('transcript.worked')
  return `${labels.slice(0, -1).join(', ')} ${t('transcript.and')} ${labels[labels.length - 1]}`
}
