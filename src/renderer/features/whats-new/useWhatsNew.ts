import { useCallback, useEffect, useRef, useState } from 'react'
import type { WhatsNewAcknowledgeResult, WhatsNewStatus } from '../../../shared/types'

type UseWhatsNewOptions = {
  enabled: boolean
  getStatus?: () => Promise<WhatsNewStatus | undefined>
  acknowledge?: (version: string) => Promise<WhatsNewAcknowledgeResult>
}

export function useWhatsNew({
  enabled,
  getStatus = window.verboo.getWhatsNewStatus,
  acknowledge = window.verboo.acknowledgeWhatsNew,
}: UseWhatsNewOptions) {
  const [status, setStatus] = useState<WhatsNewStatus | undefined>()
  const requested = useRef(false)

  useEffect(() => {
    if (!enabled || requested.current) return
    requested.current = true
    let active = true
    void getStatus()
      .then((next) => { if (active) setStatus(next) })
      .catch((error) => console.error('[verboo:whats-new] failed to read release state', error))
    return () => { active = false }
  }, [enabled, getStatus])

  const acknowledgeCurrent = useCallback(async (version: string) => {
    try {
      return await acknowledge(version)
    } finally {
      setStatus(undefined)
    }
  }, [acknowledge])

  return { status, acknowledge: acknowledgeCurrent }
}
