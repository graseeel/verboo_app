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

function installInteractiveLayer() {
  const postMessage = vi.fn()
  Object.defineProperty(window, 'webkit', {
    configurable: true,
    value: { messageHandlers: { verboo: { postMessage } } },
  })
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
  window.eval(source)
  const api = (window as Window & { __verbooBrowser?: InjectedApi }).__verbooBrowser!
  const hosts = document.querySelectorAll<HTMLElement>('[data-verboo-browser-layer]')
  const root = hosts.item(hosts.length - 1).shadowRoot!
  postMessage.mockClear()
  return { api, postMessage, root }
}

describe('browser injected layer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    document.documentElement.innerHTML = '<head><title>Injected test</title></head><body><button>Target</button></body>'
    delete (window as Window & { __verbooBrowser?: InjectedApi }).__verbooBrowser
  })

  it('is idempotent and announces a structured page-ready message', () => {
    const postMessage = vi.fn()
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: { messageHandlers: { verboo: { postMessage } } },
    })
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
    const messages = postMessage.mock.calls.map(([message]) => JSON.parse(message))
    expect(messages.filter(message => message.type === 'page-ready')).toHaveLength(3)
    expect(messages[0]).toMatchObject({
      type: 'page-ready',
      title: 'Injected test',
      viewport: { width: expect.any(Number), height: expect.any(Number) },
    })
  })

  it('captures a pencil gesture and submits its accented note from the popup', () => {
    const { api, postMessage, root } = installInteractiveLayer()
    const canvas = root.getElementById('ink')!
    api.setMode('pencil')
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 50 }))
    canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, button: 0, clientX: 120, clientY: 130 }))
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 160, clientY: 180 }))

    const candidate = postMessage.mock.calls.map(([message]) => JSON.parse(message))
      .find(message => message.type === 'annotation-candidate')
    expect(candidate).toMatchObject({ kind: 'pen', rect: { x: 26, y: 36 } })

    api.openNoteModal(candidate.token)
    const card = root.getElementById('card')!
    expect(card.getAttribute('data-placement')).toBe('below')
    expect(card.style.getPropertyValue('--anchor-x')).toMatch(/px$/)
    expect(root.getElementById('modal')?.getAttribute('aria-hidden')).toBe('false')
    const note = root.getElementById('note') as HTMLTextAreaElement
    note.value = 'Ação, espaçamento e você'
    note.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))

    const submitted = postMessage.mock.calls.map(([message]) => JSON.parse(message))
      .find(message => message.type === 'annotation-submit')
    expect(submitted).toMatchObject({ token: candidate.token, note: 'Ação, espaçamento e você' })
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
    const { api, postMessage, root } = installInteractiveLayer()
    const picker = root.getElementById('picker')!
    api.setMode('arrow')
    picker.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 140, clientY: 100 }))
    picker.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 140, clientY: 100 }))

    const candidate = postMessage.mock.calls.map(([message]) => JSON.parse(message))
      .find(message => message.type === 'annotation-candidate')
    expect(candidate).toMatchObject({ kind: 'element', selector: '#save', component: 'PrimaryAction' })

    api.openNoteModal(candidate.token)
    expect(root.getElementById('title')?.textContent).toBe('Type your suggestion')
    const note = root.getElementById('note') as HTMLTextAreaElement
    note.value = 'Alinhar com o campo acima'
    note.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    expect(postMessage.mock.calls.map(([message]) => JSON.parse(message)))
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
    const postMessage = vi.fn()
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: { messageHandlers: { verboo: { postMessage } } },
    })
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
})
