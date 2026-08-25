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
/** Constantes de erro do stub GL (CONTEXT_LOST_WEBGL = 0x9242, valor real). */
const GL_ERROR = { NO_ERROR: 0, OUT_OF_MEMORY: 21, CONTEXT_LOST_WEBGL: 0x9242 } as const
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
  /** Quantas chamadas texImage2D iniciais enfileiram OUT_OF_MEMORY. */
  texImage2DFailures?: number
  /** Quantas chamadas texImage2D iniciais PERDEM o contexto (sem erro de fila). */
  texImage2DLosses?: number
  /** Fila de erros GL PRÉ-EXISTENTE (acumulada desde a última leitura). */
  pendingGlErrors?: number[]
  /** Contexto JÁ perdido na criação (estado persistente, não item de fila). */
  contextAlreadyLost?: boolean
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const deletions: string[] = []
  let shaderId = 0
  let programId = 0
  let compileIndex = 0
  // Semântica real do GL: FILA de flags — getError consome UM por chamada.
  const glErrorQueue: number[] = [...(fail.pendingGlErrors ?? [])]
  let texImageFailures = fail.texImage2DFailures ?? 0
  let texImageLosses = fail.texImage2DLosses ?? 0
  // Context loss é ESTADO persistente do contexto: o sentinel CONTEXT_LOST_WEBGL
  // é entregue UMA única vez pelo getError; as leituras seguintes veem NO_ERROR
  // até o restore, e as chamadas GL comuns viram no-op.
  let contextLost = fail.contextAlreadyLost ?? false
  let contextLostSentinelPending = contextLost
  // Spec WebGL: a restauração LIMPA o flag de contexto perdido — não há
  // sentinel pendente após o restore. O sentinel só volta a ser entregue se
  // outra perda ocorrer no novo contexto.
  const setContextLost = (lostNow: boolean) => {
    contextLost = lostNow
    if (lostNow) contextLostSentinelPending = true
    else contextLostSentinelPending = false
  }
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
    NO_ERROR: GL_ERROR.NO_ERROR, OUT_OF_MEMORY: GL_ERROR.OUT_OF_MEMORY,
    CONTEXT_LOST_WEBGL: GL_ERROR.CONTEXT_LOST_WEBGL,
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
    texImage2D: wrap('texImage2D', (...args: unknown[]) => {
      texImageCalls.push({ args })
      if (texImageFailures > 0) {
        texImageFailures -= 1
        glErrorQueue.push(c.OUT_OF_MEMORY)
      } else if (texImageLosses > 0) {
        texImageLosses -= 1
        setContextLost(true)
      }
    }),
    texSubImage2D: wrap('texSubImage2D', () => {}),
    getError: wrap('getError', () => {
      const queued = glErrorQueue.shift()
      if (queued !== undefined) return queued
      if (contextLostSentinelPending) {
        contextLostSentinelPending = false
        return c.CONTEXT_LOST_WEBGL
      }
      return c.NO_ERROR
    }),
    isContextLost: wrap('isContextLost', () => contextLost),
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
  // Cenário F-02R-02: outro caller do contexto drenou o sentinel
  // CONTEXT_LOST_WEBGL antes do draw do painter (contexto compartilhado). A
  // drenagem interna do painter agora vê NO_ERROR mas o contexto AINDA está
  // perdido — só isContextLost() cobre esse caso.
  const preConsumeSentinel = () => gl.getError()
  return { canvas, callsOf, shaderSourceBodies, texImageCalls, deletedKinds, setContextLost, preConsumeSentinel, c }
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
  it('reallocates via texImage2D on every dimension change (rotation 720x1600↔1600x720)', () => {
    const h = makeGlHarness()
    const { painter } = createRgbWebglPainter(h.canvas)
    painter.draw(makeFrame({ seq: 1, width: 720, height: 1600 }))
    painter.draw(makeFrame({ seq: 2, width: 720, height: 1600 }))
    expect(h.callsOf('texImage2D')).toHaveLength(1)
    expect(h.callsOf('texSubImage2D')).toHaveLength(1)
    const rotated = painter.draw(makeFrame({ seq: 3, width: 1600, height: 720 }))
    expect(rotated).toMatchObject({ width: 1600, height: 720 })
    expect([h.canvas.width, h.canvas.height]).toEqual([1600, 720])
    expect(h.callsOf('texImage2D')).toHaveLength(2)
    expect(h.texImageCalls[1]?.args[3]).toBe(1600)
    expect(h.texImageCalls[1]?.args[4]).toBe(720)
    const back = painter.draw(makeFrame({ seq: 4, width: 720, height: 1600 }))
    expect(back).toMatchObject({ width: 720, height: 1600 })
    expect(h.callsOf('texImage2D')).toHaveLength(3)
    expect(h.callsOf('texSubImage2D')).toHaveLength(1)
    expect([h.canvas.width, h.canvas.height]).toEqual([720, 1600])
  })
  it('reapplies the two UNPACK pixel stores only when the canvas resizes', () => {
    const h = makeGlHarness()
    const { painter } = createRgbWebglPainter(h.canvas)
    // 1º frame: buildResources já chama pixelStorei(UNPACK_FLIP_Y_WEBGL, true) + UNPACK_ALIGNMENT=1.
    const frame720 = makeFrame({ width: 720, height: 1600 })
    painter.draw(frame720)
    const storeCallsInitial = h.callsOf('pixelStorei').length
    // 2º frame com MESMAS dims → ZERO novas chamadas de pixelStorei (sem resize).
    painter.draw(frame720)
    expect(h.callsOf('pixelStorei').length).toBe(storeCallsInitial)
    // 3º frame com NOVAS dims (rotação 1600x720) → reset defensivo: reaplica o par.
    const frame1600 = makeFrame({ width: 1600, height: 720 })
    painter.draw(frame1600)
    const flippedCalls = h.callsOf('pixelStorei').filter(({ args }) => args[0] === h.c.UNPACK_FLIP_Y_WEBGL)
    expect(flippedCalls.at(-1)?.args[1]).toBe(true)
    const alignedCalls = h.callsOf('pixelStorei').filter(({ args }) => args[0] === h.c.UNPACK_ALIGNMENT)
    expect(alignedCalls.at(-1)?.args[1]).toBe(1)
  })
  it('drains pre-existing error flags: pending errors + a VALID texImage2D still paint (F-02)', () => {
    // Dois flags antigos na fila (ex.: hot path não sonda erros) — sem a
    // drenagem prévia, o veredito pós-texImage2D leria um flag ALHEIO.
    const h = makeGlHarness({ pendingGlErrors: [GL_ERROR.OUT_OF_MEMORY, GL_ERROR.OUT_OF_MEMORY] })
    const { painter } = createRgbWebglPainter(h.canvas)
    const receipt = painter.draw(makeFrame({ width: 720, height: 1600 }))
    expect(receipt).toMatchObject({ width: 720, height: 1600 })
    expect(h.callsOf('texImage2D')).toHaveLength(1)
    expect(h.callsOf('drawArrays')).toHaveLength(1)
    // 3 leituras de drenagem (OOM, OOM, NO_ERROR) + 1 veredito pós-chamada.
    expect(h.callsOf('getError')).toHaveLength(4)
  })
  it('clean baseline + a REAL texImage2D error: null, no drawArrays, realloc next frame (F-02)', () => {
    const h = makeGlHarness({ texImage2DFailures: 1 })
    const { painter } = createRgbWebglPainter(h.canvas)
    const frame = makeFrame({ width: 720, height: 1600 })
    expect(painter.draw(frame)).toBeNull()
    expect(h.callsOf('texImage2D')).toHaveLength(1)
    expect(h.callsOf('drawArrays')).toHaveLength(0)
    // dims zeradas ⇒ o próximo draw REALOCA via texImage2D (não texSubImage2D).
    const receipt = painter.draw(frame)
    expect(receipt).toMatchObject({ width: 720, height: 1600 })
    expect(h.callsOf('texImage2D')).toHaveLength(2)
    expect(h.callsOf('texSubImage2D')).toHaveLength(0)
    expect(h.callsOf('drawArrays')).toHaveLength(1)
  })
  it('context loss seen in the drain LATCHES: every draw is null without touching GL until restore (F-02R)', () => {
    const h = makeGlHarness({ contextAlreadyLost: true })
    const { painter, handleContextLost, handleContextRestored } = createRgbWebglPainter(h.canvas)
    const frame = makeFrame({ width: 720, height: 1600 })
    expect(painter.draw(frame)).toBeNull()
    expect(h.callsOf('texImage2D')).toHaveLength(0)
    // Latch: os draws seguintes NÃO tocam GL (sem drenagem nova, sem texImage2D).
    expect(painter.draw(frame)).toBeNull()
    expect(painter.draw(frame)).toBeNull()
    expect(h.callsOf('getError')).toHaveLength(2)   // só a drenagem do 1º draw
    expect(h.callsOf('texImage2D')).toHaveLength(0)
    expect(h.callsOf('drawArrays')).toHaveLength(0)
    // Handler DOM tardio é idempotente: preventDefault, SEM dupla liberação.
    const lateEvent = { preventDefault: vi.fn() } as unknown as Event
    handleContextLost(lateEvent)
    expect(lateEvent.preventDefault).toHaveBeenCalled()
    expect(h.deletedKinds('texture#')).toHaveLength(1)
    expect(painter.draw(frame)).toBeNull()
    // Restore explícito reconstrói os recursos e destrava o painter.
    h.setContextLost(false)
    handleContextRestored()
    expect(painter.draw(frame)).toMatchObject({ width: 720, height: 1600 })
    expect(h.callsOf('texImage2D')).toHaveLength(1)
    expect(h.callsOf('drawArrays')).toHaveLength(1)
  })
  it('context loss DURING texImage2D latches via the post-call verdict (F-02R)', () => {
    const h = makeGlHarness({ texImage2DLosses: 1 })
    const { painter, handleContextRestored } = createRgbWebglPainter(h.canvas)
    const frame = makeFrame({ width: 720, height: 1600 })
    expect(painter.draw(frame)).toBeNull()
    expect(h.callsOf('texImage2D')).toHaveLength(1)   // a chamada que perdeu o contexto
    expect(h.callsOf('drawArrays')).toHaveLength(0)
    expect(painter.draw(frame)).toBeNull()
    expect(h.callsOf('texImage2D')).toHaveLength(1)   // sem nova tentativa enquanto lost
    h.setContextLost(false)
    handleContextRestored()
    expect(painter.draw(frame)).toMatchObject({ width: 720, height: 1600 })
    expect(h.callsOf('texImage2D')).toHaveLength(2)
    expect(h.callsOf('drawArrays')).toHaveLength(1)
  })
  it('full cycle: handler loss → draws null without touching GL → restored → valid draw (F-02R)', () => {
    const h = makeGlHarness()
    const handlers = createRgbWebglPainter(h.canvas)
    const frame = makeFrame({ width: 720, height: 1600 })
    expect(handlers.painter.draw(frame)).not.toBeNull()
    const probesBeforeLoss = h.callsOf('getError').length
    handlers.handleContextLost({ preventDefault: vi.fn() } as unknown as Event)
    expect(handlers.painter.draw(frame)).toBeNull()
    expect(handlers.painter.draw(frame)).toBeNull()
    // null vem do latch local — zero sondagem GL enquanto perdido.
    expect(h.callsOf('getError')).toHaveLength(probesBeforeLoss)
    expect(h.callsOf('drawArrays')).toHaveLength(1)
    handlers.handleContextRestored()
    expect(handlers.painter.draw(frame)).toMatchObject({ width: 720, height: 1600 })
    expect(h.callsOf('drawArrays')).toHaveLength(2)
  })
  it('sets UNPACK_FLIP_Y true (payload TOP-DOWN) and UNPACK_ALIGNMENT 1 (rows are width*3)', () => {
    const h = makeGlHarness()
    createRgbWebglPainter(h.canvas)
    const storeCalls = h.callsOf('pixelStorei')
    // Campo: payload do emulador é TOP-DOWN (primeira linha = topo da tela).
    // O flip no upload alinha a primeira linha à base da textura; o quad
    // padrão (UV (0,0) na base) coloca a base da textura no fundo do quad →
    // texto legível correto.
    expect(storeCalls.some(({ args }) => args[0] === h.c.UNPACK_FLIP_Y_WEBGL && args[1] === true)).toBe(true)
    // Linhas RGB888 têm w*3 bytes; alinhamento 4 corromperia linhas ímpares.
    expect(storeCalls.some(({ args }) => args[0] === h.c.UNPACK_ALIGNMENT && args[1] === 1)).toBe(true)
  })
  it('shader flip + fragment identity-pin (TOP-DOWN payload rendered correctly)', () => {
    const h = makeGlHarness()
    createRgbWebglPainter(h.canvas)
    expect(h.shaderSourceBodies).toHaveLength(2)
    const [vertexSource, fragmentSource] = h.shaderSourceBodies
    // O pin do contrato TOP-DOWN: o painter NÃO faz flip no shader (v_uv
    // crua = a_position * 0.5 + 0.5). O flip é responsabilidade exclusiva
    // do UNPACK_FLIP_Y_WEBGL=true no pixelStorei (test acima).
    expect(vertexSource).toContain('v_uv = a_position * 0.5 + 0.5;')
    expect(vertexSource).not.toContain('1.0 -')
    // Fragment: identidade de canais (RGB) e alpha forçado a 1.
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
  it('context lost with sentinel ALREADY CONSUMED by another caller LATCHES via isContextLost (F-02R-02)', () => {
    // Outro caller do contexto (contexto compartilhado) consumiu o sentinel
    // CONTEXT_LOST_WEBGL ANTES do draw do painter. A drenagem interna do
    // painter agora vê apenas NO_ERROR — sem o branch || context.isContextLost()
    // o painter emitiria receipt com GL no-op, abrindo uma janela de
    // falso sucesso entre o flag setado e o dispatch do evento DOM.
    const h = makeGlHarness({ contextAlreadyLost: true })
    const { painter, handleContextRestored } = createRgbWebglPainter(h.canvas)
    // Drena o sentinel externamente — simula o "outro caller".
    const consumed = h.preConsumeSentinel()
    expect(consumed).toBe(h.c.CONTEXT_LOST_WEBGL)
    const frame = makeFrame({ width: 720, height: 1600 })
    // O draw do painter deve latchar via isContextLost(): null, zero texImage2D.
    expect(painter.draw(frame)).toBeNull()
    expect(h.callsOf('texImage2D')).toHaveLength(0)
    expect(h.callsOf('drawArrays')).toHaveLength(0)
    // isContextLost() FOI chamado — pina o branch que cobre o caso.
    expect(h.callsOf('isContextLost').length).toBeGreaterThanOrEqual(1)
    // Latch persistiu: draws seguintes seguem null sem tocar GL.
    expect(painter.draw(frame)).toBeNull()
    expect(h.callsOf('texImage2D')).toHaveLength(0)
    // Restore real (spec limpa o flag de perda) reconstrói e destrava.
    h.setContextLost(false)
    handleContextRestored()
    expect(painter.draw(frame)).toMatchObject({ width: 720, height: 1600 })
    expect(h.callsOf('texImage2D')).toHaveLength(1)
    expect(h.callsOf('drawArrays')).toHaveLength(1)
  })
  it('steady-state texSubImage2D path makes zero getError / zero isContextLost calls (F-02R-03a)', () => {
    // O design 60fps exige zero sondagem no hot path saudável. Conta as
    // chamadas DEPOIS do draw inicial (realocação) e compara com o draw em
    // dimensão repetida (steady-state). Mutação adicionando uma sonda no
    // steady-state saudável manteria verde sem este teste.
    const h = makeGlHarness()
    const { painter } = createRgbWebglPainter(h.canvas)
    painter.draw(makeFrame({ seq: 1, width: 720, height: 1600 }))   // realocação
    const afterFirstDraw = {
      getError: h.callsOf('getError').length,
      isContextLost: h.callsOf('isContextLost').length,
    }
    // Dez draws em dimensão repetida: devem cair todos no ramo texSubImage2D.
    for (let i = 0; i < 10; i += 1) {
      expect(painter.draw(makeFrame({ seq: i + 2, width: 720, height: 1600 }))).not.toBeNull()
    }
    expect(h.callsOf('getError')).toHaveLength(afterFirstDraw.getError)
    expect(h.callsOf('isContextLost')).toHaveLength(afterFirstDraw.isContextLost)
    expect(h.callsOf('texSubImage2D')).toHaveLength(10)
    expect(h.callsOf('texImage2D')).toHaveLength(1)   // só o upload inicial
  })
  it('handler loss + restore restores baseline drain on the next draw (F-02R-03b)', () => {
    // Spec WebGL: a restauração LIMPA o flag de contexto perdido — não há
    // sentinel pendente após o restore. O harness pré-F-02R-03b deixava o
    // sentinel vivo; mutação que NÃO limpa `contextLostSentinelPending` no
    // setContextLost(false) faria o draw pós-restore relatchar em falso.
    const h = makeGlHarness()
    const handlers = createRgbWebglPainter(h.canvas)
    const frame = makeFrame({ width: 720, height: 1600 })
    // Loss observada SÓ pelo handler DOM — sentinel nunca lido via getError.
    handlers.handleContextLost({ preventDefault: vi.fn() } as unknown as Event)
    expect(handlers.painter.draw(frame)).toBeNull()
    // Restore com sentinel não consumido: a spec zera o flag, então o draw
    // pós-restore deve PINTAR (não relatchar).
    handlers.handleContextRestored()
    expect(handlers.painter.draw(frame)).toMatchObject({ width: 720, height: 1600 })
    expect(h.callsOf('texImage2D')).toHaveLength(1)
    expect(h.callsOf('drawArrays')).toHaveLength(1)
  })
})
