import type { AttachmentMeta } from '../../../shared/types'

export const MAX_UPLOAD_CHUNK_BYTES = 1024 * 1024

export type PastedFileUploadBridge = {
  beginPastedFileUpload(input: { name: string; size: number; mediaType: string }): Promise<{ uploadId: string }>
  appendPastedFileChunk(input: { uploadId: string; offset: number; bytes: number[] }): Promise<void>
  finishPastedFileUpload(input: { uploadId: string }): Promise<AttachmentMeta>
  abortPastedFileUpload(input: { uploadId: string }): Promise<void>
}

export async function uploadPastedFile(
  file: File,
  bridge: PastedFileUploadBridge,
  signal?: AbortSignal,
): Promise<AttachmentMeta> {
  signal?.throwIfAborted()
  const { uploadId } = await bridge.beginPastedFileUpload({
    name: file.name,
    size: file.size,
    mediaType: file.type,
  })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let abortRequest: Promise<void> | undefined
  const requestAbort = () => {
    abortRequest ??= bridge.abortPastedFileUpload({ uploadId }).catch(() => {})
    return abortRequest
  }
  const cancelUpload = () => {
    void reader?.cancel()
    void requestAbort()
  }
  signal?.addEventListener('abort', cancelUpload, { once: true })
  try {
    signal?.throwIfAborted()
    let offset = 0
    reader = file.stream().getReader()
    try {
      while (true) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        for (let index = 0; index < value.length; index += MAX_UPLOAD_CHUNK_BYTES) {
          signal?.throwIfAborted()
          const chunk = value.subarray(index, index + MAX_UPLOAD_CHUNK_BYTES)
          await bridge.appendPastedFileChunk({ uploadId, offset, bytes: Array.from(chunk) })
          offset += chunk.length
        }
      }
    } finally {
      reader.releaseLock()
      reader = undefined
    }
    signal?.throwIfAborted()
    const attachment = await bridge.finishPastedFileUpload({ uploadId })
    signal?.throwIfAborted()
    return attachment
  } catch (error) {
    await requestAbort()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancelUpload)
  }
}
