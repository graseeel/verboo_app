import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalTerminalSession, LocalTerminalStartRequest, TerminalDataEvent } from '../../../shared/types'

const TERMINAL_WIDTH_KEY = 'verboo:terminal-width'
const TERMINAL_DEFAULT_WIDTH = 420
const TERMINAL_MIN_WIDTH = 340
// 760 gives large displays real room; the dynamic viewport clamp below still
// protects smaller windows. Reserving 560px for the chat lane made the
// expandable range ~zero on common window sizes — 480px keeps the composer
// comfortable while letting the terminal actually grow.
const TERMINAL_MAX_WIDTH = 760
const CHAT_MIN_WIDTH = 480
const SAFE_GUTTER = 28
const TERMINAL_UNAVAILABLE_MESSAGE = 'Aumente a largura da janela ou oculte a barra lateral para abrir o terminal.'

export function useLocalTerminal() {
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalWidth, setTerminalWidth] = useState(() => readTerminalWidth())
  const [terminalSession, setTerminalSession] = useState<LocalTerminalSession | undefined>()
  const [terminalUnavailableReason, setTerminalUnavailableReason] = useState<string | undefined>()
  const sessionIdRef = useRef<string | undefined>(undefined)
  const dataCallbackRef = useRef<((data: string) => void) | undefined>(undefined)
  const exitCallbackRef = useRef<(() => void) | undefined>(undefined)

  useEffect(() => {
    if (!terminalUnavailableReason) return undefined
    const timer = window.setTimeout(() => setTerminalUnavailableReason(undefined), 3600)
    return () => window.clearTimeout(timer)
  }, [terminalUnavailableReason])

  useEffect(() => {
    function handleWindowResize() {
      if (!hasTerminalRoom()) {
        if (terminalOpen) {
          setTerminalOpen(false)
          setTerminalUnavailableReason(TERMINAL_UNAVAILABLE_MESSAGE)
        }
        return
      }
      setTerminalWidth(current => persistTerminalWidth(clampWidthForViewport(current)))
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [terminalOpen])

  const open = useCallback(async (cwd: string) => {
    if (!hasTerminalRoom()) {
      setTerminalUnavailableReason(TERMINAL_UNAVAILABLE_MESSAGE)
      return undefined
    }

    const nextWidth = persistTerminalWidth(clampWidthForViewport(terminalWidth))
    setTerminalWidth(nextWidth)

    const existingSession = await window.verboo.terminalGetState()
    if (existingSession?.running) {
      sessionIdRef.current = existingSession.id
      setTerminalSession(existingSession)
      setTerminalOpen(true)
      return existingSession
    }

    const request: LocalTerminalStartRequest = {
      cwd,
      cols: Math.floor((nextWidth - 24) / 9),
      rows: 24,
    }
    const session = await window.verboo.terminalStart(request)
    sessionIdRef.current = session.id
    setTerminalSession(session)
    setTerminalOpen(true)
    return session
  }, [terminalWidth])

  const close = useCallback(() => {
    // Just hide the panel, keep the session alive
    setTerminalOpen(false)
  }, [])

  const stop = useCallback(async () => {
    if (sessionIdRef.current) {
      await window.verboo.terminalStop(sessionIdRef.current)
      sessionIdRef.current = undefined
    }
    setTerminalSession(undefined)
    setTerminalOpen(false)
  }, [])

  const write = useCallback(async (data: string) => {
    if (!sessionIdRef.current) return false
    return window.verboo.terminalWrite(sessionIdRef.current, data)
  }, [])

  const resize = useCallback(async (cols: number, rows: number) => {
    if (!sessionIdRef.current) return false
    return window.verboo.terminalResize(sessionIdRef.current, cols, rows)
  }, [])

  const onTerminalData = useCallback((callback: (data: string) => void) => {
    dataCallbackRef.current = callback
    const cleanup = window.verboo.onTerminalData((event: TerminalDataEvent) => {
      if (event.sessionId === sessionIdRef.current) {
        callback(event.data)
      }
    })
    return cleanup
  }, [])

  const onTerminalExit = useCallback((callback: () => void) => {
    exitCallbackRef.current = callback
    const cleanup = window.verboo.onTerminalExit((event: { sessionId: string }) => {
      if (event.sessionId === sessionIdRef.current) {
        sessionIdRef.current = undefined
        setTerminalSession(current => current && current.id === event.sessionId
          ? { ...current, running: false }
          : current)
        callback()
      }
    })
    return cleanup
  }, [])

  const setWidth = useCallback((width: number) => {
    setTerminalWidth(persistTerminalWidth(clampWidthForViewport(width)))
  }, [])

  const canOpen = useCallback(() => {
    return hasTerminalRoom()
  }, [])

  const toggle = useCallback(async (cwd: string) => {
    if (terminalOpen) {
      close()
      return
    }

    if (!canOpen()) {
      setTerminalUnavailableReason(TERMINAL_UNAVAILABLE_MESSAGE)
      return
    }

    await open(cwd)
  }, [terminalOpen, close, canOpen, open])

  const restartInProject = useCallback(async (cwd: string) => {
    if (!hasTerminalRoom()) {
      setTerminalUnavailableReason(TERMINAL_UNAVAILABLE_MESSAGE)
      return undefined
    }

    const nextWidth = persistTerminalWidth(clampWidthForViewport(terminalWidth))
    setTerminalWidth(nextWidth)

    if (sessionIdRef.current) {
      await window.verboo.terminalStop(sessionIdRef.current)
      sessionIdRef.current = undefined
    }

    const request: LocalTerminalStartRequest = {
      cwd,
      cols: Math.floor((nextWidth - 24) / 9),
      rows: 24,
    }
    const session = await window.verboo.terminalStart(request)
    sessionIdRef.current = session.id
    setTerminalSession(session)
    setTerminalOpen(true)
    return session
  }, [terminalWidth])

  return {
    terminalOpen,
    terminalWidth,
    terminalSession,
    terminalUnavailableReason,
    sessionIdRef,
    open,
    close,
    stop,
    write,
    resize,
    setWidth,
    toggle,
    canOpen,
    restartInProject,
    onTerminalData,
    onTerminalExit,
    MIN_WIDTH: TERMINAL_MIN_WIDTH,
    MAX_WIDTH: TERMINAL_MAX_WIDTH,
    DEFAULT_WIDTH: TERMINAL_DEFAULT_WIDTH,
  }
}

function readTerminalWidth(): number {
  try {
    const stored = window.localStorage.getItem(TERMINAL_WIDTH_KEY)
    if (!stored) return TERMINAL_DEFAULT_WIDTH
    const parsed = Number(stored)
    return Number.isFinite(parsed) && parsed >= TERMINAL_MIN_WIDTH && parsed <= TERMINAL_MAX_WIDTH ? parsed : TERMINAL_DEFAULT_WIDTH
  } catch {
    return TERMINAL_DEFAULT_WIDTH
  }
}

function hasTerminalRoom(): boolean {
  return terminalDynamicMaxWidth() >= TERMINAL_MIN_WIDTH
}

function clampWidthForViewport(width: number): number {
  return clamp(width, TERMINAL_MIN_WIDTH, terminalUpperBound())
}

function terminalUpperBound(): number {
  return Math.max(TERMINAL_MIN_WIDTH, Math.min(TERMINAL_MAX_WIDTH, terminalDynamicMaxWidth()))
}

function terminalDynamicMaxWidth(): number {
  const effectiveSidebarWidth = getEffectiveSidebarWidth()
  return window.innerWidth - effectiveSidebarWidth - CHAT_MIN_WIDTH - SAFE_GUTTER
}

function persistTerminalWidth(width: number): number {
  try {
    window.localStorage.setItem(TERMINAL_WIDTH_KEY, String(width))
  } catch {
    // localStorage can be unavailable in restricted browser modes
  }
  return width
}

function getEffectiveSidebarWidth(): number {
  // The hidden state is expressed purely by --sidebar-width: 0 (the measured
  // rect below already reflects it) — there is no dedicated CSS class for it.
  const sidebar = document.querySelector<HTMLElement>('.app-sidebar')
  if (!sidebar) return 0
  const style = window.getComputedStyle(sidebar)
  if (style.display === 'none' || style.visibility === 'hidden') return 0

  const width = sidebar.getBoundingClientRect().width
  return Number.isFinite(width) && width > 1 ? width : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
