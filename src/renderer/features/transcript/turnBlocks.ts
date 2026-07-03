import type { TranscriptItem, TurnAction, TurnActionKind, TurnBlock } from '../../../shared/types'

const KIND_MAP: Record<string, TurnActionKind> = {
  read: 'read', search: 'search', edit: 'edit', command: 'command',
  terminal: 'terminal', permission: 'permission', subagent: 'agent-open', tool: 'tool',
}

// Walks a turn's already-ordered items (text segments + activity items) into an
// ordered list of blocks. Consecutive activity items collapse into one 'actions'
// block; text items become 'text' blocks. Thinking items are ignored (transient).
export function groupTurnBlocks(items: TranscriptItem[]): TurnBlock[] {
  const blocks: TurnBlock[] = []
  for (const item of items) {
    if (item.kind === 'activity') {
      if (item.activityKind === 'thinking') continue
      const action: TurnAction = {
        kind: KIND_MAP[item.activityKind ?? 'tool'] ?? 'tool',
        label: item.text,
        detail: item.activityDetail,
        command: item.command ?? (item.activityKind === 'command'
          ? { input: item.activityDetail ?? item.text, output: '', status: 'success' }
          : undefined),
      }
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'actions') last.actions.push(action)
      else blocks.push({ kind: 'actions', id: `${item.id}:g`, actions: [action] })
      continue
    }
    if (item.role === 'assistant') {
      blocks.push({ kind: 'text', id: item.id, text: item.text, streaming: Boolean(item.streaming) })
    }
  }
  return blocks
}

const PLURAL: Partial<Record<TurnActionKind, [string, string]>> = {
  read: ['Leu arquivo', 'Leu arquivos'],
  search: ['Pesquisou', 'Pesquisou'],
  edit: ['Editou arquivo', 'Editou arquivos'],
  create: ['Criou arquivo', 'Criou arquivos'],
  delete: ['Apagou arquivo', 'Apagou arquivos'],
  command: ['Executou comando', 'Executou comandos'],
  terminal: ['Leu terminal', 'Leu terminal'],
  permission: ['Pediu permissão', 'Pediu permissões'],
  'agent-open': ['Criou um agente', 'Criou agentes'],
  'agent-close': ['Fechou um agente', 'Fechou agentes'],
  tool: ['Usou ferramenta', 'Usou ferramentas'],
}

export function summarizeActions(actions: TurnAction[]): string {
  const counts = new Map<TurnActionKind, number>()
  for (const a of actions) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1)
  const parts: string[] = []
  for (const [kind, n] of counts) {
    const forms = PLURAL[kind] ?? ['Ação', 'Ações']
    parts.push(n === 1 ? forms[0] : `${forms[1]} (${n})`)
  }
  if (parts.length <= 1) return parts[0] ?? 'Trabalhou'
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`
}
