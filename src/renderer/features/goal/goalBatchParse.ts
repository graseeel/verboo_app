/**
 * T5: the batch ENTRY parser — turns the /goal text into tasks.
 *
 * The user pastes lists from everywhere (issues, notes, diffs, chat), so
 * the parser is TOLERANT on input and STRICT on outcome. The batch is
 * implicit: ONE task per line — two or more cleaned lines make a batch.
 *
 * Accepted line decorations (stripped):
 *   - Numbered markers:  "1. task", "2) task" — ANY number, sequence NOT
 *     enforced (a pasted "1. 1. 1." from a lazy source is still a list).
 *   - Bullet markers:    "-", "*", "•", "–", "—" followed by whitespace.
 *   - Up to TWO stacked markers per line ("- 1. task" happens in the
 *     wild when a numbered list is pasted inside a bulleted one).
 *   - Blank lines are IGNORED (they are not separators — one task per
 *     line, whatever the spacing).
 *   - Surrounding whitespace trimmed everywhere; CRLF handled.
 *
 * TOOLLESS flag (T1's per-task opt-out, T4 already reports it):
 *   "[toolless]" ANYWHERE in the line, case-insensitive — the first
 *   occurrence is stripped and the task is flagged. Chosen over a prefix
 *   sigil ("~") because it is self-describing in both locales and can
 *   not collide with a real task text the way punctuation can.
 *
 * Outcome:
 *   - 0 cleaned lines  → { kind: 'empty' }   — the caller shows the
 *     useful error (goal.batchEmpty) and starts NOTHING. A line that
 *     was ONLY a marker or ONLY the toolless tag counts as empty.
 *   - 1 cleaned line   → { kind: 'single' }  — a LEGACY single-task
 *     goal. CRITICAL (aceite d): one task behaves EXACTLY as before —
 *     no batch keys, no D1 batch guard, no progress line, no per-task
 *     report. The objective is the cleaned line; for marker-less input
 *     it is byte-identical to what pre-T5 /goal received.
 *   - ≥2 cleaned lines → { kind: 'batch' }   — task seeds for
 *     createGoalState, order preserved.
 */

export type BatchTaskSeed = { text: string; toolless?: boolean }

export type BatchParseResult =
  | { kind: 'single'; objective: string }
  | { kind: 'batch'; tasks: BatchTaskSeed[] }
  | { kind: 'empty' }

// "1." / "12)" / "-" / "*" / "•" / "–" / "—" at the line start, followed
// by whitespace. Requires the space so "1.task" stays task text (it is
// more likely a version number or a typo than a list marker).
const LINE_MARKER = /^(\d+[.)]|[-*•–—])\s+/
const TOOLLESS_TAG = /\[toolless\]/i

function cleanLine(line: string): string {
  let text = line.trim()
  // Up to two stacked markers ("- 1. task"); a loop would also eat a
  // task that genuinely starts with three marker-like tokens, which is
  // why the cap exists.
  for (let i = 0; i < 2 && LINE_MARKER.test(text); i++) {
    text = text.replace(LINE_MARKER, '').trim()
  }
  // A line that is ONLY a marker ("1.", "-", "2)") has no trailing
  // whitespace for LINE_MARKER to anchor on — catch it here so it
  // counts as empty, not as a task named "-".
  if (/^(\d+[.)]|[-*•–—])$/.test(text)) return ''
  return text
}

export function parseBatchInput(raw: string): BatchParseResult {
  const seeds: BatchTaskSeed[] = []
  for (const line of raw.split(/\r?\n/)) {
    let text = cleanLine(line)
    let toolless = false
    const tag = TOOLLESS_TAG.exec(text)
    if (tag) {
      toolless = true
      // Collapse the gap the tag leaves behind ("a [toolless] b" would
      // otherwise keep a double space).
      text = (text.slice(0, tag.index) + text.slice(tag.index + tag[0].length))
        .replace(/\s{2,}/g, ' ')
        .trim()
    }
    if (!text) continue // blank line, bare marker, bare tag — ignored
    seeds.push(toolless ? { text, toolless: true } : { text })
  }

  if (seeds.length === 0) return { kind: 'empty' }
  // Single task → LEGACY goal. The toolless flag is intentionally
  // DROPPED here: legacy goals have no D1 evidence guard (T1 aceite 4),
  // so there is nothing to opt out of — the stripped text is enough.
  if (seeds.length === 1) return { kind: 'single', objective: seeds[0].text }
  return { kind: 'batch', tasks: seeds }
}
