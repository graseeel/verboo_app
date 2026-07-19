/**
 * Pure functions for the @-mention skill palette in the composer.
 *
 * The @-mention regex mirrors getSlashQuery (/): it detects @query at the
 * cursor (end of text), shows a skill palette, and on selection adds the
 * skill chip to selectedSkills while removing the @query from the text.
 * No textual @tokens remain after selection (Plan D).
 */

import type { SkillSummary } from '../../../shared/types'

/** Detect an unfinished @-mention query at the cursor position.
 *  Returns the query string (possibly empty) or undefined if no @ is active. */
export function getAtQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)@([^\s]*)$/)
  return match ? match[1] : undefined
}

/** Replace the @-mention query at cursor with a token (Feedback-3 ITEM 2b).
 *  When the user selects a skill from the @ palette, the @query is replaced
 *  with `@<skill-name> ` so the text retains the reference as an inline token. */
export function replaceAtQueryWithToken(value: string, token: string): string {
  const match = value.match(/(?:^|\s)@[^\s]*$/)
  if (match) {
    const prefix = match.index ? value.slice(0, match.index) : ''
    const leadingSpace = prefix.length > 0 && !prefix.endsWith(' ') ? ' ' : ''
    return prefix + leadingSpace + token
  }
  return value + ' ' + token
}

/** Remove the @-mention query (Escape). Preserves trailing space. */
export function removeAtQuery(value: string): string {
  return value.replace(/(?:^|\s)@[^\s]*$/, match => (match.startsWith(' ') ? ' ' : ''))
}

/** Fuzzy rank skills by @-mention query (same ranking as / palette).
 *  Name matches are weighted higher than description matches.
 *  Returns results sorted by relevance. */
export function rankSkills(skills: SkillSummary[], query: string): SkillSummary[] {
  const normalizedQuery = query.toLowerCase()
  return skills
    .map(skill => {
      const name = skill.name.toLowerCase()
      const description = skill.description.toLowerCase()
      const score =
        name === normalizedQuery ? 0 :
        name.startsWith(normalizedQuery) ? 1 :
        name.includes(normalizedQuery) ? 2 :
        description.includes(normalizedQuery) ? 3 :
        fuzzyMatch(name, normalizedQuery) || fuzzyMatch(description, normalizedQuery) ? 4 :
        99
      return { skill, score }
    })
    .filter(item => item.score < 99)
    .sort((a, b) => a.score - b.score || a.skill.name.localeCompare(b.skill.name))
    .map(item => item.skill)
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
