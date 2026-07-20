import { describe, expect, it } from 'vitest'
import type { AttachmentMeta } from '../../../shared/types'
import { OrderedAttachmentQueue } from './orderedAttachmentQueue'

const attachment = (path: string, kind: AttachmentMeta['kind'] = 'file'): AttachmentMeta => ({
  path,
  name: path.split('/').pop() ?? path,
  size: 1,
  kind,
})

describe('OrderedAttachmentQueue', () => {
  it('flushes async batches in reservation order and keeps mixed attachments ordered', () => {
    const queue = new OrderedAttachmentQueue<AttachmentMeta>()
    const picker = queue.reserve()
    const paste = queue.reserve()

    expect(queue.complete(paste, [attachment('/paste.png', 'image'), attachment('/clip.mp4', 'video')]).attachments).toEqual([])
    expect(queue.complete(picker, [attachment('/doc.txt'), attachment('/photo.png', 'image')]).attachments.map(item => item.path))
      .toEqual(['/doc.txt', '/photo.png', '/paste.png', '/clip.mp4'])
  })

  it('keeps the earliest canonical duplicate, survivors on removal, one video, and flushes past failures', () => {
    const queue = new OrderedAttachmentQueue<AttachmentMeta>()
    const first = queue.reserve()
    const failed = queue.reserve()
    const later = queue.reserve()

    queue.complete(first, [attachment('/work/./same.txt'), attachment('/first.mp4', 'video')])
    queue.fail(failed)
    const outcome = queue.complete(later, [attachment('/work/same.txt'), attachment('/second.mp4', 'video'), attachment('/next.png', 'image')])

    expect(outcome.attachments.map(item => item.path)).toEqual(['/work/./same.txt', '/first.mp4', '/next.png'])
    expect(outcome.rejectedVideo).toBe(true)
    expect(queue.remove('/first.mp4').map(item => item.path)).toEqual(['/work/./same.txt', '/next.png'])
  })

  it('updates duplicate metadata without moving the earliest canonical path', () => {
    const queue = new OrderedAttachmentQueue<AttachmentMeta>()
    const first = queue.reserve()
    const duplicate = queue.reserve()

    queue.complete(first, [{ ...attachment('/work/./same.txt'), name: 'old', size: 1 }])
    const outcome = queue.complete(duplicate, [{ ...attachment('/work/same.txt'), name: 'new', size: 2 }])

    expect(outcome.attachments).toEqual([{ ...attachment('/work/./same.txt'), name: 'new', size: 2 }])
  })

  it('preserves case-sensitive paths and ignores completions reserved before reset', () => {
    const queue = new OrderedAttachmentQueue<AttachmentMeta>()
    const stale = queue.reserve()
    const active = queue.reserve()
    queue.reset()
    const fresh = queue.reserve()

    expect(queue.complete(stale, [attachment('/Work/Clip.txt')]).attachments).toEqual([])
    expect(queue.complete(active, [attachment('/work/clip.txt')]).attachments).toEqual([])
    expect(queue.complete(fresh, [attachment('/Work/Clip.txt'), attachment('/work/clip.txt')]).attachments.map(item => item.path))
      .toEqual(['/Work/Clip.txt', '/work/clip.txt'])
  })
})
