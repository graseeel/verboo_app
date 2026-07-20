import { describe, expect, it, vi } from 'vitest'
import { uploadPastedFile } from './pastedFileUpload'

function videoFile(size: number): File {
  const file = new File([new Uint8Array(size)], 'clip.mp4', { type: 'video/mp4' })
  Object.defineProperty(file, 'stream', {
    configurable: true,
    value: () => new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(size))
        controller.close()
      },
    }),
  })
  return file
}

describe('uploadPastedFile', () => {
  it('streams a 2.5 MiB file in bounded chunks with exact offsets', async () => {
    const calls: string[] = []
    const bridge = {
      beginPastedFileUpload: vi.fn().mockResolvedValue({ uploadId: 'upload-1' }),
      appendPastedFileChunk: vi.fn().mockImplementation(async () => { calls.push('append') }),
      finishPastedFileUpload: vi.fn().mockImplementation(async () => {
        calls.push('finish')
        return { path: '/upload/clip.mp4' }
      }),
      abortPastedFileUpload: vi.fn().mockResolvedValue(undefined),
    }

    await uploadPastedFile(videoFile(2.5 * 1024 * 1024), bridge)

    expect(bridge.appendPastedFileChunk.mock.calls.map(call => [call[0].offset, call[0].bytes.length]))
      .toEqual([[0, 1024 * 1024], [1024 * 1024, 1024 * 1024], [2 * 1024 * 1024, 512 * 1024]])
    expect(bridge.finishPastedFileUpload).toHaveBeenCalledOnce()
    expect(calls).toEqual(['append', 'append', 'append', 'finish'])
    expect(bridge.abortPastedFileUpload).not.toHaveBeenCalled()
  })

  it('aborts when a chunk invoke fails and never converts the file to base64', async () => {
    const bridge = {
      beginPastedFileUpload: vi.fn().mockResolvedValue({ uploadId: 'upload-1' }),
      appendPastedFileChunk: vi.fn().mockRejectedValue(new Error('offline')),
      finishPastedFileUpload: vi.fn(),
      abortPastedFileUpload: vi.fn().mockResolvedValue(undefined),
    }

    await expect(uploadPastedFile(videoFile(1), bridge)).rejects.toThrow('offline')
    expect(bridge.abortPastedFileUpload).toHaveBeenCalledWith({ uploadId: 'upload-1' })
    expect(bridge.finishPastedFileUpload).not.toHaveBeenCalled()
  })

  it('aborts when the file stream reader fails', async () => {
    const file = videoFile(1)
    Object.defineProperty(file, 'stream', {
      value: () => new ReadableStream({
        pull(controller) {
          controller.error(new Error('reader failed'))
        },
      }),
    })
    const bridge = {
      beginPastedFileUpload: vi.fn().mockResolvedValue({ uploadId: 'upload-1' }),
      appendPastedFileChunk: vi.fn(),
      finishPastedFileUpload: vi.fn(),
      abortPastedFileUpload: vi.fn().mockResolvedValue(undefined),
    }

    await expect(uploadPastedFile(file, bridge)).rejects.toThrow('reader failed')
    expect(bridge.abortPastedFileUpload).toHaveBeenCalledWith({ uploadId: 'upload-1' })
    expect(bridge.finishPastedFileUpload).not.toHaveBeenCalled()
  })

  it('aborts an active upload when the composer cancels it', async () => {
    const controller = new AbortController()
    const file = videoFile(1)
    Object.defineProperty(file, 'stream', {
      value: () => new ReadableStream({
        start() {
          controller.abort()
        },
      }),
    })
    const bridge = {
      beginPastedFileUpload: vi.fn().mockResolvedValue({ uploadId: 'upload-1' }),
      appendPastedFileChunk: vi.fn(),
      finishPastedFileUpload: vi.fn(),
      abortPastedFileUpload: vi.fn().mockResolvedValue(undefined),
    }

    await expect(uploadPastedFile(file, bridge, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(bridge.abortPastedFileUpload).toHaveBeenCalledWith({ uploadId: 'upload-1' })
    expect(bridge.finishPastedFileUpload).not.toHaveBeenCalled()
  })

  it('requests backend cleanup when cancellation happens during finish', async () => {
    const controller = new AbortController()
    let resolveFinish: ((attachment: { path: string }) => void) | undefined
    const bridge = {
      beginPastedFileUpload: vi.fn().mockResolvedValue({ uploadId: 'upload-1' }),
      appendPastedFileChunk: vi.fn().mockResolvedValue(undefined),
      finishPastedFileUpload: vi.fn().mockImplementation(() => new Promise(resolve => {
        resolveFinish = resolve
      })),
      abortPastedFileUpload: vi.fn().mockResolvedValue(undefined),
    }

    const upload = uploadPastedFile(videoFile(1), bridge, controller.signal)
    await vi.waitFor(() => expect(bridge.finishPastedFileUpload).toHaveBeenCalledOnce())
    controller.abort()
    expect(bridge.abortPastedFileUpload).toHaveBeenCalledWith({ uploadId: 'upload-1' })
    resolveFinish?.({ path: '/upload/clip.mp4' })

    await expect(upload).rejects.toMatchObject({ name: 'AbortError' })
  })
})
