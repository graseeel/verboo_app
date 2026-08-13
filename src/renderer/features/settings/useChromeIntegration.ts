import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ChromeIntegrationRequest,
  ChromeIntegrationStatus,
  ChromeConnectionTestResult,
} from '../../../shared/types'

const CHROME_EXTENSION_ID = /^[a-p]{32}$/

type ChromeIntegrationAction = 'configure' | 'repair' | 'test' | 'remove' | 'store'

function errorCode(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return 'chrome_integration_unknown_error'
}

export function useChromeIntegration() {
  const [status, setStatus] = useState<ChromeIntegrationStatus>()
  const [loading, setLoading] = useState(true)
  const [activeAction, setActiveAction] = useState<ChromeIntegrationAction>()
  const [error, setError] = useState<string>()
  const [developmentExtensionId, setDevelopmentExtensionId] = useState('')
  const [lastTestPassed, setLastTestPassed] = useState<boolean>()
  const [lastTestResult, setLastTestResult] = useState<ChromeConnectionTestResult>()

  const developmentIdValid = useMemo(() => {
    const value = developmentExtensionId.trim()
    return value.length === 0 || CHROME_EXTENSION_ID.test(value)
  }, [developmentExtensionId])

  const request = useCallback((): ChromeIntegrationRequest => {
    const value = developmentExtensionId.trim()
    return value ? { developmentExtensionId: value } : {}
  }, [developmentExtensionId])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const next = await window.verboo.chromeIntegrationStatus()
      setStatus(next)
      if (next.errorCode) setError(next.errorCode)
      return next
    } catch (caught) {
      setError(errorCode(caught))
      return undefined
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runStatusAction = useCallback(async (
    action: Extract<ChromeIntegrationAction, 'configure' | 'repair' | 'remove'>,
    operation: () => Promise<ChromeIntegrationStatus>,
  ) => {
    setActiveAction(action)
    setError(undefined)
    try {
      const next = await operation()
      setStatus(next)
      if (next.errorCode) setError(next.errorCode)
      return next
    } catch (caught) {
      setError(errorCode(caught))
      return undefined
    } finally {
      setActiveAction(undefined)
    }
  }, [])

  const configure = useCallback(async () => {
    if (!developmentIdValid) {
      setError('chrome_extension_id_invalid')
      return undefined
    }
    return runStatusAction('configure', () => window.verboo.chromeIntegrationConfigure(request()))
  }, [developmentIdValid, request, runStatusAction])

  const repair = useCallback(async () => {
    if (!developmentIdValid) {
      setError('chrome_extension_id_invalid')
      return undefined
    }
    return runStatusAction('repair', () => window.verboo.chromeIntegrationRepair(request()))
  }, [developmentIdValid, request, runStatusAction])

  const testConnection = useCallback(async () => {
    setActiveAction('test')
    setError(undefined)
    try {
      const result = await window.verboo.chromeIntegrationTest()
      setLastTestResult(result)
      setLastTestPassed(result.connected)
      await refresh()
      if (result.errorCode) setError(result.errorCode)
      return result.connected
    } catch (caught) {
      setLastTestPassed(false)
      setError(errorCode(caught))
      return false
    } finally {
      setActiveAction(undefined)
    }
  }, [refresh])

  const remove = useCallback(
    () => runStatusAction('remove', () => window.verboo.chromeIntegrationRemove()),
    [runStatusAction],
  )

  const openStore = useCallback(async () => {
    setActiveAction('store')
    setError(undefined)
    try {
      return await window.verboo.openChromeExtensionStore()
    } catch (caught) {
      setError(errorCode(caught))
      return false
    } finally {
      setActiveAction(undefined)
    }
  }, [])

  return {
    status,
    loading,
    activeAction,
    error,
    developmentExtensionId,
    developmentIdValid,
    lastTestPassed,
    lastTestResult,
    setDevelopmentExtensionId,
    refresh,
    configure,
    repair,
    testConnection,
    remove,
    openStore,
  }
}
