export type ReservedSlashCommand =
  | { kind: 'goal'; action: 'show' | 'status' | 'start' | 'pause' | 'resume' | 'clear' | 'help'; objective?: string; raw: string }
  | { kind: 'pet'; raw: string }
  | { kind: 'compact'; instructions?: string; raw: string }
  | { kind: 'computer-use'; app?: string; goal?: string; raw: string }

/** Built-in composer commands (not user custom slash commands). Keep in sync
 *  with `customSlashCommands.ts` RESERVED_COMMAND_NAMES and Composer palette. */
const RESERVED_COMMANDS = new Set(['goal', 'pet', 'compact', 'computer-use'])

/**
 * Parse a goal command from text that may or may not start with a slash.
 * Accepts:
 *   `/goal implement X`  → start
 *   `goal implement X`   → start (no slash)
 *   `/goal pause`        → pause
 *   `goal pause`         → pause (no slash)
 *   `/goal`              → show
 *   `goal`               → show (no slash)
 *
 * Returns undefined if the text is not a goal command (doesn't start with
 * `/goal` or `goal` as the first word). Case-insensitive.
 */
export function parseGoalCommand(value: string): ReservedSlashCommand | undefined {
  const raw = value.trim()
  if (!raw) return undefined

  // Slash form: explicit goal command — any objective is accepted.
  const hasSlash = raw.startsWith('/')
  const body = hasSlash ? raw.slice(1) : raw
  const [command = '', ...parts] = body.split(/\s+/)
  const name = command.toLowerCase()

  if (name !== 'goal') return undefined

  const rest = body.slice(command.length).trim()
  const restLower = rest.toLowerCase()
  if (!rest) return { kind: 'goal', action: 'show', raw }
  if (restLower === 'pause') return { kind: 'goal', action: 'pause', raw }
  if (restLower === 'resume') return { kind: 'goal', action: 'resume', raw }
  if (restLower === 'clear') return { kind: 'goal', action: 'clear', raw }
  if (restLower === 'status') return { kind: 'goal', action: 'status', raw }
  if (restLower === 'help' || restLower === '?') return { kind: 'goal', action: 'help', raw }

  const first = parts[0]?.toLowerCase()
  if (first === 'stop' || first === 'cancel' || first === 'reset' || first === 'off' || first === 'end' || first === 'halt') {
    return { kind: 'goal', action: 'clear', raw }
  }

  // No-slash start: reject if the first token is a filler word (EN/PT).
  // Prevents hijacking natural sentences like "goal is to ship" or
  // "my goal is learning Rust" into goal starts. With an explicit slash
  // (/goal is to ship) the user's intent is clear, so we accept it.
  if (!hasSlash) {
    const FILLER = new Set([
      'is', 'are', 'was', 'were', 'will', 'the', 'a', 'an', 'to', 'for', 'of', 'my', 'our', 'this', 'that', 'it',
      'é', 'um', 'uma', 'de', 'do', 'da', 'para', 'me', 'meu', 'minha', 'nosso', 'nossa', 'isso', 'este', 'esse',
    ])
    if (first && FILLER.has(first)) return undefined
  }

  return { kind: 'goal', action: 'start', objective: rest, raw }
}

export function parseReservedSlashCommand(value: string): ReservedSlashCommand | undefined {
  const raw = value.trim()
  if (!raw.startsWith('/')) return undefined

  const [command = ''] = raw.slice(1).split(/\s+/)
  const rest = raw.slice(command.length + 1).trim()
  const name = command.toLowerCase()

  if (name === 'pet' && !rest) return { kind: 'pet', raw }

  if (name === 'compact') {
    return {
      kind: 'compact',
      instructions: rest || undefined,
      raw,
    }
  }

  if (name === 'computer-use') {
    let app = ''
    let goal = ''
    if (rest.startsWith('"')) {
      const closingQuote = rest.indexOf('"', 1)
      if (closingQuote > 1) {
        app = rest.slice(1, closingQuote).trim()
        goal = rest.slice(closingQuote + 1).trim()
      }
    } else {
      goal = rest
    }
    return {
      kind: 'computer-use',
      app: app || undefined,
      goal: goal || undefined,
      raw,
    }
  }

  if (name !== 'goal') return undefined
  // Delegate to parseGoalCommand so both slash and no-slash forms share
  // the same parsing logic.
  return parseGoalCommand(raw)
}

export function isReservedSlashQuery(value: string): boolean {
  const match = value.match(/^\/([A-Za-z0-9_-]*)$/)
  if (!match) return false
  const query = match[1].toLowerCase()
  return Array.from(RESERVED_COMMANDS).some(command => command.startsWith(query))
}

export function getReservedSlashCommandNames(): string[] {
  return Array.from(RESERVED_COMMANDS)
}
