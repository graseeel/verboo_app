import { describe, it, expect } from 'vitest'
import { diffCacheKey, emptyDiff, statusLabel } from './reviewDiffModel'
import type { WorkspaceChangeEntry } from '../../../shared/types'

/**
 * Regression tests for reviewDiffModel.ts
 *
 * diffCacheKey is the cache key for the review panel's diff fetcher. A
 * regression here would either (a) cause cache collisions between
 * different files (showing the wrong diff) or (b) cause cache misses on
 * every render (re-fetching the same diff in a loop).
 *
 * emptyDiff is the fallback when a diff can't be loaded. A regression
 * here would surface as a broken/empty diff panel.
 *
 * statusLabel maps a git status to a translated label. A regression
 * here would show the wrong label (e.g. "Added" for a deleted file).
 */
const baseEntry: WorkspaceChangeEntry = {
  path: 'src/foo.ts',
  status: 'modified',
  additions: 10,
  deletions: 2,
}

describe('diffCacheKey', () => {
  it('includes path, status, additions, deletions', () => {
    const key = diffCacheKey(baseEntry)
    expect(key).toBe('src/foo.ts:modified:10:2')
  })

  it('distinguishes files by path', () => {
    const a = diffCacheKey(baseEntry)
    const b = diffCacheKey({ ...baseEntry, path: 'src/bar.ts' })
    expect(a).not.toBe(b)
  })

  it('distinguishes files by status', () => {
    const a = diffCacheKey(baseEntry)
    const b = diffCacheKey({ ...baseEntry, status: 'added' })
    expect(a).not.toBe(b)
  })

  it('distinguishes files by additions', () => {
    const a = diffCacheKey(baseEntry)
    const b = diffCacheKey({ ...baseEntry, additions: 11 })
    expect(a).not.toBe(b)
  })

  it('distinguishes files by deletions', () => {
    const a = diffCacheKey(baseEntry)
    const b = diffCacheKey({ ...baseEntry, deletions: 3 })
    expect(a).not.toBe(b)
  })

  it('falls back to "modified" when status is undefined', () => {
    const key = diffCacheKey({ ...baseEntry, status: undefined })
    expect(key).toBe('src/foo.ts:modified:10:2')
  })

  it('produces identical keys for identical entries', () => {
    expect(diffCacheKey(baseEntry)).toBe(diffCacheKey({ ...baseEntry }))
  })
})

describe('emptyDiff', () => {
  it('returns a diff with zero additions/deletions and no hunks', () => {
    const diff = emptyDiff(baseEntry, 'no data')
    expect(diff.additions).toBe(0)
    expect(diff.deletions).toBe(0)
    expect(diff.hunks).toEqual([])
    expect(diff.binary).toBe(false)
    expect(diff.truncated).toBe(false)
    expect(diff.message).toBe('no data')
    expect(diff.path).toBe('src/foo.ts')
  })

  it('preserves the file path', () => {
    const diff = emptyDiff({ ...baseEntry, path: 'a/b/c.ts' }, '')
    expect(diff.path).toBe('a/b/c.ts')
  })

  it('uses "modified" status when entry has no status', () => {
    const diff = emptyDiff({ ...baseEntry, status: undefined }, '')
    expect(diff.status).toBe('modified')
  })

  it('uses the entry status when present', () => {
    const diff = emptyDiff({ ...baseEntry, status: 'added' }, '')
    expect(diff.status).toBe('added')
  })
})

describe('statusLabel', () => {
  const t = (key: string) => `[${key}]`

  it('labels added files as added', () => {
    expect(statusLabel('added', t)).toBe('[review.statusAdded]')
  })

  it('labels untracked files as added', () => {
    expect(statusLabel('untracked', t)).toBe('[review.statusAdded]')
  })

  it('labels deleted files as deleted', () => {
    expect(statusLabel('deleted', t)).toBe('[review.statusDeleted]')
  })

  it('labels modified files as modified', () => {
    expect(statusLabel('modified', t)).toBe('[review.statusModified]')
  })

  it('labels undefined status as modified (fallback)', () => {
    expect(statusLabel(undefined, t)).toBe('[review.statusModified]')
  })
})
