export const VAF1_HEADER_BYTES = 36
export const VAF1_FORMAT_RGB888 = 1
/** Bounding box do stream (spec §7): curta ≤720 com aspect preservado. */
export const VAF1_SHORT_SIDE_MAX = 720
export const VAF1_LONG_SIDE_MAX = 1600
export type Vaf1Frame = {
  /** Safe integer validado contra Number.MAX_SAFE_INTEGER antes da conversão. */
  generation: number
  /** Seq local monotônica do native (sobrevive a reopen/rotação). */
  seq: number
  /** u64 garantido ≤ Number.MAX_SAFE_INTEGER pelo parser — Number() lossless. */
  timestampUs: bigint
  width: number
  height: number
  /** View ZERO-COPY sobre o buffer de origem em [36..36+w*h*3). */
  pixels: Uint8Array
}
export type Vaf1Parse =
  | { ok: true; frame: Vaf1Frame }
  | { ok: false; reason: 'too-short'; actualBytes: number }
  | { ok: false; reason: 'bad-magic' }
  | { ok: false; reason: 'reserved-bytes-set' }
  | { ok: false; reason: 'unsupported-format'; format: number }
  | { ok: false; reason: 'empty-dimensions' }
  | { ok: false; reason: 'zero-generation' }
  | { ok: false; reason: 'zero-seq' }
  | { ok: false; reason: 'size-exceeds-bounds'; width: number; height: number }
  | { ok: false; reason: 'exact-size-mismatch'; expectedBytes: number; actualBytes: number }
  | { ok: false; reason: 'unsafe-generation'; rawGeneration: string }
  | { ok: false; reason: 'unsafe-timestamp'; rawTimestamp: string }
export function parseVaf1(buffer: ArrayBuffer): Vaf1Parse {
  if (buffer.byteLength < VAF1_HEADER_BYTES) {
    return { ok: false, reason: 'too-short', actualBytes: buffer.byteLength }
  }
  const view = new DataView(buffer)
  if (
    view.getUint8(0) !== 0x56 || view.getUint8(1) !== 0x41
    || view.getUint8(2) !== 0x46 || view.getUint8(3) !== 0x31
  ) {
    return { ok: false, reason: 'bad-magic' }
  }
  if (view.getUint8(33) !== 0 || view.getUint8(34) !== 0 || view.getUint8(35) !== 0) {
    return { ok: false, reason: 'reserved-bytes-set' }
  }
  const format = view.getUint8(32)
  if (format !== VAF1_FORMAT_RGB888) {
    return { ok: false, reason: 'unsupported-format', format }
  }
  const rawGeneration = view.getBigUint64(4, true)
  if (rawGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, reason: 'unsafe-generation', rawGeneration: rawGeneration.toString(10) }
  }
  if (rawGeneration === 0n) {
    return { ok: false, reason: 'zero-generation' }   // alocador native inicia em 1
  }
  const seq = view.getUint32(12, true)
  if (seq === 0) {
    return { ok: false, reason: 'zero-seq' }          // SessionSeq.native inicia em 1
  }
  const rawTimestampUs = view.getBigUint64(16, true)
  if (rawTimestampUs > BigInt(Number.MAX_SAFE_INTEGER)) {
    // Simétrico à generation: lag producer-to-paint converte para Number —
    // um u64 inseguro corromperia a matemática de latência silenciosamente.
    return { ok: false, reason: 'unsafe-timestamp', rawTimestamp: rawTimestampUs.toString(10) }
  }
  const width = view.getUint32(24, true)
  const height = view.getUint32(28, true)
  if (width === 0 || height === 0) {
    return { ok: false, reason: 'empty-dimensions' }
  }
  // Bounding box revalidada AQUI, ANTES de qualquer multiplicação.
  if (
    Math.min(width, height) > VAF1_SHORT_SIDE_MAX
    || Math.max(width, height) > VAF1_LONG_SIDE_MAX
  ) {
    return { ok: false, reason: 'size-exceeds-bounds', width, height }
  }
  // Matemática exata: todo buffer de IPC tem byteLength muito abaixo de 2^53,
  // então o produto Number abaixo é exato sempre que pode casar.
  const expectedBytes = VAF1_HEADER_BYTES + width * height * 3
  if (expectedBytes > Number.MAX_SAFE_INTEGER || buffer.byteLength !== expectedBytes) {
    return { ok: false, reason: 'exact-size-mismatch', expectedBytes, actualBytes: buffer.byteLength }
  }
  return {
    ok: true,
    frame: {
      generation: Number(rawGeneration),
      seq,
      timestampUs: rawTimestampUs,
      width,
      height,
      pixels: new Uint8Array(buffer, VAF1_HEADER_BYTES, width * height * 3),
    },
  }
}
