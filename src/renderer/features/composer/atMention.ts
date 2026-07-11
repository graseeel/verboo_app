/**
 * Pure functions for the @-mention file palette in the composer.
 *
 * The @-mention regex mirrors getSlashQuery (/): it detects @query at the
 * cursor (end of text), shows a file palette, and on selection replaces the
 * @query with the full @relative/path token.
 */

/** Detect an unfinished @-mention query at the cursor position.
 *  Returns the query string (possibly empty) or undefined if no @ is active. */
export function getAtQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)@([^\s]*)$/)
  return match ? match[1] : undefined
}

/** Replace the @-mention query at cursor with a concrete @path token.
 *  If no @-mention is active, appends the token with a leading space. */
export function replaceAtQueryWithToken(value: string, token: string): string {
  if (getAtQuery(value) === undefined) return `${value}${value.endsWith(' ') || !value ? '' : ' '}${token}`
  return value.replace(/(?:^|\s)@[^\s]*$/, match => {
    const prefix = match.startsWith(' ') ? ' ' : ''
    return `${prefix}${token}`
  })
}

/** Remove the @-mention query (Escape). Preserves trailing space. */
export function removeAtQuery(value: string): string {
  return value.replace(/(?:^|\s)@[^\s]*$/, match => (match.startsWith(' ') ? ' ' : ''))
}

/** Fuzzy rank workspace files by @-mention query.
 *  Basename matches are weighted higher than full-path matches.
 *  Returns results sorted by relevance. */
export function rankFiles(files: string[], query: string): string[] {
  const normalizedQuery = query.toLowerCase()
  return files
    .map(file => {
      const basename = file.split('/').pop() ?? file
      const base = basename.toLowerCase()
      const full = file.toLowerCase()
      const score =
        base === normalizedQuery ? 0 :
        base.startsWith(normalizedQuery) ? 1 :
        base.includes(normalizedQuery) ? 2 :
        full.includes(normalizedQuery) ? 3 :
        fuzzyMatch(base, normalizedQuery) || fuzzyMatch(full, normalizedQuery) ? 4 :
        99
      return { file, score, base }
    })
    .filter(item => item.score < 99)
    .sort((a, b) => a.score - b.score || a.base.localeCompare(b.base) || a.file.localeCompare(b.file))
    .map(item => item.file)
}

/** Fuzzy match: does every character of query appear in value in order? */
function fuzzyMatch(value: string, query: string): boolean {
  if (!query) return true
  let index = 0
  for (const char of value) {
    if (char === query[index]) index += 1
    if (index === query.length) return true
  }
  return false
}

/** Extract @-mention file paths from text (for highlighting tokens). */
export function extractAtTokens(value: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of value.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    tokens.add(match[1].toLowerCase())
  }
  return tokens
}
