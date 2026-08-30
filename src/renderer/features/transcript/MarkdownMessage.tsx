import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { openUrl } from '@tauri-apps/plugin-opener'
import { MarkdownLinkDialog } from './MarkdownLinkDialog'
import { parseLinkDestination, type LinkDestination } from './markdownLink'

// The model often emits blank lines between numbered list items (loose
// markdown). CommonMark renders loose lists with extra <p> wrappers inside
// each <li>, creating unavoidable visual gaps. We tighten the source before
// the parser sees it so the list renders in "tight" mode — no parasitic <p>.
//
//   "1. a\n\n`b`\n\n2. c\n\n3. d"  →  "1. a\n\n`b`\n2. c\n3. d"
//
// Only the blank line *before* the next item marker is removed; text content
// with its own paragraph breaks is untouched.
export function densifyMarkdown(input: string): string {
  let s = input.replace(/\r\n/g, '\n').trim()
  // Collapse 3+ consecutive blank lines → at most one blank line
  s = s.replace(/\n{3,}/g, '\n\n')
  // Tighten numbered lists: remove blank line before next item
  s = s.replace(/\n[ \t]*\n+(?=[ \t]*\d+\.[ \t])/g, '\n')
  // Tighten bullet lists
  s = s.replace(/\n[ \t]*\n+(?=[ \t]*[-*+][ \t])/g, '\n')
  return s
}

/** Normalize model thinking text into flowing prose rather than chopped
 *  line-by-line output. Applies densifyMarkdown first (removes parasitic gaps
 *  between list items), then joins consecutive short prose lines that are not
 *  part of list markers, code fences, headers, or explicit paragraph breaks.
 *
 *  A short line is one that doesn't end in sentence punctuation (.!?:;) and
 *  is under ~65 chars — meaning the model line-broke it for display, not for
 *  semantic structure. Real markdown (code blocks, headings, lists) passes
 *  through untouched. */
export function normalizeThinkingProse(input: string): string {
  const s = densifyMarkdown(input)
  const lines = s.split('\n')
  const result: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trimEnd()
    const isBreak = trimmed === ''
      || /^\s*(?:[-*+]|\d+\.|[#>]|```|─+)/.test(trimmed)
      || /[!?:;]\s*$/.test(trimmed)
      || trimmed.length > 65
      || /^```/.test(trimmed.trimStart())
      || /^#{1,6}\s/.test(trimmed.trimStart())

    if (isBreak) {
      result.push(line)
      i++
      continue
    }

    // Accumulate consecutive short prose lines, then join with spaces.
    const joinPhrase: string[] = [line]
    let j = i + 1
    while (j < lines.length) {
      const next = lines[j]
      const nt = next.trimEnd()
      const nBreak = nt === ''
        || /^\s*(?:[-*+]|\d+\.|[#>]|```|─+)/.test(nt)
        || /[!?:;]\s*$/.test(nt)
        || nt.length > 65
        || /^```/.test(nt.trimStart())
        || /^#{1,6}\s/.test(nt.trimStart())
      if (nBreak) {
        result.push(joinPhrase.map((_, idx) => lines[i + idx]).join(' ').replace(/\s+/g, ' '))
        i = j
        break
      }
      joinPhrase.push(next)
      j++
    }
    if (j >= lines.length) {
      result.push(joinPhrase.join(' ').replace(/\s+/g, ' '))
      i = j
    }
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Assistant messages arrive as markdown but were historically rendered as plain
// text. react-markdown renders them safely (raw HTML is NOT rendered → no XSS)
// and is tolerant of the *incomplete* markdown that streaming produces — an
// unclosed ``` fence just renders as a growing code block instead of breaking.
//   - remark-gfm: tables, task lists, strikethrough, autolinks
//   - rehype-highlight: syntax highlighting for fenced code blocks (highlight.js)
// Links are confirmed before opening in the system browser; the webview never
// navigates away from the active conversation.

function MarkdownLink({ href, children, onRequestOpen }: {
  href?: string
  children?: ReactNode
  onRequestOpen: (destination: LinkDestination) => void
}) {
  return (
    <a
      href={href}
      onClick={event => {
        event.preventDefault()
        const destination = parseLinkDestination(href)
        if (destination) onRequestOpen(destination)
      }}
    >
      {children}
    </a>
  )
}

export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  const [destination, setDestination] = useState<LinkDestination | undefined>()

  const openConfirmedLink = () => {
    if (!destination) return
    void openUrl(destination.href).catch(() => undefined)
    setDestination(undefined)
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ href, children }) => (
            <MarkdownLink href={href} onRequestOpen={setDestination}>{children}</MarkdownLink>
          ),
        }}
      >
        {densifyMarkdown(text)}
      </ReactMarkdown>
      {destination && (
        <MarkdownLinkDialog
          destination={destination}
          onCancel={() => setDestination(undefined)}
          onConfirm={openConfirmedLink}
        />
      )}
    </div>
  )
})
