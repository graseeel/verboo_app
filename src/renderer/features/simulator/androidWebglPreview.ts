import type { Vaf1Frame } from './vaf1'
export type PaintReceipt = {
  generation: number
  seq: number
  /** Autoridade producer-to-paint (spec §12.3), intocada do header VAF1. */
  timestampUs: bigint
  /** Dimensão REALMENTE alocada/submetida neste draw. */
  width: number
  height: number
  /** performance.now() capturado logo após drawArrays. */
  paintedAtMs: number
}
export type RgbPaintPush = (frame: Vaf1Frame) => PaintReceipt | null
export type RgbWebglPainter = {
  draw(frame: Vaf1Frame): PaintReceipt | null
  dispose(): void
}
export type RgbWebglPainterOptions = {
  /** Disparado EXATAMENTE uma vez por instância sem pipeline viável. */
  onTerminalFailure?: () => void
}
const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`
const FRAGMENT_SHADER_SOURCE = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
void main() {
  gl_FragColor = vec4(texture2D(u_texture, v_uv).rgb, 1.0);
}
`
const QUAD_VERTICES = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
type ProgramBundle = {
  program: WebGLProgram
  buffer: WebGLBuffer
  texture: WebGLTexture
  samplerLocation: WebGLUniformLocation
}
function buildProgram(gl: WebGLRenderingContext): { program: WebGLProgram; positionLocation: number } | null {
  const vertexShader = gl.createShader(gl.VERTEX_SHADER)
  if (!vertexShader) return null
  gl.shaderSource(vertexShader, VERTEX_SHADER_SOURCE)
  gl.compileShader(vertexShader)
  if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
    gl.deleteShader(vertexShader)
    return null
  }
  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)
  if (!fragmentShader) {
    gl.deleteShader(vertexShader)
    return null
  }
  gl.shaderSource(fragmentShader, FRAGMENT_SHADER_SOURCE)
  gl.compileShader(fragmentShader)
  if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
    gl.deleteShader(fragmentShader)
    gl.deleteShader(vertexShader)
    return null
  }
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(fragmentShader)
    gl.deleteShader(vertexShader)
    return null
  }
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  // Marcados para deleção imediatamente: vivem dentro do program após o link.
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  const positionLocation = gl.getAttribLocation(program, 'a_position')
  if (positionLocation < 0) {
    gl.deleteProgram(program)
    return null
  }
  return { program, positionLocation }
}
function buildResources(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  positionLocation: number,
): ProgramBundle | null {
  const buffer = gl.createBuffer()
  if (!buffer) {
    gl.deleteProgram(program)
    return null
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW)
  gl.enableVertexAttribArray(positionLocation)
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)
  const samplerLocation = gl.getUniformLocation(program, 'u_texture')
  if (!samplerLocation) {
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    return null
  }
  const texture = gl.createTexture()
  if (!texture) {
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    return null
  }
  gl.bindTexture(gl.TEXTURE_2D, texture)
  // Textura NPOT (720x1600) exige CLAMP_TO_EDGE e sem mipmap no WebGL1.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  // Payload permanece BOTTOM-UP: o mapeamento UV resolve a orientação.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  // Linhas RGB888 têm w*3 bytes — alinhamento 4 corromperia linhas ímpares.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.useProgram(program)
  gl.uniform1i(samplerLocation, 0)
  return { program, buffer, texture, samplerLocation }
}
export function createRgbWebglPainter(
  canvas: HTMLCanvasElement,
  options: RgbWebglPainterOptions = {},
): {
  painter: RgbWebglPainter
  handleContextLost(event: Event): void
  handleContextRestored(): void
} {
  let disposed = false
  let lost = false
  let terminalReported = false
  let gl: WebGLRenderingContext | null = null
  let bundle: ProgramBundle | null = null
  let positionLocation = 0
  let uploadedWidth = 0
  let uploadedHeight = 0
  const reportTerminalOnce = () => {
    if (terminalReported || disposed) return
    terminalReported = true
    options.onTerminalFailure?.()
  }
  const initialize = (): boolean => {
    const context = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    })
    if (!context) return false
    gl = context
    const built = buildProgram(context)
    if (!built) {
      gl = null
      return false
    }
    positionLocation = built.positionLocation
    const resources = buildResources(context, built.program, built.positionLocation)
    if (!resources) {
      gl = null
      return false
    }
    bundle = resources
    uploadedWidth = 0
    uploadedHeight = 0
    return true
  }
  const releaseAll = () => {
    if (gl && bundle) {
      gl.deleteTexture(bundle.texture)
      gl.deleteBuffer(bundle.buffer)
      gl.deleteProgram(bundle.program)
    }
    bundle = null
    gl = null
  }
  if (!initialize()) reportTerminalOnce()
  const painter: RgbWebglPainter = {
    draw(frame) {
      if (disposed || lost || !gl || !bundle) return null
      const context = gl
      if (canvas.width !== frame.width) canvas.width = frame.width
      if (canvas.height !== frame.height) canvas.height = frame.height
      context.useProgram(bundle.program)
      context.activeTexture(context.TEXTURE0)
      context.bindTexture(context.TEXTURE_2D, bundle.texture)
      context.bindBuffer(context.ARRAY_BUFFER, bundle.buffer)
      context.enableVertexAttribArray(positionLocation)
      context.vertexAttribPointer(positionLocation, 2, context.FLOAT, false, 0, 0)
      if (uploadedWidth !== frame.width || uploadedHeight !== frame.height) {
        context.texImage2D(
          context.TEXTURE_2D, 0, context.RGB, frame.width, frame.height, 0,
          context.RGB, context.UNSIGNED_BYTE, frame.pixels,
        )
        uploadedWidth = frame.width
        uploadedHeight = frame.height
      } else {
        context.texSubImage2D(
          context.TEXTURE_2D, 0, 0, 0, frame.width, frame.height,
          context.RGB, context.UNSIGNED_BYTE, frame.pixels,
        )
      }
      context.viewport(0, 0, frame.width, frame.height)
      context.drawArrays(context.TRIANGLE_STRIP, 0, 4)
      return {
        generation: frame.generation,
        seq: frame.seq,
        timestampUs: frame.timestampUs,
        width: uploadedWidth,
        height: uploadedHeight,
        paintedAtMs: performance.now(),
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      releaseAll()
    },
  }
  return {
    painter,
    handleContextLost(event) {
      if (disposed) return
      event.preventDefault()
      lost = true
      releaseAll()
    },
    handleContextRestored() {
      if (disposed || !lost) return
      if (!initialize()) {
        releaseAll()
        reportTerminalOnce()
        return
      }
      lost = false
    },
  }
}
