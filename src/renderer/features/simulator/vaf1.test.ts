import { describe, expect, it } from 'vitest'
import { VAF1_FORMAT_RGB888, VAF1_HEADER_BYTES, parseVaf1 } from './vaf1'
function vaf1Buffer(opts: {
  generation?: bigint; seq?: number; timestampUs?: bigint
  width: number; height: number
  magic?: string; format?: number
  reserved?: [number, number, number]; totalBytes?: number
}): ArrayBuffer {
  const bytes = opts.totalBytes ?? VAF1_HEADER_BYTES + opts.width * opts.height * 3
  const buf = new ArrayBuffer(bytes)
  const view = new DataView(buf)
  const magic = opts.magic ?? 'VAF1'
  for (let i = 0; i < 4; i++) view.setUint8(i, magic.charCodeAt(i))
  view.setBigUint64(4, opts.generation ?? 42n, true)
  view.setUint32(12, opts.seq ?? 7, true)
  view.setBigUint64(16, opts.timestampUs ?? 1_000_000n, true)
  view.setUint32(24, opts.width, true)
  view.setUint32(28, opts.height, true)
  view.setUint8(32, opts.format ?? VAF1_FORMAT_RGB888)
  const reserved = opts.reserved ?? [0, 0, 0]
  view.setUint8(33, reserved[0]); view.setUint8(34, reserved[1]); view.setUint8(35, reserved[2])
  return buf
}
describe('parseVaf1', () => {
  it('accepts portrait 720x1600 with a zero-copy pixel view', () => {
    const result = parseVaf1(vaf1Buffer({ generation: 42n, seq: 7, width: 720, height: 1600 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame.generation).toBe(42)
    expect(result.frame.seq).toBe(7)
    expect(result.frame.timestampUs).toBe(1_000_000n)
    expect(result.frame.pixels.length).toBe(720 * 1600 * 3)
    expect(result.frame.pixels.byteOffset).toBe(VAF1_HEADER_BYTES)
  })
  it('refuses buffers shorter than the header without reading past the end', () => {
    expect(parseVaf1(new ArrayBuffer(35)))
      .toEqual({ ok: false, reason: 'too-short', actualBytes: 35 })
  })
  it('refuses bad magic before inspecting any other field', () => {
    expect(parseVaf1(vaf1Buffer({ magic: 'XAF1', width: 2, height: 2 })))
      .toEqual({ ok: false, reason: 'bad-magic' })
  })
  it('refuses set reserved bytes', () => {
    expect(parseVaf1(vaf1Buffer({ reserved: [0, 1, 0], width: 2, height: 2 })))
      .toEqual({ ok: false, reason: 'reserved-bytes-set' })
  })
  it('refuses formats other than RGB888=1 and reports the format byte', () => {
    expect(parseVaf1(vaf1Buffer({ format: 2, width: 2, height: 2 })))
      .toEqual({ ok: false, reason: 'unsupported-format', format: 2 })
  })
  it('refuses zero dimensions', () => {
    expect(parseVaf1(vaf1Buffer({ width: 10, height: 0 })))
      .toEqual({ ok: false, reason: 'empty-dimensions' })
  })
  it('refuses frames outside the stream bounding box BEFORE any size math', () => {
    for (const dims of [[1080, 2400], [721, 1600], [720, 1601]] as const) {
      expect(parseVaf1(vaf1Buffer({ width: dims[0], height: dims[1] }))).toEqual({
        ok: false,
        reason: 'size-exceeds-bounds',
        width: dims[0],
        height: dims[1],
      })
    }
  })
  it('accepts both reference orientations and reduced bounding-box frames', () => {
    expect(parseVaf1(vaf1Buffer({ width: 720, height: 1600 })).ok).toBe(true)
    expect(parseVaf1(vaf1Buffer({ width: 1600, height: 720 })).ok).toBe(true)
    expect(parseVaf1(vaf1Buffer({ width: 480, height: 1066 })).ok).toBe(true)
    expect(parseVaf1(vaf1Buffer({ width: 500, height: 500 })).ok).toBe(true)
  })
  it('refuses truncated payloads with exact expected/actual sizes and rejects extra bytes', () => {
    expect(parseVaf1(vaf1Buffer({ width: 2, height: 3, totalBytes: 36 + 18 - 1 }))).toEqual({
      ok: false, reason: 'exact-size-mismatch', expectedBytes: 54, actualBytes: 53,
    })
    expect(parseVaf1(vaf1Buffer({ width: 2, height: 2, totalBytes: 48 + 1 })).ok).toBe(false)
  })
  it('keeps the u64 generation on the wire: unsafe values are refused as strings', () => {
    const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 1n
    expect(parseVaf1(vaf1Buffer({ generation: unsafe, width: 2, height: 2 }))).toEqual({
      ok: false, reason: 'unsafe-generation', rawGeneration: unsafe.toString(10),
    })
    const edge = BigInt(Number.MAX_SAFE_INTEGER)
    const result = parseVaf1(vaf1Buffer({ generation: edge, width: 2, height: 2 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame.generation).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('refuses zero generation and zero seq (native allocator starts at 1)', () => {
    expect(parseVaf1(vaf1Buffer({ generation: 0n, width: 2, height: 2 })))
      .toEqual({ ok: false, reason: 'zero-generation' })
    const buffer = vaf1Buffer({ seq: 0, width: 2, height: 2 })
    expect(parseVaf1(buffer)).toEqual({ ok: false, reason: 'zero-seq' })
  })

  it('exposes payload bytes in wire order (asymmetric row starts: rows are w*3 bytes)', () => {
    // width=1 → cada linha tem 3 bytes. Linha 0 começa no byte 36 (pixels[0]);
    // a SEGUNDA linha começa em 39 = 36+3, i.e. pixels[3] — não [4].
    const buffer = vaf1Buffer({ width: 1, height: 2 })
    const bytes = new Uint8Array(buffer)
    bytes[36] = 0xaa; bytes[38] = 0x11; bytes[39] = 0xbb
    const result = parseVaf1(buffer)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.frame.pixels.length).toBe(6)
    expect([result.frame.pixels[0], result.frame.pixels[2], result.frame.pixels[3]])
      .toEqual([0xaa, 0x11, 0xbb])
    expect(Array.from(result.frame.pixels.slice(4))).toEqual([0, 0])
  })
})
