import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronDown, GitBranch, Search } from 'lucide-react'
import type { WorkspaceBranchInfo, WorkspaceBranchSwitchResult } from '../../../../shared/types'
import { useI18n } from '../../../i18n'

type ReviewBranchControlsProps = {
  branchInfo?: WorkspaceBranchInfo
  totalAdditions: number
  totalDeletions: number
  onSwitchBranch: (branchName: string) => Promise<WorkspaceBranchSwitchResult>
  children?: React.ReactNode
}

export function ReviewBranchControls({
  branchInfo,
  totalAdditions,
  totalDeletions,
  onSwitchBranch,
  children,
}: ReviewBranchControlsProps) {
  const { t } = useI18n()
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [branchQuery, setBranchQuery] = useState('')
  const [branchMessage, setBranchMessage] = useState<string | undefined>()
  const [switchingBranch, setSwitchingBranch] = useState<string | undefined>()
  const branchMenuRef = useRef<HTMLDivElement>(null)

  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase()
    return (branchInfo?.branches ?? []).filter(branch => !query || branch.name.toLowerCase().includes(query))
  }, [branchInfo?.branches, branchQuery])

  const handleSwitchBranch = useCallback(async (branchName: string) => {
    setSwitchingBranch(branchName)
    setBranchMessage(undefined)
    try {
      const result = await onSwitchBranch(branchName)
      setBranchMessage(result.ok ? undefined : t('review.switchBranchFailed'))
      if (result.ok) setBranchMenuOpen(false)
    } finally {
      setSwitchingBranch(undefined)
    }
  }, [onSwitchBranch, t])

  useEffect(() => {
    if (!branchMenuOpen) return

    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      if (!branchMenuRef.current?.contains(event.target as Node)) setBranchMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBranchMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [branchMenuOpen])

  return (
    <>
      <div className="review-branch-row">
        <div className="review-branch-menu-wrap" ref={branchMenuRef}>
          <button
            type="button"
            className="review-branch-trigger"
            onClick={() => setBranchMenuOpen(open => !open)}
            aria-expanded={branchMenuOpen}
            disabled={!branchInfo?.branches.length}
          >
            <GitBranch size={14} />
            <span>{t('review.branch')}</span>
            <ChevronDown size={14} />
          </button>
          {branchMenuOpen ? (
            <div className="review-branch-menu" role="menu">
              <label className="review-branch-search">
                <Search size={13} />
                <input
                  value={branchQuery}
                  onChange={event => setBranchQuery(event.target.value)}
                  placeholder={t('review.branchSearch')}
                  autoFocus
                />
              </label>
              <div className="review-branch-menu-title">{t('review.localBranches')}</div>
              {branchInfo?.dirty ? (
                <div className="review-branch-warning">
                  <AlertCircle size={13} />
                  <span>{t('review.localChangesWarning')}</span>
                </div>
              ) : null}
              <div className="review-branch-list">
                {filteredBranches.map(branch => (
                  <button
                    key={branch.name}
                    type="button"
                    className="review-branch-option"
                    disabled={branch.current || switchingBranch === branch.name || branchInfo?.dirty}
                    onClick={() => handleSwitchBranch(branch.name)}
                    role="menuitem"
                  >
                    <GitBranch size={13} />
                    <span>{branch.name}</span>
                    {branch.current ? <Check size={14} /> : null}
                  </button>
                ))}
                {filteredBranches.length === 0 ? <div className="review-empty compact">{t('review.noBranches')}</div> : null}
              </div>
            </div>
          ) : null}
        </div>
        <div className="review-branch-copy">
          <span>{branchInfo?.currentBranch ?? t('review.noBranch')}</span>
          {branchInfo?.upstreamBranch ? <small>{branchInfo.upstreamBranch}</small> : null}
        </div>
        <span className="review-total add">+{totalAdditions}</span>
        <span className="review-total del">-{totalDeletions}</span>
        {children}
      </div>
      {branchMessage ? <div className="review-branch-message">{branchMessage}</div> : null}
    </>
  )
}
