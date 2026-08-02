import { describe, expect, it } from 'vitest'
import { findLocalBrowserUrl, isLocalBrowserUrl, normalizeUrlForComparison, postEditVerificationPrompt, routePreview, shouldScheduleBrowserReload } from './browserPostEdit'

describe('browser post-edit verification', () => {
  it('allows only local development URLs', () => {
    expect(isLocalBrowserUrl('http://localhost:5173/app')).toBe(true)
    expect(isLocalBrowserUrl('https://preview.localhost/test')).toBe(true)
    expect(isLocalBrowserUrl('http://127.0.0.1:3000')).toBe(true)
    expect(isLocalBrowserUrl('file:///tmp/index.html')).toBe(true)
    expect(isLocalBrowserUrl('https://example.com')).toBe(false)
    expect(isLocalBrowserUrl('javascript:alert(1)')).toBe(false)
  })

  it('extracts a local preview URL from streamed model text without accepting external URLs', () => {
    expect(findLocalBrowserUrl('Preview ready at http://127.0.0.1:8765/. Open it now.'))
      .toBe('http://127.0.0.1:8765/')
    expect(findLocalBrowserUrl('Docs: https://example.com and local: http://localhost:5173/app.'))
      .toBe('http://localhost:5173/app')
    expect(findLocalBrowserUrl('Only https://example.com is available.')).toBeUndefined()
  })

  it('builds a capability-neutral localized verification prompt', () => {
    const prompt = postEditVerificationPrompt([{
      path: '/tmp/crop.png', name: 'crop.png', size: 1, kind: 'browser-annotation',
      browserAnnotation: {
        kind: 'element', crop: '/tmp/crop.png', url: 'http://localhost:3000', note: 'Mais espaço',
        rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 },
      },
    }], 'pt-BR')
    expect(prompt).toContain('Mais espaço')
    expect(prompt).toContain('Não edite arquivos')
  })

  it('schedules after a shell edit when the workspace diff changed', () => {
    expect(shouldScheduleBrowserReload({
      annotationCount: 1,
      workspaceChangeCount: 1,
      browserOpen: true,
      browserUrl: 'http://localhost:5173',
    })).toBe(true)
    expect(shouldScheduleBrowserReload({
      annotationCount: 1,
      workspaceChangeCount: 0,
      browserOpen: true,
      browserUrl: 'http://localhost:5173',
    })).toBe(false)
  })
})

describe('local preview routing', () => {
  function tabSnapshot(input: { id: string; generation: number; url: string }) {
    return { id: input.id, generation: input.generation, url: input.url }
  }

  it('activates an existing tab already at the same normalized URL', () => {
    const session = {
      tabs: [
        tabSnapshot({ id: 'tab-a', generation: 1, url: 'http://127.0.0.1:5173' }),
        tabSnapshot({ id: 'tab-b', generation: 1, url: 'http://127.0.0.1:5174' }),
      ],
      activeTabId: 'tab-b',
    }
    expect(routePreview(session, 'http://127.0.0.1:5173')).toEqual({ kind: 'activate', tabId: 'tab-a' })
  })

  it('navigates the active tab when it is blank', () => {
    const session = {
      tabs: [tabSnapshot({ id: 'tab-b', generation: 0, url: 'about:blank' })],
      activeTabId: 'tab-b',
    }
    expect(routePreview(session, 'http://127.0.0.1:5174')).toEqual({ kind: 'navigate', tabId: 'tab-b' })
  })

  it('creates a new tab when the active tab is occupied', () => {
    const session = {
      tabs: [tabSnapshot({ id: 'tab-c', generation: 1, url: 'http://example.com' })],
      activeTabId: 'tab-c',
    }
    expect(routePreview(session, 'http://127.0.0.1:5175')).toEqual({ kind: 'create' })
  })

  it('normalizes URLs for comparison: lowercase scheme+host, strip default port, preserve path+query, ignore trailing slash at root', () => {
    expect(normalizeUrlForComparison('http://LocalHost:80/app')).toBe('http://localhost/app')
    expect(normalizeUrlForComparison('https://example.com:443/')).toBe('https://example.com')
    expect(normalizeUrlForComparison('http://localhost:5173/app/')).toBe('http://localhost:5173/app')
    expect(normalizeUrlForComparison('http://localhost:5173/app?q=1#frag')).toBe('http://localhost:5173/app?q=1#frag')
    expect(normalizeUrlForComparison('not a url')).toBeNull()
  })
})
