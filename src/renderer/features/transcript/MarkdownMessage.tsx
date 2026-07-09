import { memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { openUrl } from '@tauri-apps/plugin-opener'

// ── densifyMarkdown ──────────────────────────────────────────────────────
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

// Assistant messages arrive as markdown but were historically rendered as plain
// text. react-markdown renders them safely (raw HTML is NOT rendered → no XSS)
// and is tolerant of the *incomplete* markdown that streaming produces — an
// unclosed ``` fence just renders as a growing code block instead of breaking.
//   - remark-gfm: tables, task lists, strikethrough, autolinks
//   - rehype-highlight: syntax highlighting for fenced code blocks (highlight.js)
// Links open in the system browser instead of navigating the webview away.

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      onClick={event => {
        event.preventDefault()
        if (href) void openUrl(href).catch(() => undefined)
      }}
    >
      {children}
    </a>
  )
}

export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{ a: MarkdownLink }}
      >
        {densifyMarkdown(text)}
      </ReactMarkdown>
    </div>
  )
})
