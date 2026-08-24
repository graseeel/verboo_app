import { describe, expect, it, vi } from 'vitest'
import { createRgbWebglPainter } from './androidWebglPreview'
import type { Vaf1Frame } from './vaf1'
function makeFrame(opts: { generation?: number; seq?: number; width: number; height: number; timestampUs?: bigint }): Vaf1Frame {
  const { width, height } = opts
  return {
    generation: opts.generation ?? 5,
    seq: opts.seq ?? 1,
    timestampUs: opts.timestampUs ?? 123_456n,
    width, height,
    pixels: new Uint8Array(width * height * 3),
  }
}
/** Stub WebGL gravador: wrap(method, impl) registra E delega. */
function makeGlHarness(fail: {
  createShaderReturnsNull?: boolean
  compileResults?: boolean[]
  linkStatus?: boolean
  attribLocation?: number
  samplerLocationReturnsNull?: boolean
  createBufferReturnsNull?: boolean
  createTextureReturnsNull?: boolean
  contextUnavailable?: boolean
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const deletions: string[] = []
  let shaderId = 0
  let programId = 0
  let compileIndex = 0
  function wrap<T>(method: string, impl: (...args: never[]) => T): (...args: never[]) => T {
    return (...args: never[]) => {
      calls.push({ method, args })
      return impl(...args)
    }
  }
  const c = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7,
    TEXTURE_2D: 8, TEXTURE_WRAP_S: 9, TEXTURE_WRAP_T: 10, CLAMP_TO_EDGE: 11,
    TEXTURE_MIN_FILTER: 12, TEXTURE_MAG_FILTER: 13, LINEAR: 14,
    UNPACK_FLIP_Y_WEBGL: 15, UNPACK_ALIGNMENT: 16, TEXTURE0: 17,
    RGB: 18, UNSIGNED_BYTE: 19, TRIANGLE_STRIP: 20,
  }
  const shaderSourceBodies: string[] = []
  const texImageCalls: Array<{ args: unknown[] }> = []
  const gl = {
    ...c,
    createShader: wrap('createShader', (): object | null =>
      fail.createShaderReturnsNull ? null : { kind: 'shader', id: ++shaderId }),
    shaderSource: wrap('shaderSource', (_s: object, source: string) => { shaderSourceBodies.push(source) }),
    compileShader: wrap('compileShader', () => {}),
    getShaderParameter: wrap('getShaderParameter', (_s: object, pname: number) => {
      if (pname !== c.COMPILE_STATUS) return true
      const result = fail.compileResults
        ? (compileIndex < fail.compileResults.length ? fail.compileResults[compileIndex] : true)
        : true
      compileIndex += 1
      return result
    }),
    getShaderInfoLog: () => '',
    deleteShader: wrap('deleteShader', (s: object) => { deletions.push(`shader#${JSON.stringify(s)}`) }),
    createProgram: wrap('createProgram', (): object => ({ kind: 'program', id: ++programId })),
    attachShader: wrap('attachShader', () => {}),
    linkProgram: wrap('linkProgram', () => {}),
    getProgramParameter: wrap('getProgramParameter', (_p: object, pname: number) =>
      pname === c.LINK_STATUS ? (fail.linkStatus ?? true) : true),
    getAttribLocation: wrap('getAttribLocation', () => fail.attribLocation ?? 0),
    getUniformLocation: wrap('getUniformLocation', () =>
      fail.samplerLocationReturnsNull ? null : { kind: 'location' }),
    deleteProgram: wrap('deleteProgram', (p: object) => { deletions.push(`program#${JSON.stringify(p)}`) }),
    createBuffer: wrap('createBuffer', () => (fail.createBufferReturnsNull ? null : { kind: 'buffer' })),
    bindBuffer: wrap('bindBuffer', () => {}),
    bufferData: wrap('bufferData', () => {}),
    enableVertexAttribArray: wrap('enableVertexAttribArray', () => {}),
    vertexAttribPointer: wrap('vertexAttribPointer', () => {}),
    deleteBuffer: wrap('deleteBuffer', (b: object) => { deletions.push(`buffer#${JSON.stringify(b)}`) }),
    createTexture: wrap('createTexture', () =>
      fail.createTextureReturnsNull ? null : { kind: 'texture' }),
    bindTexture: wrap('bindTexture', () => {}),
    texParameteri: wrap('texParameteri', () => {}),
    pixelStorei: wrap('pixelStorei', () => {}),
    activeTexture: wrap('activeTexture', () => {}),
    useProgram: wrap('useProgram', () => {}),
    uniform1i: wrap('uniform1i', () => {}),
    texImage2D: wrap('texImage2D', (...args: unknown[]) => { texImageCalls.push({ args }) }),
    texSubImage2D: wrap('texSubImage2D', () => {}),
    viewport: wrap('viewport', () => {}),
    drawArrays: wrap('drawArrays', () => {}),
    deleteTexture: wrap('deleteTexture', (t: object) => { deletions.push(`texture#${JSON.stringify(t)}`) }),
  }
  const canvas = {
    width: 0, height: 0,
    getContext: (type: string) =>
      fail.contextUnavailable || type !== 'webgl' ? null : gl,
  } as unknown as HTMLCanvasElement
  const callsOf = (method: string) => calls.filter(call => call.method === method)
  const deletedKinds = (prefix: string) => deletions.filter(entry => entry.startsWith(prefix))
  return { canvas, callsOf, shaderSourceBodies, texImageCalls, deletedKinds, c }
}
describe('createRgbWebglPainter', () => {
  it('paints a submitted frame: receipt carries identity, drawnSize, timestampUs', () => {
    const h = makeGlHarness()
    const { painter } = createRgbWebglPainter(h.canvas)
    const frame = makeFrame({ generation: 9, seq: 4, width: 720, height: 1600, timestampUs: 777n })
    const receipt = painter.draw(frame)
    expect(receipt).toMatchObject({ generation: 9, seq: 4, width: 720, height: 1600 })
    expect(receipt?.timestampUs).toBe(777n)
    expect(typeof receipt?.paintedAtMs).toBe('number')
    expect([h.canvas.width, h.canvas.height]).toEqual([720, 1600])
    expect(h.callsOf('texImage2D')).toHaveLength(1)
    expect(h.callsOf('drawArrays')).toHaveLength(1)
  })
  it('uploads exactly frame.pixels then reuses storage via texSubImage2D', () => {
    const h = makeGlHarness()
    const { painter } = createRgbWebglPainter(h.canvas)
    const first = makeFrame({ seq: 1, width: 720, height: 1600 })
    painter.draw(first)
    expect(h.texImageCalls[0]?.args[8]).toBe(first.pixels)
    painter.draw(makeFrame({ seq: 2, width: 720, height: 1600 }))
    expect(h.callsOf('texImage2D')).toHaveLength(1)
    expect(h.callsOf('texSubImage2D')).toHaveLength(1)
  })
  it('sets UNPACK_FLIP_Y false and UNPACK_ALIGNMENT 1 (rows are width*3)', () => {
    const h = makeGlHarness()
    createRgbWebglPainter(h.canvas)
    const storeCalls = h.callsOf('pixelStorei')
    expect(storeCalls.some(({ args }) => args[0] === h.c.UNPACK_FLIP_Y_WEBGL && args[1] === false)).toBe(true)
    expect(storeCalls.some(({ args }) => args[0] === h.c.UNPACK_ALIGNMENT && args[1] === 1)).toBe(true)
  })
  it('shaders map bottom-up rows WITHOUT any flip and pin alpha to 1', () => {
    const h = makeGlHarness()
    createRgbWebglPainter(h.canvas)
    expect(h.shaderSourceBodies).toHaveLength(2)
    const [vertexSource, fragmentSource] = h.shaderSourceBodies
    expect(vertexSource).toContain('v_uv = a_position * 0.5 + 0.5;')
    expect(vertexSource).not.toContain('1.0 -')
    expect(fragmentSource).toContain('vec4(texture2D(u_texture, v_uv).rgb, 1.0)')
    expect(fragmentSource).toContain('precision mediump float;')
  })
  it.each([
    { name: 'null first createShader', fail: { createShaderReturnsNull: true },
      expect: { programsCreated: 0, shadersDeleted: 0, programsDeleted: 0 }, terminal: 1 },
    { name: 'vertex compile', fail: { compileResults: [false] },
      expect: { programsCreated: 0, shadersDeleted: 1, programsDeleted: 0 }, terminal: 1 },
    { name: 'fragment compile', fail: { compileResults: [true, false] },
      expect: { programsCreated: 0, shadersDeleted: 2, programsDeleted: 0 }, terminal: 1 },
    { name: 'link', fail: { linkStatus: false },
      expect: { programsCreated: 1, shadersDeleted: 2, programsDeleted: 1 }, terminal: 1 },
    { name: 'attrib location -1', fail: { attribLocation: -1 },
      expect: { programsCreated: 1, shadersDeleted: 2, programsDeleted: 1 }, terminal: 1 },
    { name: 'missing sampler location', fail: { samplerLocationReturnsNull: true },
      expect: { programsCreated: 1, shadersDeleted: 2, programsDeleted: 1 }, terminal: 1 },
    { name: 'null buffer creation', fail: { createBufferReturnsNull: true },
      expect: { programsCreated: 1, shadersDeleted: 2, programsDeleted: 1 }, terminal: 1 },
    { name: 'null texture creation', fail: { createTextureReturnsNull: true },
      expect: { programsCreated: 1, shadersDeleted: 2, programsDeleted: 1 }, terminal: 1 },
  ])('$name cleans up every owned resource', ({ fail, expect: want, terminal }) => {
    const h = makeGlHarness(fail)
    const onTerminalFailure = vi.fn()
    const { painter } = createRgbWebglPainter(h.canvas, { onTerminalFailure })
    expect(painter.draw(makeFrame({ width: 8, height: 8 }))).toBeNull()
    expect(h.callsOf('createProgram')).toHaveLength(want.programsCreated)
    expect(h.deletedKinds('shader#')).toHaveLength(want.shadersDeleted)
    expect(h.deletedKinds('program#')).toHaveLength(want.programsDeleted)
    // Qualquer pipeline WebGL inviável na CRIAÇÃO é downgrade terminal UMA vez.
    expect(onTerminalFailure).toHaveBeenCalledTimes(terminal)
  })
  it('each painter against a dead context reports terminal failure once PER instance', () => {
    const h = makeGlHarness({ contextUnavailable: true })
    const onTerminalFailure = vi.fn()
    const first = createRgbWebglPainter(h.canvas, { onTerminalFailure })
    const second = createRgbWebglPainter(h.canvas, { onTerminalFailure })
    expect(onTerminalFailure).toHaveBeenCalledTimes(2)
    expect(first.painter.draw(makeFrame({ width: 8, height: 8 }))).toBeNull()
    expect(second.painter.draw(makeFrame({ width: 8, height: 8 }))).toBeNull()
    expect(onTerminalFailure).toHaveBeenCalledTimes(2)
  })
  it('context loss pauses draws and restore rebuilds without a new report', () => {
    const h = makeGlHarness()
    const handlers = createRgbWebglPainter(h.canvas)
    const lostEvent = { preventDefault: vi.fn() } as unknown as Event
    handlers.handleContextLost(lostEvent)
    expect(lostEvent.preventDefault).toHaveBeenCalled()
    expect(handlers.painter.draw(makeFrame({ width: 8, height: 8 }))).toBeNull()
    expect(h.deletedKinds('texture#')).toHaveLength(1)
    handlers.handleContextRestored()
    expect(handlers.painter.draw(makeFrame({ width: 8, height: 8 }))).not.toBeNull()
  })
  it('handleContextRestored no-ops while not lost — no rebuild, no leak', () => {
    const h = makeGlHarness()
    const handlers = createRgbWebglPainter(h.canvas)
    handlers.handleContextRestored()
    handlers.handleContextRestored()
    expect(h.callsOf('createShader')).toHaveLength(2)
    expect(h.deletedKinds('program#')).toHaveLength(0)
  })
  it('a broken rebuild reports terminal exactly once across repeated restores', () => {
    const h = makeGlHarness()
    const onTerminalFailure = vi.fn()
    const handlers = createRgbWebglPainter(h.canvas, { onTerminalFailure })
    Object.defineProperty(h.canvas, 'getContext', { value: () => null, configurable: true })
    handlers.handleContextLost({ preventDefault: vi.fn() } as unknown as Event)
    handlers.handleContextRestored()
    handlers.handleContextRestored()
    expect(onTerminalFailure).toHaveBeenCalledTimes(1)
    expect(handlers.painter.draw(makeFrame({ width: 8, height: 8 }))).toBeNull()
  })
  it('dispose releases everything once and is idempotent', () => {
    const h = makeGlHarness()
    const handlers = createRgbWebglPainter(h.canvas)
    handlers.painter.dispose()
    handlers.painter.dispose()
    expect(h.deletedKinds('program#')).toHaveLength(1)
    expect(h.deletedKinds('buffer#')).toHaveLength(1)
    expect(h.deletedKinds('texture#')).toHaveLength(1)
    expect(handlers.painter.draw(makeFrame({ width: 8, height: 8 }))).toBeNull()
  })
})
