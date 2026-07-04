import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceChangeEntry } from '../../../../shared/types'
import type { ReviewTarget } from '../useReviewPanel'
import { diffCacheKey, emptyDiff, type DiffState } from '../reviewDiffModel'

type UseReviewDiffsArgs = {
  open: boolean
  target?: ReviewTarget
  canDiff: boolean
  diffLoadFailedMessage: string
  diffUnavailableMessage: string
}

export function useReviewDiffs({
  open,
  target,
  canDiff,
  diffLoadFailedMessage,
  diffUnavailableMessage,
}: UseReviewDiffsArgs) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const files = target?.files ?? []
  const fileSignature = useMemo(() => files.map(diffCacheKey).join('\n'), [files])
  const requestedDiffKeys = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!open || !target) {
      setExpandedPaths(new Set())
      setDiffs({})
      requestedDiffKeys.current.clear()
      return
    }

    const initialFile = files[Math.max(0, Math.min(target.index, files.length - 1))]
    setExpandedPaths(initialFile ? new Set([initialFile.path]) : new Set())
    setDiffs({})
    requestedDiffKeys.current.clear()
  }, [fileSignature, open, target?.workingDirectory, target?.index])

  useEffect(() => {
    if (!open || !target || !canDiff) return
    const filesToLoad = files.filter(file => expandedPaths.has(file.path))
    if (filesToLoad.length === 0) return

    let cancelled = false
    for (const file of filesToLoad) {
      const key = diffCacheKey(file)
      if (requestedDiffKeys.current.has(key)) continue
      requestedDiffKeys.current.add(key)

      setDiffs(current => ({ ...current, [key]: { loading: true } }))
      window.verboo.getFileDiff(target.workingDirectory, file.path, file.status)
        .then(diff => {
          if (!cancelled) setDiffs(current => ({ ...current, [key]: { loading: false, diff } }))
        })
        .catch(() => {
          if (!cancelled) {
            setDiffs(current => ({
              ...current,
              [key]: {
                loading: false,
                diff: emptyDiff(file, diffLoadFailedMessage),
              },
            }))
          }
        })
    }

    return () => {
      cancelled = true
    }
  }, [canDiff, diffLoadFailedMessage, expandedPaths, fileSignature, files, open, target?.workingDirectory])

  const toggleFile = useCallback((path: string) => {
    setExpandedPaths(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const diffStateForFile = useCallback((file: WorkspaceChangeEntry): DiffState | undefined => {
    if (canDiff) return diffs[diffCacheKey(file)]
    return {
      loading: false,
      diff: emptyDiff(file, diffUnavailableMessage),
    }
  }, [canDiff, diffUnavailableMessage, diffs])

  return { expandedPaths, toggleFile, diffStateForFile }
}
