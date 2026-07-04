import type { FileDiff, FileDiffStatus, WorkspaceChangeEntry } from '../../../shared/types'
import type { Translator } from '../../i18n'

export type DiffState = {
  loading: boolean
  diff?: FileDiff
}

export function diffCacheKey(file: WorkspaceChangeEntry): string {
  return `${file.path}:${file.status ?? 'modified'}:${file.additions}:${file.deletions}`
}

export function emptyDiff(file: WorkspaceChangeEntry, message: string): FileDiff {
  return {
    path: file.path,
    status: (file.status ?? 'modified') as FileDiffStatus,
    additions: 0,
    deletions: 0,
    binary: false,
    truncated: false,
    hunks: [],
    message,
  }
}

export function statusLabel(status: WorkspaceChangeEntry['status'], t: Translator): string {
  if (status === 'added' || status === 'untracked') return t('review.statusAdded')
  if (status === 'deleted') return t('review.statusDeleted')
  return t('review.statusModified')
}
