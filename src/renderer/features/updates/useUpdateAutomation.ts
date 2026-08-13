import { useEffect, useRef } from 'react'

import type { UpdateChannel, UpdateSnapshot } from '../../../shared/types'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

type UseUpdateAutomationOptions = {
  autoCheck: boolean
  autoDownload: boolean
  channel: UpdateChannel
  snapshot?: UpdateSnapshot
  check: (userInitiated: boolean) => Promise<UpdateSnapshot>
  download: (userInitiated: boolean) => Promise<UpdateSnapshot>
}

export function useUpdateAutomation({
  autoCheck,
  autoDownload,
  channel,
  snapshot,
  check,
  download,
}: UseUpdateAutomationOptions) {
  const stagedRelease = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!autoCheck) return

    const run = () => {
      void check(false).catch(() => undefined)
    }
    run()
    const timer = window.setInterval(run, SIX_HOURS_MS)
    return () => window.clearInterval(timer)
  }, [autoCheck, channel, check])

  useEffect(() => {
    const version = snapshot?.availableVersion
    const includesApp = snapshot?.target == null
      || snapshot.target === 'app'
      || snapshot.target === 'both'
    if (!autoDownload || snapshot?.status !== 'available' || !includesApp || !version) return

    const releaseKey = `${channel}:${version}`
    if (stagedRelease.current === releaseKey) return
    stagedRelease.current = releaseKey
    void download(false).catch(() => undefined)
  }, [autoDownload, channel, download, snapshot?.availableVersion, snapshot?.status, snapshot?.target])
}
