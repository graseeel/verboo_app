import { memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { openUrl } from '@tauri-apps/plugin-opener'

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
        {text}
      </ReactMarkdown>
    </div>
  )
})
