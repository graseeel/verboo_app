import type { AttachmentMeta } from '../../../shared/types'

export function isLocalBrowserUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'file:') return true
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const hostname = url.hostname.toLowerCase()
    return hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '127.0.0.1'
      || hostname === '0.0.0.0'
      || hostname === '[::1]'
      || hostname === '::1'
  } catch {
    return false
  }
}

export function findLocalBrowserUrl(text: string): string | undefined {
  const candidates = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? []
  for (const candidate of candidates) {
    const trimmed = candidate.replace(/[),.;!?]+$/g, '')
    if (!isLocalBrowserUrl(trimmed)) continue
    try {
      const url = new URL(trimmed)
      if (url.username || url.password) continue
      return url.toString()
    } catch {
      // Keep scanning later URL candidates.
    }
  }
  return undefined
}

export function shouldScheduleBrowserReload(input: {
  annotationCount: number
  workspaceChangeCount: number
  browserOpen: boolean
  browserUrl: string
}): boolean {
  return input.annotationCount > 0
    && input.workspaceChangeCount > 0
    && input.browserOpen
    && isLocalBrowserUrl(input.browserUrl)
}

export type PreviewRoute =
  | { kind: 'activate'; tabId: string }
  | { kind: 'navigate'; tabId: string }
  | { kind: 'create' }

/**
 * Normalize a URL solely for comparison: lowercase scheme + host, strip
 * default port (80/443), preserve path + query + fragment, remove trailing
 * slash for root path. Returns null on parse failure.
 */
export function normalizeUrlForComparison(raw: string): string | null {
  try {
    const u = new URL(raw)
    const port = u.port && (u.port !== '80' || u.protocol !== 'http:') && (u.port !== '443' || u.protocol !== 'https:') ? `:${u.port}` : ''
    let pathname = u.pathname
    if (pathname === '/') pathname = ''
    else if (pathname.endsWith('/')) pathname = pathname.slice(0, -1)
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}${pathname}${u.search}${u.hash}`
  } catch { return null }
}

/**
 * Deterministic preview routing:
 * 1. Activate tab already at the SAME normalized URL
 * 2. Navigate the active tab if it's blank
 * 3. Create a new tab
 */
export function routePreview(
  session: { tabs: Array<{ id: string; url: string }>; activeTabId: string | null },
  previewUrl: string,
): PreviewRoute {
  const normalized = normalizeUrlForComparison(previewUrl)
  if (!normalized) return { kind: 'navigate', tabId: session.activeTabId ?? '' }

  for (const tab of session.tabs) {
    if (tab.id === session.activeTabId) continue
    if (normalizeUrlForComparison(tab.url) === normalized) {
      return { kind: 'activate', tabId: tab.id }
    }
  }
  if (session.activeTabId) {
    const active = session.tabs.find(t => t.id === session.activeTabId)
    if (active && normalizeUrlForComparison(active.url) === normalized) {
      return { kind: 'activate', tabId: active.id }
    }
  }

  if (session.activeTabId) {
    const active = session.tabs.find(t => t.id === session.activeTabId)
    if (active && (active.url === 'about:blank' || active.url === '')) {
      return { kind: 'navigate', tabId: active.id }
    }
  }

  return { kind: 'create' }
}

export function postEditVerificationPrompt(
  annotations: AttachmentMeta[],
  language: 'en-US' | 'pt-BR',
): string {
  const details = annotations.flatMap(attachment => {
    const annotation = attachment.browserAnnotation
    if (!annotation) return []
    return [
      `- ${annotation.kind}: ${annotation.note || annotation.component || annotation.selector || annotation.url}`,
    ]
  }).join('\n')
  if (language === 'pt-BR') {
    return [
      'Verifique visualmente o resultado pós-edição no screenshot anexado.',
      'Compare com as anotações originais abaixo. Confirme o que ficou correto e liste somente problemas visuais restantes.',
      details,
      'Não edite arquivos neste mini-turno de verificação.',
    ].filter(Boolean).join('\n')
  }
  return [
    'Visually verify the post-edit result in the attached screenshot.',
    'Compare it with the original annotations below. Confirm what is correct and list only remaining visual issues.',
    details,
    'Do not edit files during this verification mini-turn.',
  ].filter(Boolean).join('\n')
}
