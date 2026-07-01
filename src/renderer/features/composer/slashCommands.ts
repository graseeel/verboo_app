export type ReservedSlashCommand =
  | { kind: 'goal'; action: 'show' | 'start' | 'pause' | 'resume' | 'clear'; objective?: string; raw: string }

const RESERVED_COMMANDS = new Set(['goal'])

export function parseReservedSlashCommand(value: string): ReservedSlashCommand | undefined {
  const raw = value.trim()
  if (!raw.startsWith('/')) return undefined

  const [command = '', ...parts] = raw.slice(1).split(/\s+/)
  const rest = raw.slice(command.length + 1).trim()

  if (command !== 'goal') return undefined
  if (!rest) return { kind: 'goal', action: 'show', raw }
  if (rest === 'pause') return { kind: 'goal', action: 'pause', raw }
  if (rest === 'resume') return { kind: 'goal', action: 'resume', raw }
  if (rest === 'clear') return { kind: 'goal', action: 'clear', raw }

  const first = parts[0]
  if (first === 'stop' || first === 'cancel' || first === 'reset' || first === 'off') {
    return { kind: 'goal', action: 'clear', raw }
  }

  return { kind: 'goal', action: 'start', objective: rest, raw }
}

export function isReservedSlashQuery(value: string): boolean {
  const match = value.match(/^\/([A-Za-z0-9_-]*)$/)
  if (!match) return false
  const query = match[1].toLowerCase()
  return Array.from(RESERVED_COMMANDS).some(command => command.startsWith(query))
}
