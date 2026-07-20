export type LinkDestination = {
  href: string
  kind: 'local' | 'external'
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function parseLinkDestination(href?: string): LinkDestination | undefined {
  if (!href) return undefined

  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return {
      href,
      kind: LOCAL_HOSTS.has(url.hostname) ? 'local' : 'external',
    }
  } catch {
    return undefined
  }
}
