import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AndroidPreviewCanvas } from './AndroidPreviewCanvas'

/** Mini stub WebGL: suficiente para o painter REAL inicializar e submeter draws. */
function installFakeWebGL() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const record = (method: string) => (...args: unknown[]) => { calls.push({ method, args }) }
  const c = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TEXTURE_2D: 8, TEXTURE_WRAP_S: 9,
    TEXTURE_WRAP_T: 10, CLAMP_TO_EDGE: 11, TEXTURE_MIN_FILTER: 12,
    TEXTURE_MAG_FILTER: 13, LINEAR: 14, UNPACK_FLIP_Y_WEBGL: 15,
    UNPACK_ALIGNMENT: 16, TEXTURE0: 17, RGB: 18, UNSIGNED_BYTE: 19, TRIANGLE_STRIP: 20,
    // O painter REAL (F-02/F-02R) drena getError e sonda isContextLost na
    // (re)alocação do texImage2D — o stub precisa destes 4 membros extras.
    NO_ERROR: 21, CONTEXT_LOST_WEBGL: 22,
  }
  let shaderId = 0
  const gl = {
    ...c,
    getError: () => c.NO_ERROR,
    isContextLost: () => false,
    createShader: () => ({ id: ++shaderId }),
    shaderSource: record('shaderSource'),
    compileShader: record('compileShader'),
    getShaderParameter: (_s: object, pname: number) => pname === c.COMPILE_STATUS || pname === c.LINK_STATUS,
    deleteShader: record('deleteShader'),
    createProgram: () => ({ id: 1 }),
    attachShader: record('attachShader'),
    linkProgram: record('linkProgram'),
    getProgramParameter: (_p: object, pname: number) => pname === c.LINK_STATUS,
    getAttribLocation: () => 0,
    getUniformLocation: () => ({ id: 'u' }),
    deleteProgram: record('deleteProgram'),
    createBuffer: () => ({ id: 'b' }),
    bindBuffer: record('bindBuffer'),
    bufferData: record('bufferData'),
    enableVertexAttribArray: record('enableVertexAttribArray'),
    vertexAttribPointer: record('vertexAttribPointer'),
    deleteBuffer: record('deleteBuffer'),
    createTexture: () => ({ id: 't' }),
    bindTexture: record('bindTexture'),
    texParameteri: record('texParameteri'),
    pixelStorei: record('pixelStorei'),
    activeTexture: record('activeTexture'),
    useProgram: record('useProgram'),
    uniform1i: record('uniform1i'),
    texImage2D: record('texImage2D'),
    texSubImage2D: record('texSubImage2D'),
    viewport: record('viewport'),
    drawArrays: record('drawArrays'),
    deleteTexture: record('deleteTexture'),
  }
  const original = HTMLCanvasElement.prototype.getContext
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (type: string) => (type === 'webgl' ? (gl as unknown as RenderingContext) : null),
  )
  return { calls, restore: () => { HTMLCanvasElement.prototype.getContext = original } }
}

describe('AndroidPreviewCanvas', () => {
  let fake: ReturnType<typeof installFakeWebGL> | null = null

  afterEach(() => {
    // F6 (Faro): spy de getContext deve ser restaurado mesmo se o teste
    // falhar no meio — evita vazamento para testes subsequentes.
    fake?.restore()
    fake = null
  })

  it('registers a paint push on mount, revokes on unmount, reports terminal once in jsdom', () => {
    const onPushReady = vi.fn()
    const onTerminalFailure = vi.fn()
    const view = render(
      <AndroidPreviewCanvas ariaLabel="preview" onPushReady={onPushReady} onTerminalFailure={onTerminalFailure} />,
    )
    // jsdom sem WebGL: getContext devolve null → terminal dispara uma vez
    // no CAMINHO DO MOUNT (este teste NÃO cobre StrictMode double-invoke;
    // a once-ness entre re-execuções do effect é contrato do pai, ver Lacre F2).
    expect(screen.getByRole('img', { name: 'preview' })).toBeInTheDocument()
    expect(onPushReady).toHaveBeenCalledTimes(1)
    const push = onPushReady.mock.calls[0]?.[0]
    expect(push?.({
      generation: 1, seq: 1, timestampUs: 1n, width: 8, height: 8, pixels: new Uint8Array(192),
    })).toBeNull()
    expect(onTerminalFailure).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(onPushReady).toHaveBeenLastCalledWith(null)
  })

  it('delegates draws to the REAL painter when WebGL exists', () => {
    fake = installFakeWebGL()
    const onPushReady = vi.fn()
    const onTerminalFailure = vi.fn()
    render(<AndroidPreviewCanvas ariaLabel="live" onPushReady={onPushReady} onTerminalFailure={onTerminalFailure} />)
    const receipt = onPushReady.mock.calls[0]?.[0]({
      generation: 2, seq: 3, timestampUs: 40n, width: 8, height: 8, pixels: new Uint8Array(192),
    })
    expect(receipt).toMatchObject({ generation: 2, seq: 3, width: 8, height: 8 })
    expect(receipt?.timestampUs).toBe(40n)
    const submitted = fake.calls.filter(call => call.method === 'drawArrays')
    expect(submitted).toHaveLength(1)
    expect(onTerminalFailure).not.toHaveBeenCalled()
  })

  it('latches on webglcontextlost and resurrects on webglcontextrestored (F3)', () => {
    fake = installFakeWebGL()
    const onPushReady = vi.fn()
    const onTerminalFailure = vi.fn()
    render(<AndroidPreviewCanvas ariaLabel="live" onPushReady={onPushReady} onTerminalFailure={onTerminalFailure} />)
    const push = onPushReady.mock.calls[0]?.[0]
    const frame = { generation: 1, seq: 1, timestampUs: 1n, width: 8, height: 8, pixels: new Uint8Array(192) }

    // sanity: painter inicializa e submete o primeiro draw
    expect(push(frame)).toMatchObject({ generation: 1, width: 8, height: 8 })
    const drawsBeforeLoss = fake.calls.filter(call => call.method === 'drawArrays').length

    // contextlost via DOM event: latch (F-02R) — draw devolve null, ZERO
    // atividade GL (sem novo drawArrays, sem nova sondagem getError).
    const canvas = screen.getByRole('img', { name: 'live' })
    fireEvent(canvas, new Event('webglcontextlost'))

    expect(push(frame)).toBeNull()
    expect(push(frame)).toBeNull()
    expect(fake.calls.filter(call => call.method === 'drawArrays').length).toBe(drawsBeforeLoss)

    // contextrestored via DOM event: painter re-inicializa o GL e limpa o
    // latch (F-02R §Re-init no restore). Draw volta a pintar e drawArrays
    // cresce em exatamente 1.
    fireEvent(canvas, new Event('webglcontextrestored'))

    expect(push(frame)).toMatchObject({ generation: 1, width: 8, height: 8 })
    expect(fake.calls.filter(call => call.method === 'drawArrays').length).toBe(drawsBeforeLoss + 1)

    expect(onTerminalFailure).not.toHaveBeenCalled()
  })

  it('the old push returns null after unmount and submits no further drawArrays (F4)', () => {
    fake = installFakeWebGL()
    const onPushReady = vi.fn()
    const onTerminalFailure = vi.fn()
    const view = render(
      <AndroidPreviewCanvas ariaLabel="live" onPushReady={onPushReady} onTerminalFailure={onTerminalFailure} />,
    )
    const push = onPushReady.mock.calls[0]?.[0]
    const frame = { generation: 1, seq: 1, timestampUs: 1n, width: 8, height: 8, pixels: new Uint8Array(192) }

    // sanity: draw funciona antes do unmount
    expect(push(frame)).toMatchObject({ generation: 1 })
    const drawsBeforeUnmount = fake.calls.filter(call => call.method === 'drawArrays').length

    // unmount: o painter é disposed ANTES da revogação do push (ordem do
    // cleanup na folha) — o push antigo passa a devolver null e nenhum
    // drawArrays novo é submetido.
    view.unmount()

    expect(push(frame)).toBeNull()
    expect(push(frame)).toBeNull()
    expect(fake.calls.filter(call => call.method === 'drawArrays').length).toBe(drawsBeforeUnmount)
    expect(onPushReady).toHaveBeenLastCalledWith(null)
  })
})
