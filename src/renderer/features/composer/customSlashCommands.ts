import type { CustomSlashCommand } from '../../../shared/types'

/**
 * Pure, framework-agnostic helpers for user-defined slash commands — shared
 * by the Composer and the Settings manager so both stay unit-testable
 * without React. Nothing in here touches the DOM.
 */

/**
 * Reject anything that isn't a simple identifier — letters, digits, `_`,
 * `-`. We mirror the existing `getSlashQuery` charset (plus `-`) so the
 * user's custom name is round-trippable through `/name` without escaping.
 */
export const CUSTOM_COMMAND_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/** Built-in reserved names — must match `parseReservedSlashCommand`. The
 *  existing composer treats `/goal`, `/pet`, and `/compact` as system
 *  commands that get routed to dedicated handlers; creating a custom
 *  command with those names would shadow them. */
const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set(['goal', 'pet', 'compact'])

export function isValidCustomCommandName(name: string): boolean {
  return name.length > 0 && CUSTOM_COMMAND_NAME_PATTERN.test(name)
}

export function isReservedCommandName(name: string): boolean {
  return RESERVED_COMMAND_NAMES.has(name.toLowerCase())
}

export function getReservedCommandNames(): string[] {
  return Array.from(RESERVED_COMMAND_NAMES)
}

/** Kept local so the composer's types stay self-contained; used by rankCustomCommands. */
function fuzzyMatch(haystack: string, needle: string): boolean {
  let j = 0
  for (let i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack[i] === needle[j]) j++
  }
  return j === needle.length
}

/** Pure ranking for the slash palette: lower = better. Backed matches are
 *  ranked below real hits. Returns the input set unchanged when the query
 *  is empty. */
export function rankCustomCommands(
  commands: readonly CustomSlashCommand[],
  query: string,
): CustomSlashCommand[] {
  const trimmed = query.trim()
  if (!trimmed) return commands.slice()
  const normalized = trimmed.toLowerCase()
  const scored = commands
    .map(command => {
      const name = command.name.toLowerCase()
      const description = command.description.toLowerCase()
      const body = command.body.toLowerCase()
      const score =
        name === normalized ? 0 :
        name.startsWith(normalized) ? 1 :
        name.includes(normalized) ? 2 :
        description.includes(normalized) ? 3 :
        body.includes(normalized) ? 4 :
        fuzzyMatch(name, normalized) || fuzzyMatch(description, normalized) ? 5 :
        99
      return { command, score }
    })
    .filter(item => item.score < 99)
    .sort((a, b) => a.score - b.score || a.command.name.localeCompare(b.command.name))
  return scored.map(item => item.command)
}

/**
 * What the composer receives when the user selects a custom command from
 * the slash palette. The body is inserted verbatim so multi-line templates
 * (with embedded code snippets, lists, etc.) round-trip cleanly. We pad a
 * single trailing space if the body doesn't already end in whitespace so
 * the user can keep typing after a sentence-ending template.
 */
export function getCustomCommandToken(command: CustomSlashCommand): string {
  const body = command.body ?? ''
  if (!body.trim()) {
    return `/${command.name} `
  }
  const lastChar = body[body.length - 1]
  if (lastChar === ' ' || lastChar === '\n' || lastChar === '\t' || lastChar === '\r') {
    return body
  }
  return body + ' '
}

export function getCustomCommandLabel(command: CustomSlashCommand): string {
  return `/${command.name}`
}

/** Stable id generator shared by the composer and the settings manager.
 *  `crypto.randomUUID()` is widely available in modern WebView runtimes and
 *  Node 19+; the fallback handles extremely old environments. */
export function generateCustomCommandId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // RFC4122-ish fallback — sufficient for local in-memory uniqueness.
  const block = (length: number) =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${block(8)}-${block(4)}-4${block(3)}-${block(4)}-${block(12)}`
}
