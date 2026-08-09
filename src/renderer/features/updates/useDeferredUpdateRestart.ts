import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  InstallUpdateResult,
  SidebarUpdatePresentation,
  UpdateSnapshot,
} from '../../../shared/types'

export type UseDeferredUpdateRestartOptions = {
  snapshot?: UpdateSnapshot
  runningCount: number
  check: (userInitiated: boolean) => Promise<UpdateSnapshot>
  download: (userInitiated: boolean) => Promise<UpdateSnapshot>
  install: () => Promise<InstallUpdateResult>
  persistDrafts: () => void
  clearDrafts: () => void
}

export function useDeferredUpdateRestart({
  snapshot,
  runningCount,
  check,
  download,
  install,
  persistDrafts,
  clearDrafts,
}: UseDeferredUpdateRestartOptions) {
  const [restartRequested, setRestartRequested] = useState(false)
  const [backendBusy, setBackendBusy] = useState(false)
  const [observedBusyTurn, setObservedBusyTurn] = useState(false)
  const [failure, setFailure] = useState<string>()
  const requestInFlight = useRef(false)
  const installInFlight = useRef(false)
  const restartCommitted = useRef(false)

  const fail = useCallback((error: unknown) => {
    setRestartRequested(false)
    setFailure(error instanceof Error ? error.message : String(error))
  }, [])

  const requestUpdate = useCallback(async () => {
    if (requestInFlight.current || restartCommitted.current) return
    setFailure(undefined)
    setRestartRequested(true)
    if (snapshot?.status === 'downloaded') return

    requestInFlight.current = true
    try {
      let current = snapshot
      if (
        !current ||
        current.status === 'idle' ||
        current.status === 'error' ||
        current.status === 'not-available'
      ) {
        current = await check(true)
      }
      if (current.status === 'downloaded' || current.status === 'downloading') {
        return
      }
      if (current.status !== 'available') {
        setRestartRequested(false)
        if (current.status === 'error') {
          setFailure(current.error ?? 'Update check failed')
        }
        return
      }

      const downloaded = await download(true)
      if (downloaded.status === 'error') {
        setRestartRequested(false)
        setFailure(downloaded.error ?? 'Update download failed')
      }
    } catch (error) {
      fail(error)
    } finally {
      requestInFlight.current = false
    }
  }, [check, download, fail, snapshot])

  useEffect(() => {
    if (!backendBusy) return
    if (runningCount > 0) {
      setObservedBusyTurn(true)
    } else if (observedBusyTurn) {
      setBackendBusy(false)
      setObservedBusyTurn(false)
    }
  }, [backendBusy, observedBusyTurn, runningCount])

  useEffect(() => {
    if (
      failure ||
      !restartRequested ||
      backendBusy ||
      snapshot?.status !== 'downloaded' ||
      runningCount > 0 ||
      installInFlight.current ||
      restartCommitted.current
    ) {
      return
    }

    installInFlight.current = true
    try {
      persistDrafts()
    } catch (error) {
      installInFlight.current = false
      clearDrafts()
      fail(error)
      return
    }

    void install()
      .then(result => {
        installInFlight.current = false
        if (result.status === 'busy') {
          setBackendBusy(true)
          return
        }
        restartCommitted.current = true
      })
      .catch(error => {
        installInFlight.current = false
        clearDrafts()
        fail(error)
      })
  }, [
    backendBusy,
    clearDrafts,
    fail,
    failure,
    install,
    persistDrafts,
    restartRequested,
    runningCount,
    snapshot?.status,
  ])

  const presentation = useMemo<SidebarUpdatePresentation | undefined>(() => {
    if (failure) {
      return {
        phase: 'error',
        target: snapshot?.target ?? 'app',
        appVersion: snapshot?.availableVersion,
        cliVersion: snapshot?.cliAvailableVersion,
        error: failure,
        actionEnabled: true,
      }
    }
    if (!snapshot) return undefined
    const target = snapshot.target ?? 'app'
    const versions = {
      target,
      version: target === 'cli' ? snapshot.cliAvailableVersion : snapshot.availableVersion,
      appVersion: snapshot.availableVersion,
      cliVersion: snapshot.cliAvailableVersion,
      error: snapshot.error,
    } as const
    if (snapshot.status === 'available') {
      return {
        phase: 'available',
        ...versions,
        actionEnabled: true,
      }
    }
    if (snapshot.status === 'downloading') {
      return {
        phase: 'downloading',
        ...versions,
        percent: snapshot.percent,
        actionEnabled: false,
      }
    }
    if (snapshot.status === 'downloaded' && !restartRequested) {
      return {
        phase: 'ready',
        ...versions,
        actionEnabled: true,
      }
    }
    if (
      snapshot.status === 'downloaded' &&
      (runningCount > 0 || backendBusy)
    ) {
      return {
        phase: 'waiting',
        ...versions,
        actionEnabled: false,
      }
    }
    if (snapshot.status === 'downloaded' && restartRequested) {
      return {
        phase: 'restarting',
        ...versions,
        actionEnabled: false,
      }
    }
    return undefined
  }, [backendBusy, failure, restartRequested, runningCount, snapshot])

  return { presentation, requestUpdate }
}
