import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type InjectedApi = {
  ping: () => string
  announce: () => void
  setMode: (mode: string) => void
  openNoteModal: (token: string) => void
  restoreCandidate: (candidate: { token: string, kind: string, rect: DOMRectInit }) => void
}

const source = readFileSync(resolve(process.cwd(), 'src-tauri/src/services/browser_inject.js'), 'utf8')

type NativeTransport = {
  tabId: string
  bridgeToken: string
  documentToken: string
  post: ReturnType<typeof vi.fn>
}

function setupTransport(): NativeTransport {
  const post = vi.fn()
  Object.defineProperty(globalThis, '__VERBOO_NATIVE_TRANSPORT__', {
    configurable: true,
    value: { tabId: 'test-tab', bridgeToken: 'bridge-token', documentToken: 'doc-token', post },
  })
  return { tabId: 'test-tab', bridgeToken: 'bridge-token', documentToken: 'doc-token', post }
}

/** Extract the inner (payload) message from transport call envelope. */
function payloadsFrom(transport: NativeTransport): unknown[] {
  return transport.post.mock.calls.map((call) => {
    const raw = (call as [string])[0]
    return JSON.parse(JSON.parse(raw).payload)
  })
}

/**
 * jsdom's new MouseEvent() always has isTrusted=false (non-configurable).
 * Behavioral tests that dispatch events must use a source copy with the
 * trust guard removed; the unmodified source is used by the synthetic-event
 * rejection tests which PROVE the guard works. Production source is NOT
 * modified — verified by source scan.
 */
function trustedSource(): string {
  return source.replaceAll('!event.isTrusted', '0')
}

function installInteractiveLayer(opts?: { trustedEvents?: boolean }) {
  const transport = setupTransport()
  const attachShadow = Element.prototype.attachShadow
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    return attachShadow.call(this, { ...init, mode: 'open' })
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  Object.defineProperty(HTMLCanvasElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
  window.eval(opts?.trustedEvents !== false ? trustedSource() : source)
  const api = (window as Window & { __verbooBrowser?: InjectedApi }).__verbooBrowser!
  const hosts = document.querySelectorAll<HTMLElement>('[data-verboo-browser-layer]')
  const root = hosts.item(hosts.length - 1).shadowRoot!
  transport.post.mockClear()
  return { api, transport, root }
}

describe('browser injected layer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    document.documentElement.innerHTML = '<head><title>Injected test</title></head><body><button>Target</button></body>'
    delete (window as Window & { __verbooBrowser?: InjectedApi }).__verbooBrowser
    delete (globalThis as Record<string, unknown>).__VERBOO_NATIVE_TRANSPORT__
  })

  it('is idempotent and announces a structured page-ready message via the native transport', () => {
    const transport = setupTransport()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    window.eval(source)
    const first = (window as Window & { __verbooBrowser?: InjectedApi }).__verbooBrowser
    window.eval(source)
    const second = (window as Window & { __verbooBrowser?: InjectedApi }).__verbooBrowser
    window.dispatchEvent(new PageTransitionEvent('pageshow'))

    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(first?.ping()).toContain('pong:')
    const messages = payloadsFrom(transport)
    expect(messages.filter(m => (m as Record<string, unknown>).type === 'page-ready')).toHaveLength(3)
    expect(messages[0]).toMatchObject({
      type: 'page-ready',
      title: 'Injected test',
      viewport: { width: expect.any(Number), height: expect.any(Number) },
    })
  })

  it('captures a pencil gesture and submits its accented note from the popup', () => {
    const { api, transport, root } = installInteractiveLayer()
    const canvas = root.getElementById('ink')!
    api.setMode('pencil')
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 50 }))
    canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, button: 0, clientX: 120, clientY: 130 }))
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 160, clientY: 180 }))

    const candidate = payloadsFrom(transport)
      .find(m => (m as Record<string, unknown>).type === 'annotation-candidate') as Record<string, unknown> | undefined
    expect(candidate).toMatchObject({ kind: 'pen', rect: { x: 26, y: 36 } })

    api.openNoteModal(candidate!.token as string)
    const card = root.getElementById('card')!
    expect(card.getAttribute('data-placement')).toBe('below')
    expect(card.style.getPropertyValue('--anchor-x')).toMatch(/px$/)
    expect(root.getElementById('modal')?.getAttribute('aria-hidden')).toBe('false')
    const note = root.getElementById('note') as HTMLTextAreaElement
    note.value = 'Ação, espaçamento e você'
    note.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))

    const submitted = payloadsFrom(transport)
      .find(m => (m as Record<string, unknown>).type === 'annotation-submit') as Record<string, unknown> | undefined
    expect(submitted).toMatchObject({ token: candidate!.token, note: 'Ação, espaçamento e você' })
    expect(root.getElementById('modal')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('selects an element by a stable front-end category and submits the arrow popup', () => {
    document.body.innerHTML = '<button id="save" data-component="PrimaryAction">Salvar</button>'
    const target = document.getElementById('save')!
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 80, left: 100, top: 80, right: 220, bottom: 120, width: 120, height: 40,
      toJSON: () => ({}),
    })
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) })
    const { api, transport, root } = installInteractiveLayer()
    const picker = root.getElementById('picker')!
    api.setMode('arrow')
    picker.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 140, clientY: 100 }))
    picker.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 140, clientY: 100 }))

    const candidate = payloadsFrom(transport)
      .find(m => (m as Record<string, unknown>).type === 'annotation-candidate') as Record<string, unknown> | undefined
    expect(candidate).toMatchObject({ kind: 'element', selector: '#save', component: 'PrimaryAction' })

    api.openNoteModal(candidate!.token as string)
    expect(root.getElementById('title')?.textContent).toBe('Type your suggestion')
    const note = root.getElementById('note') as HTMLTextAreaElement
    note.value = 'Alinhar com o campo acima'
    note.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    expect(payloadsFrom(transport))
      .toContainEqual(expect.objectContaining({ type: 'annotation-submit', note: 'Alinhar com o campo acima' }))
  })

  it('keeps frequent picker feedback instant and offers a reduced-motion presence path', () => {
    expect(source).not.toContain('width 90ms ease-out,height 90ms ease-out')
    expect(source).toContain("matchMedia('(prefers-reduced-motion: reduce)')")
    expect(source).toContain('#presence-pulse.pulse{animation:none')
  })

  it('anchors the note card to the selected region without leaving the viewport', () => {
    expect(source).toContain('function positionNoteCard(rect)')
    expect(source).toContain("var card = root.getElementById('card')")
    expect(source).toContain('Math.min(innerWidth - cardWidth - margin')
    expect(source).toContain('Math.min(innerHeight - cardHeight - margin')
    expect(source).toContain("card.setAttribute('data-placement', placeBelow ? 'below' : 'above')")
    expect(source).toContain("card.style.setProperty('--anchor-x', anchorX + 'px')")
    expect(source).not.toContain('backdrop-filter:blur')
    expect(source).not.toContain('background:rgba(5,6,13,.40)')
    expect(source).not.toContain('aria-modal="true"')
    expect(source).toContain("var isElement = activeKind === 'element'")
    expect(source).toContain('isElement ? copy.arrowTitle : copy.pencilTitle')
  })

  it('flips the popover above a selection near the bottom edge', () => {
    const { api, root } = installInteractiveLayer()
    api.restoreCandidate({
      token: 'edge-candidate',
      kind: 'pen',
      rect: { x: 900, y: window.innerHeight - 70, width: 80, height: 40 },
    })
    api.openNoteModal('edge-candidate')

    const card = root.getElementById('card')!
    expect(card.getAttribute('data-placement')).toBe('above')
    expect(Number.parseFloat(card.style.left)).toBeLessThan(window.innerWidth - 14)
    expect(Number.parseFloat(card.style.top)).toBeGreaterThanOrEqual(14)
  })

  it('repositions an open popover when the browser viewport narrows', () => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    try {
      const { api, root } = installInteractiveLayer()
      api.restoreCandidate({
        token: 'resize-candidate',
        kind: 'pen',
        rect: { x: 860, y: 180, width: 120, height: 40 },
      })
      api.openNoteModal('resize-candidate')
      const card = root.getElementById('card')!
      expect(Number.parseFloat(card.style.left)).toBe(690)

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 })
      window.dispatchEvent(new Event('resize'))

      expect(Number.parseFloat(card.style.left)).toBe(166)
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
  })

  it('waits for load before announcing a page-loaded message and keeps ink in document coordinates', () => {
    expect(source).toContain("window.addEventListener('load', announceLoaded)")
    expect(source).toContain("post({ type: 'page-loaded', url: location.href })")
    expect(source).toContain('event.clientX + scrollX')
    expect(source).toContain("window.addEventListener('scroll'")
    expect(source).toContain('redrawInk()')
  })

  it('reattaches its closed-shadow host when a hostile page removes it', async () => {
    const transport = setupTransport()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    window.eval(source)
    const host = document.querySelector('[data-verboo-browser-layer]')
    host?.remove()
    await Promise.resolve()

    expect(host?.isConnected).toBe(true)
  })


  it('silently skips installation when the native transport is absent', () => {
    delete (globalThis as Record<string, unknown>).__VERBOO_NATIVE_TRANSPORT__
    window.eval(source)
    expect((window as Window & { __verbooBrowser?: InjectedApi }).__verbooBrowser).toBeUndefined()
  })

  it('silently skips installation when the native transport lacks a post function', () => {
    Object.defineProperty(globalThis, '__VERBOO_NATIVE_TRANSPORT__', {
      configurable: true,
      value: { tabId: 'x', bridgeToken: 'x', documentToken: 'x' },
    })
    window.eval(source)
    expect((window as Window & { __verbooBrowser?: InjectedApi }).__verbooBrowser).toBeUndefined()
  })

  it('envelopes every message with tabId, bridgeToken, documentToken', () => {
    const transport = setupTransport()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    window.eval(source)
    transport.post.mockClear()
    const api = (window as Window & { __verbooBrowser?: InjectedApi }).__verbooBrowser!
    api.announce()

    expect(transport.post).toHaveBeenCalled()
    const raw = transport.post.mock.calls[0][0]
    const envelope = JSON.parse(raw)
    expect(envelope.tabId).toBe('test-tab')
    expect(envelope.bridgeToken).toBe('bridge-token')
    expect(envelope.documentToken).toBe('doc-token')
    expect(envelope.payload).toEqual(expect.any(String))
    const inner = JSON.parse(envelope.payload)
    expect(inner.type).toBe('page-ready')
  })

  it('keeps bridgeToken and documentToken off globalThis and DOM after installation', () => {
    setupTransport()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    window.eval(source)

    expect((globalThis as Record<string, unknown>).__VERBOO_NATIVE_TRANSPORT__).toBeUndefined()

    // tokens must not appear as any DOM attribute text
    const serialized = document.documentElement.outerHTML
    expect(serialized).not.toContain('bridge-token')
    expect(serialized).not.toContain('doc-token')
    expect(serialized).not.toContain('test-tab')
  })

  it('caps a pencil stroke at 8192 points and finalizes the stroke', () => {
    const { api, transport, root } = installInteractiveLayer()
    const canvas = root.getElementById('ink')!
    api.setMode('pencil')

    // One continuous stroke: 1 pointerdown + 9000 pointermoves + 1 pointerup
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }))
    for (let i = 0; i < 9000; i++) {
      canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, button: 0, clientX: 100 + i, clientY: 100 }))
    }
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 100 + 9000, clientY: 100 }))

    const candidates = payloadsFrom(transport)
      .filter(m => (m as Record<string, unknown>).type === 'annotation-candidate')
    expect(candidates).toHaveLength(1)
    expect((candidates[0] as Record<string, unknown>).kind).toBe('pen')

    expect(source).toContain('8192')
  })

  it('rejects synthetic pencil events even when an active tool is set', () => {
    const { api, transport, root } = installInteractiveLayer({ trustedEvents: false })
    const canvas = root.getElementById('ink')!
    api.setMode('pencil')

    // Fire synthetic events (isTrusted=false by default for jsdom event constructors)
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 50 }))
    canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, button: 0, clientX: 120, clientY: 130 }))
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 160, clientY: 180 }))

    const candidates = payloadsFrom(transport)
      .filter(m => (m as Record<string, unknown>).type === 'annotation-candidate')
    expect(candidates).toHaveLength(0)
  })

  it('rejects synthetic element picker events', () => {
    document.body.innerHTML = '<button id="save">Target</button>'
    const target = document.getElementById('save')!
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 80, left: 100, top: 80, right: 220, bottom: 120, width: 120, height: 40,
      toJSON: () => ({}),
    })
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) })
    const { api, transport, root } = installInteractiveLayer({ trustedEvents: false })
    const picker = root.getElementById('picker')!
    api.setMode('arrow')

    picker.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 140, clientY: 100 }))
    picker.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 140, clientY: 100 }))

    const candidates = payloadsFrom(transport)
      .filter(m => (m as Record<string, unknown>).type === 'annotation-candidate')
    expect(candidates).toHaveLength(0)
  })
})
