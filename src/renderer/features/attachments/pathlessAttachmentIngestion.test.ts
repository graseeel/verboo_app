import { describe, expect, it } from 'vitest'
import { inspectPathlessFiles } from './pathlessAttachmentIngestion'

describe('pathless attachment ingestion', () => {
  it('keeps a mixed image, video, and document batch in clipboard order', async () => {
    const files = [
      new File(['image'], 'first.png', { type: 'image/png' }),
      new File(['video'], 'second.mp4', { type: 'video/mp4' }),
      new File(['document'], 'third.txt', { type: 'text/plain' }),
    ]
    const attachments = await inspectPathlessFiles(
      files,
      async file => [{ path: `/tmp/${file.name}`, name: file.name, size: file.size, kind: 'image' }],
      async file => ({ path: `/tmp/${file.name}`, name: file.name, size: file.size, kind: file.type.startsWith('video/') ? 'video' : 'file' }),
    )

    expect(attachments.map(attachment => attachment.name)).toEqual(['first.png', 'second.mp4', 'third.txt'])
  })
})
