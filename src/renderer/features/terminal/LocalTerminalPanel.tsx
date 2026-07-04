import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { PanelRightClose, RefreshCw, Square, TerminalSquare } from 'lucide-react'
import type { LocalTerminalSession } from '../../../shared/types'
import { useI18n } from '../../i18n'

type LocalTerminalPanelProps = {
  terminalOpen: boolean
  terminalWidth: number
  onSetWidth: (width: number) => void
  onWrite: (data: string) => Promise<boolean>
  onResize: (cols: number, rows: number) => Promise<boolean>
  onClose: () => void
  onStop: () => Promise<void>
  onRestartInProject: () => Promise<LocalTerminalSession | undefined>
  onTerminalData: (callback: (data: string) => void) => () => void
  onTerminalExit: (callback: () => void) => () => void
  session?: LocalTerminalSession
  workingDirectory: string
  minWidth: number
  maxWidth: number
}

export function LocalTerminalPanel({
  terminalOpen,
  terminalWidth,
  onSetWidth,
  onWrite,
  onResize,
  onClose,
  onStop,
  onRestartInProject,
  onTerminalData,
  onTerminalExit,
  session,
  workingDirectory,
  minWidth,
  maxWidth,
}: LocalTerminalPanelProps) {
  const { t } = useI18n()
  const terminalRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<Terminal | undefined>(undefined)
  const fitAddonRef = useRef<FitAddon | undefined>(undefined)
  const lastSessionIdRef = useRef<string | undefined>(undefined)
  const startupOutputRef = useRef<{ sessionId?: string; until: number; buffer: string; pending: boolean }>({
    until: 0,
    buffer: '',
    pending: false,
  })
  const resizerRef = useRef<HTMLDivElement | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | undefined>(undefined)
  const [restarting, setRestarting] = useState(false)

  // Initialize xterm
  useEffect(() => {
    const termContainer = terminalRef.current
    if (!termContainer) return

    // Avoid creating multiple instances
    if (xtermRef.current) return

    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 13,
      fontFamily: 'SF Mono, Menlo, Monaco, "Cascadia Code", "Fira Code", monospace',
      lineHeight: 1.35,
      letterSpacing: 0,
      theme: {
        background: '#0a0c14',
        foreground: '#c8cee6',
        cursor: '#a96dff',
        cursorAccent: '#0a0c14',
        selectionBackground: 'rgba(169, 109, 255, 0.18)',
        black: '#1a1d2e',
        red: '#ff6978',
        green: '#40c878',
        yellow: '#ff8b4a',
        blue: '#7c97ff',
        magenta: '#a96dff',
        cyan: '#5ed8ef',
        white: '#c8cee6',
        brightBlack: '#555d76',
        brightRed: '#ff6978',
        brightGreen: '#40c878',
        brightYellow: '#ff8b4a',
        brightBlue: '#7c97ff',
        brightMagenta: '#a96dff',
        brightCyan: '#5ed8ef',
        brightWhite: '#eef1ff',
      },
      allowTransparency: false,
      cols: 40,
      rows: 15,
    })

    term.loadAddon(fitAddon)
    term.open(termContainer)

    // Fit after opening
    requestAnimationFrame(() => {
      try {
        fitAddon.fit()
      } catch {
        // ignore fit errors during mount
      }
    })

    // Send input from terminal to PTY
    term.onData((data: string) => {
      void onWrite(data)
    })

    // Electron does not always route native clipboard shortcuts into xterm.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return true
      const key = e.key.toLowerCase()

      if (key === 'c') {
        if (term.hasSelection()) {
          e.preventDefault()
          e.stopPropagation()
          void window.verboo.clipboardWriteText(term.getSelection()).catch(() => undefined)
          return false
        }
        return true
      }

      if (key === 'v') {
        e.preventDefault()
        e.stopPropagation()
        void window.verboo
          .clipboardReadText()
          .then(text => {
            if (text) void onWrite(text)
          })
          .catch(() => undefined)
        return false
      }

      return true
    })

    xtermRef.current = term

    return () => {
      // Cleanup xterm on unmount
      term.dispose()
      xtermRef.current = undefined
      fitAddonRef.current = undefined
    }
  }, [onWrite])

  useEffect(() => {
    if (!session?.id || lastSessionIdRef.current === session.id) return
    lastSessionIdRef.current = session.id
    startupOutputRef.current = {
      sessionId: session.id,
      until: Date.now() + 1_500,
      buffer: '',
      pending: true,
    }
    xtermRef.current?.reset()
    xtermRef.current?.clear()
  }, [session?.id])

  useEffect(() => {
    if (!terminalOpen || session?.id) return
    startupOutputRef.current = {
      until: Date.now() + 1_500,
      buffer: '',
      pending: true,
    }
  }, [terminalOpen, session?.id])

  // Handle terminal data from main process
  useEffect(() => {
    if (!xtermRef.current) return undefined

    const cleanup = onTerminalData((data: string) => {
      const startup = startupOutputRef.current
      if (startup.pending) {
        startup.buffer += data
        const cleaned = sanitizeStartupTerminalOutput(startup.buffer)
        const promptReady = startupPromptReady(cleaned)
        if (Date.now() <= startup.until && !promptReady) {
          return
        }
        startup.pending = false
        startup.buffer = ''
        if (cleaned) {
          const startupText = promptReady ? startupPromptText(cleaned) : cleaned
          if (promptReady) {
            const term = xtermRef.current
            term?.reset()
            term?.clear()
            requestAnimationFrame(() => term?.write(`\x1b[2J\x1b[H${startupText}`))
          } else {
            xtermRef.current?.write(startupText)
          }
        }
        return
      }

      xtermRef.current?.write(data)
    })

    return cleanup
  }, [onTerminalData])

  // Handle terminal exit
  useEffect(() => {
    if (!xtermRef.current) return undefined

    const cleanup = onTerminalExit(() => {
      // Show termination notice
      xtermRef.current?.writeln(`\r\n\x1b[90m━━━ ${t('terminal.ended')} ━━━\x1b[0m`)
    })

    return cleanup
  }, [onTerminalExit, t])

  // Fit terminal on mount and when width changes
  useEffect(() => {
    if (!terminalOpen || !fitAddonRef.current) return

    requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit()
      } catch {
        // ignore
      }
    })
  }, [terminalOpen, terminalWidth])

  // ResizeObserver for terminal container
  useEffect(() => {
    if (!terminalOpen || !terminalRef.current) return

    const container = terminalRef.current

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          const fitAddon = fitAddonRef.current
          if (!fitAddon) return
          fitAddon.fit()
          const dims = fitAddon.proposeDimensions()
          if (dims) {
            void onResize(dims.cols, dims.rows)
          }
        } catch {
          // ignore resize errors
        }
      })
    })

    observer.observe(container)
    resizeObserverRef.current = observer

    return () => {
      observer.disconnect()
    }
  }, [terminalOpen, onResize])

  // Manual resize handler
  const handleResizerPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()

    const startX = event.clientX
    const startWidth = terminalWidth
    // Resizes must track the pointer 1:1 — the layout's grid transition would
    // otherwise chase every move with an eased animation (rubber-band feel).
    document.querySelector('.app-layout')?.classList.add('is-resizing')

    function handlePointerMove(moveEvent: PointerEvent) {
      // The panel sits on the right edge, so dragging LEFT (clientX decreases)
      // must GROW it. The previous sign flipped this: dragging left shrank
      // (clamped at min, so "nothing happened") and dragging right closed.
      onSetWidth(startWidth + (startX - moveEvent.clientX))
    }

    function stopResize() {
      document.querySelector('.app-layout')?.classList.remove('is-resizing')
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
  }, [terminalWidth, onSetWidth])

  // Focus terminal when panel opens
  useEffect(() => {
    if (!terminalOpen) return
    const timer = setTimeout(() => {
      xtermRef.current?.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [terminalOpen])

  const handleStop = useCallback(async () => {
    await onStop()
  }, [onStop])

  const handleRestart = useCallback(async () => {
    setRestarting(true)
    try {
      // Kill existing sessions via stop
      await onStop()
      // Start a new session via restart
      await onRestartInProject()
    } finally {
      setRestarting(false)
    }
  }, [onStop, onRestartInProject])

  const displayDirectory = session?.cwd ?? workingDirectory

  return (
    <aside
      className={`terminal-panel ${terminalOpen ? 'is-open' : 'is-hidden'}`}
      style={{ width: terminalOpen ? terminalWidth : 0 }}
      aria-hidden={!terminalOpen}
    >
      <div
        className="terminal-resizer"
        onPointerDown={handleResizerPointerDown}
      />

      <header className="terminal-header">
        <span className="terminal-title">
          <TerminalSquare size={13} />
          {t('terminal.title')}
        </span>
        <span className="terminal-cwd" title={displayDirectory}>
          {workspaceFolderName(displayDirectory) || t('terminal.noSession')}
        </span>
        <div className="terminal-actions">
          <button
            type="button"
            className="terminal-action ui-tooltip"
            onClick={handleRestart}
            disabled={restarting}
            data-tooltip={t('terminal.restart')}
            data-tooltip-align="end"
            aria-label={t('terminal.restartAria')}
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            className="terminal-action ui-tooltip"
            onClick={handleStop}
            data-tooltip={t('terminal.stop')}
            data-tooltip-align="end"
            aria-label={t('terminal.stopAria')}
          >
            <Square size={12} />
          </button>
          <button
            type="button"
            className="terminal-action ui-tooltip"
            onClick={onClose}
            data-tooltip={t('terminal.hide')}
            data-tooltip-align="end"
            aria-label={t('terminal.hideAria')}
          >
            <PanelRightClose size={13} />
          </button>
        </div>
      </header>

      <div ref={terminalRef} className="terminal-xterm" />
    </aside>
  )
}

function workspaceFolderName(path: string): string {
  if (!path) return ''
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function sanitizeStartupTerminalOutput(data: string): string {
  return data.replace(
    /(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|[ \t]|%){12,}(?=(?:\x1b\[[0-?]*[ -/]*[@-~]|[ \t])*[^\s@]+@)/g,
    '',
  ).replace(
    /^(?:\r|\n|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f])+/,
    '',
  )
}

function startupPromptReady(data: string): boolean {
  const visible = stripTerminalControls(data)
  return /[^\s@]+@[^\s]+[^\r\n]*[$#%]\s?$/.test(visible)
}

function startupPromptText(data: string): string {
  const visible = stripTerminalControls(data)
  return visible.match(/[^\r\n]*@[^\r\n]*[$#%]\s?$/)?.[0] ?? visible
}

function stripTerminalControls(data: string): string {
  return data
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}
