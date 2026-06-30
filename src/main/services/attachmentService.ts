import { nativeImage } from 'electron'
import { open, readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { AttachmentMeta } from '../../shared/types'

export type CliImageBlock = {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

const IMAGE_MEDIA_BY_EXT: Record<string, string> = {
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

const CLI_NATIVE_IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])

export async function inspectAttachments(paths: string[]): Promise<AttachmentMeta[]> {
  const attachments = await Promise.all(paths.map(path => inspectAttachment(path)))
  return attachments.filter((attachment): attachment is AttachmentMeta => Boolean(attachment))
}

export async function createImageBlock(attachment: AttachmentMeta): Promise<CliImageBlock | undefined> {
  if (attachment.kind !== 'image') return undefined

  if (attachment.mediaType && CLI_NATIVE_IMAGE_TYPES.has(attachment.mediaType)) {
    const data = await readFile(attachment.path)
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mediaType,
        data: data.toString('base64'),
      },
    }
  }

  const image = nativeImage.createFromPath(attachment.path)
  if (image.isEmpty()) return undefined

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: image.toPNG().toString('base64'),
    },
  }
}

async function inspectAttachment(path: string): Promise<AttachmentMeta | undefined> {
  try {
    const [fileStat, header] = await Promise.all([
      stat(path),
      readHeader(path),
    ])
    const mediaType = detectImageMediaType(path, header)
    const image = mediaType ? nativeImage.createFromPath(path) : undefined
    const size = image && !image.isEmpty() ? image.getSize() : undefined

    return {
      path,
      name: basename(path),
      size: fileStat.size,
      kind: mediaType ? 'image' : 'file',
      mediaType,
      width: size?.width,
      height: size?.height,
    }
  } catch {
    return undefined
  }
}

async function readHeader(path: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(16)
    const result = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

function detectImageMediaType(path: string, header: Buffer): string | undefined {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg'
  }
  if (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif'
  }
  if (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }

  return IMAGE_MEDIA_BY_EXT[extname(path).toLowerCase()]
}
