/**
 * Composer-to-turn integration for video attachments: interaction order is
 * reserved before async inspection, exactly one video may reach a message,
 * removal keeps survivors, and image-only turns are untouched by the video
 * consent gate.
 */

import { describe, expect, it, vi } from 'vitest'

import { OrderedAttachmentQueue } from './features/attachments/orderedAttachmentQueue'
import { shouldBlockVideoBeforeCli } from './features/video/VideoFallbackModal'

type Item = { path: string; kind: 'image' | 'video' | 'file' }

const image = (path: string): Item => ({ path, kind: 'image' })
const video = (path: string): Item => ({ path, kind: 'video' })
const file = (path: string): Item => ({ path, kind: 'file' })

describe('composer video attachment ordering', () => {
  it('keeps picker/drop/paste interaction order across out-of-order completion', () => {
    const queue = new OrderedAttachmentQueue<Item>()
    const picker = queue.reserve()
    const paste = queue.reserve()

    // Paste inspection finishes first, but the picker batch was reserved first.
    queue.complete(paste, [file('/docs/notes.pdf')])
    const outcome = queue.complete(picker, [image('/pics/a.png'), video('/clips/demo.mp4')])

    expect(outcome.attachments.map(a => a.path)).toEqual([
      '/pics/a.png',
      '/clips/demo.mp4',
      '/docs/notes.pdf',
    ])
  })

  it('preserves mixed image/video/document order around the single video', () => {
    const queue = new OrderedAttachmentQueue<Item>()
    const batch = queue.reserve()

    const outcome = queue.complete(batch, [
      image('/a.png'),
      video('/b.mp4'),
      file('/c.pdf'),
    ])

    expect(outcome.attachments.map(a => a.kind)).toEqual(['image', 'video', 'file'])
    expect(outcome.rejectedVideo).toBe(false)
  })

  it('refuses a second video while keeping everything else', () => {
    const queue = new OrderedAttachmentQueue<Item>()
    queue.complete(queue.reserve(), [video('/first.mp4')])

    const outcome = queue.complete(queue.reserve(), [video('/second.mp4'), image('/pic.png')])

    expect(outcome.rejectedVideo).toBe(true)
    expect(outcome.attachments.map(a => a.path)).toEqual(['/first.mp4', '/pic.png'])
  })

  it('removing the video frees the slot without reordering survivors', () => {
    const queue = new OrderedAttachmentQueue<Item>()
    queue.complete(queue.reserve(), [image('/a.png'), video('/b.mp4'), file('/c.pdf')])

    const afterRemove = queue.remove('/b.mp4')
    expect(afterRemove.map(a => a.path)).toEqual(['/a.png', '/c.pdf'])

    const outcome = queue.complete(queue.reserve(), [video('/replacement.mov')])
    expect(outcome.rejectedVideo).toBe(false)
    expect(outcome.attachments.map(a => a.path)).toEqual([
      '/a.png',
      '/c.pdf',
      '/replacement.mov',
    ])
  })
})

describe('video consent gate at send time', () => {
  const gate = (consent: 'ask' | 'always' | 'never') => ({
    consent,
    requestChoice: vi.fn(async () => ({ allowOnce: true as const })),
    persistConsent: vi.fn(async () => {}),
    onConsentUpdated: vi.fn(),
    onDenied: vi.fn(),
  })

  it('image-only turns never trigger the video gate', async () => {
    const options = gate('ask')

    const blocked = await shouldBlockVideoBeforeCli(
      [{ kind: 'image' }, { kind: 'file' }],
      options,
    )

    expect(blocked).toBe(false)
    expect(options.requestChoice).not.toHaveBeenCalled()
  })

  it('a video under Ask consent goes through the modal, then continues', async () => {
    const options = gate('ask')

    const blocked = await shouldBlockVideoBeforeCli([{ kind: 'video' }], options)

    expect(blocked).toBe(false)
    expect(options.requestChoice).toHaveBeenCalledTimes(1)
  })

  it('Never consent denies without ever prompting', async () => {
    const options = gate('never')

    const blocked = await shouldBlockVideoBeforeCli([{ kind: 'video' }], options)

    expect(blocked).toBe(true)
    expect(options.requestChoice).not.toHaveBeenCalled()
    expect(options.onDenied).toHaveBeenCalledTimes(1)
  })
})
