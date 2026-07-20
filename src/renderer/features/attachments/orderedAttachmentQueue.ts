type AttachmentLike = { path: string; kind: string }

type Batch<T> = {
  done: boolean
  attachments: T[]
  generation: number
}

export type AttachmentQueueOutcome<T> = {
  attachments: T[]
  added: T[]
  rejectedVideo: boolean
}

export class OrderedAttachmentQueue<T extends AttachmentLike> {
  private nextSequence = 0
  private nextFlush = 0
  private generation = 0
  private readonly batches = new Map<number, Batch<T>>()
  private attachments: T[] = []

  reserve(): number {
    const sequence = this.nextSequence++
    this.batches.set(sequence, { done: false, attachments: [], generation: this.generation })
    return sequence
  }

  complete(sequence: number, attachments: T[]): AttachmentQueueOutcome<T> {
    return this.settle(sequence, attachments)
  }

  fail(sequence: number): AttachmentQueueOutcome<T> {
    return this.settle(sequence, [])
  }

  remove(path: string): T[] {
    const canonical = canonicalPath(path)
    this.attachments = this.attachments.filter(attachment => canonicalPath(attachment.path) !== canonical)
    return this.snapshot()
  }

  filter(keep: (attachment: T) => boolean): T[] {
    this.attachments = this.attachments.filter(keep)
    return this.snapshot()
  }

  update(path: string, transform: (attachment: T) => T): T[] {
    const canonical = canonicalPath(path)
    this.attachments = this.attachments.map(attachment =>
      canonicalPath(attachment.path) === canonical ? transform(attachment) : attachment,
    )
    return this.snapshot()
  }

  reset(): void {
    this.attachments = []
    this.batches.clear()
    this.nextFlush = this.nextSequence
    this.generation += 1
  }

  snapshot(): T[] {
    return [...this.attachments]
  }

  private settle(sequence: number, attachments: T[]): AttachmentQueueOutcome<T> {
    const batch = this.batches.get(sequence)
    if (!batch || batch.generation !== this.generation) {
      return { attachments: this.snapshot(), added: [], rejectedVideo: false }
    }
    batch.done = true
    batch.attachments = attachments

    const added: T[] = []
    let rejectedVideo = false
    while (this.batches.get(this.nextFlush)?.done) {
      const next = this.batches.get(this.nextFlush)!
      this.batches.delete(this.nextFlush++)
      for (const attachment of next.attachments) {
        const existingIndex = this.attachments.findIndex(
          existing => canonicalPath(existing.path) === canonicalPath(attachment.path),
        )
        if (existingIndex >= 0) {
          const existing = this.attachments[existingIndex]
          this.attachments[existingIndex] = { ...attachment, path: existing.path }
          continue
        }
        if (attachment.kind === 'video' && this.attachments.some(existing => existing.kind === 'video')) {
          rejectedVideo = true
          continue
        }
        this.attachments.push(attachment)
        added.push(attachment)
      }
    }
    return { attachments: this.snapshot(), added, rejectedVideo }
  }
}

function canonicalPath(path: string): string {
  const segments: string[] = []
  for (const segment of path.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return `/${segments.join('/')}`
}
