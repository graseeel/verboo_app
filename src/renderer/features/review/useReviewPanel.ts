import { useCallback, useState } from 'react'
import type { WorkspaceChangeEntry } from '../../../shared/types'

const REVIEW_WIDTH_KEY = 'verboo:review-width'
const DEFAULT_WIDTH = 460
const MIN_WIDTH = 360
const MAX_WIDTH = 680

export type ReviewTarget = {
  workingDirectory: string
  files: WorkspaceChangeEntry[]
  index: number
}

export function useReviewPanel() {
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewWidth, setReviewWidth] = useState(readWidth)
  const [target, setTarget] = useState<ReviewTarget | undefined>()

  const open = useCallback((workingDirectory: string, files: WorkspaceChangeEntry[], index: number) => {
    if (files.length === 0) return
    setTarget({
      workingDirectory,
      files,
      index: Math.max(0, Math.min(index, files.length - 1)),
    })
    setReviewOpen(true)
  }, [])

  const close = useCallback(() => setReviewOpen(false), [])

  const setWidth = useCallback((nextWidth: number) => {
    const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, nextWidth))
    setReviewWidth(width)
    try {
      window.localStorage.setItem(REVIEW_WIDTH_KEY, String(width))
    } catch {
      // Width persistence is optional.
    }
  }, [])

  const next = useCallback(() => {
    setTarget(current => current ? { ...current, index: Math.min(current.index + 1, current.files.length - 1) } : current)
  }, [])

  const prev = useCallback(() => {
    setTarget(current => current ? { ...current, index: Math.max(current.index - 1, 0) } : current)
  }, [])

  return { reviewOpen, reviewWidth, target, open, close, setWidth, next, prev, MIN_WIDTH, MAX_WIDTH }
}

function readWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(REVIEW_WIDTH_KEY))
    return Number.isFinite(stored) ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, stored)) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}
