import { invoke } from '@tauri-apps/api/core'
import { describe, expect, it, vi } from 'vitest'
import {
  annotationStillCurrent,
  createAnnotationAttachment,
  browserAnnotationLocationLabel,
  expandBrowserAnnotationSnapshots,
  isVisualAttachment,
  parseBrowserPageMessage,
  promoteBrowserAttachments,
} from './browserAnnotations'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

describe('browser annotation messages', () => {
  it('rejects malformed page messages', () => {
    expect(parseBrowserPageMessage('hello:https://example.com')).toBeNull()
    expect(parseBrowserPageMessage('{"type":"annotation-candidate"}')).toBeNull()
  })

  it('rejects forged URLs, oversized payloads, and unsafe annotation geometry', () => {
    expect(parseBrowserPageMessage('{"type":"page-ready","url":"not a url","historyLength":1}')).toBeNull()
    expect(parseBrowserPageMessage(JSON.stringify({
      type: 'page-loaded', url: 'https://example.com', padding: 'x'.repeat(70_000),
    }))).toBeNull()
    expect(parseBrowserPageMessage(JSON.stringify({
      type: 'annotation-candidate', token: 'candidate-1', kind: 'pen', url: 'https://example.com',
      rect: { x: 10, y: 20, width: -1, height: 30 },
      viewport: { width: 800, height: 600 },
    }))).toBeNull()
    expect(parseBrowserPageMessage('{"type":"annotation-candidate","token":"candidate-1","kind":"element","url":"https://example.com","rect":{"x":0,"y":0,"width":1e999,"height":30},"viewport":{"width":800,"height":600}}')).toBeNull()
  })

  it('distinguishes document-start readiness from a fully loaded page', () => {
    expect(parseBrowserPageMessage('{"type":"page-ready","url":"https://example.com","historyLength":1}'))
      .toMatchObject({ type: 'page-ready', url: 'https://example.com' })
    expect(parseBrowserPageMessage('{"type":"page-loaded","url":"https://example.com"}'))
      .toEqual({ type: 'page-loaded', url: 'https://example.com' })
  })

  it('creates a removable visual attachment plus a hidden viewport image', () => {
    const attachment = createAnnotationAttachment({
      type: 'annotation-candidate', token: '1', kind: 'element', url: 'http://localhost:3000',
      selector: '#save', component: 'SaveButton',
      rect: { x: 10, y: 20, width: 100, height: 50 },
      viewport: { width: 800, height: 600 },
    }, 'Increase the spacing', {
      cropPath: '/tmp/crop.png', viewportPath: '/tmp/viewport.png',
      cropWidth: 200, cropHeight: 100, viewportWidth: 1600, viewportHeight: 1200,
      cropBytes: 1200, viewportBytes: 9000,
    })

    expect(attachment).toMatchObject({
      kind: 'browser-annotation', path: '/tmp/crop.png', mediaType: 'image/png',
      browserAnnotation: { component: 'SaveButton', note: 'Increase the spacing' },
    })
    expect(attachment.extractedText).toContain('Selector: #save')
    expect(attachment.extractedText).toContain('User note (authoritative instruction): Increase the spacing')
    expect(attachment.extractedText).toContain('Apply the requested change only to the selected element matched by selector #save')
    expect(expandBrowserAnnotationSnapshots([attachment])).toMatchObject([
      { kind: 'browser-annotation', path: '/tmp/crop.png' },
      { kind: 'image', path: '/tmp/viewport.png', width: 1600, height: 1200 },
    ])
  })

  it('classifies crops and ordinary images equally for vision consent', () => {
    expect(isVisualAttachment({ kind: 'image' })).toBe(true)
    expect(isVisualAttachment({ kind: 'browser-annotation' })).toBe(true)
    expect(isVisualAttachment({ kind: 'file' })).toBe(false)
  })

  it('labels both hosted and local-file annotations without an empty suffix', () => {
    expect(browserAnnotationLocationLabel('http://localhost:5173/example')).toBe('localhost')
    expect(browserAnnotationLocationLabel('file:///tmp/browser-qa.html')).toBe('browser-qa.html')
  })

  it('promotes both annotation images before they are persisted in a transcript', async () => {
    const attachment = createAnnotationAttachment({
      type: 'annotation-candidate', token: '1', kind: 'pen', url: 'http://localhost:3000',
      rect: { x: 10, y: 20, width: 100, height: 50 }, viewport: { width: 800, height: 600 },
    }, 'Ação mais clara', {
      cropPath: '/tmp/verboo-browser/crop.png', viewportPath: '/tmp/verboo-browser/viewport.png',
      cropWidth: 200, cropHeight: 100, viewportWidth: 1600, viewportHeight: 1200,
      cropBytes: 1200, viewportBytes: 9000,
    })
    vi.mocked(invoke).mockResolvedValue([
      { from: '/tmp/verboo-browser/crop.png', to: '/app/browser_captures/owner/crop.png' },
      { from: '/tmp/verboo-browser/viewport.png', to: '/app/browser_captures/owner/viewport.png' },
    ])

    const [promoted] = await promoteBrowserAttachments([attachment], 'conversation-1')

    expect(invoke).toHaveBeenCalledWith('browser_promote_temp_files', {
      ownerId: 'conversation-1',
      paths: ['/tmp/verboo-browser/crop.png', '/tmp/verboo-browser/viewport.png'],
    })
    expect(promoted).toMatchObject({
      path: '/app/browser_captures/owner/crop.png',
      browserAnnotation: {
        crop: '/app/browser_captures/owner/crop.png',
        viewportSnapshot: { path: '/app/browser_captures/owner/viewport.png' },
      },
    })
  })
})

describe('annotation identity and stale capture discard', () => {
  it('keeps a capture current when the originating tab and generation match', () => {
    expect(annotationStillCurrent(
      { tabId: 'tab-a', generation: 3, url: 'http://localhost:5173' },
      { id: 'tab-a', generation: 3 },
    )).toBe(true)
  })

  it('drops a capture after the originating tab navigates (generation advanced)', () => {
    expect(annotationStillCurrent(
      { tabId: 'tab-a', generation: 3, url: 'http://localhost:5173' },
      { id: 'tab-a', generation: 4 },
    )).toBe(false)
  })

  it('drops a capture after the originating tab is closed (different tabId)', () => {
    expect(annotationStillCurrent(
      { tabId: 'tab-a', generation: 3, url: 'http://localhost:5173' },
      { id: 'tab-b', generation: 3 },
    )).toBe(false)
  })
})
