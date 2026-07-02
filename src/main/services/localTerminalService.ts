import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { normalize } from 'node:path'
import type { IPty } from 'node-pty'
import type { LocalTerminalSession, LocalTerminalStartRequest } from '../../shared/types'

const DEFAULT_SHELL = process.env.SHELL || '/bin/zsh'

type ActiveSession = {
  pty: IPty
  session: LocalTerminalSession
  sanitizeUntil: number
  startupBuffer: string
  startupPromptSent: boolean
}

type DataHandler = (sessionId: string, data: string) => void
type ExitHandler = (sessionId: string, exitCode: number, signal?: number) => void
type ErrorHandler = (sessionId: string, error: string) => void

export class LocalTerminalService {
  private sessions = new Map<string, ActiveSession>()
  private onData: DataHandler | undefined
  private onExit: ExitHandler | undefined
  private onError: ErrorHandler | undefined

  setHandlers(handlers: {
    onData: DataHandler
    onExit: ExitHandler
    onError: ErrorHandler
  }): void {
    this.onData = handlers.onData
    this.onExit = handlers.onExit
    this.onError = handlers.onError
  }

  async start(request: LocalTerminalStartRequest): Promise<LocalTerminalSession> {
    // Lazy-load node-pty only when needed (native module)
    const { default: pty } = await import('node-pty')

    const cwd = await this.resolveCwd(request.cwd)
    const shell = DEFAULT_SHELL
    const id = randomUUID()

    const ptyProcess = pty.spawn(shell, shellArgsFor(shell), {
      name: 'xterm-256color',
      cols: request.cols ?? 80,
      rows: request.rows ?? 24,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'verboo-terminal',
        PROMPT_EOL_MARK: '',
        PROMPT: '%n@%m %1~ %# ',
        RPROMPT: '',
      },
    })

    const session: LocalTerminalSession = {
      id,
      cwd,
      shell,
      createdAt: Date.now(),
      running: true,
    }

    this.sessions.set(id, {
      pty: ptyProcess,
      session,
      sanitizeUntil: Date.now() + 2_000,
      startupBuffer: '',
      startupPromptSent: false,
    })

    ptyProcess.onData((data: string) => {
      const active = this.sessions.get(id)
      let nextData = data
      if (active && Date.now() <= active.sanitizeUntil) {
        nextData = startupTerminalData(active, data)
      }
      if (nextData) this.onData?.(id, nextData)
    })

    ptyProcess.onExit(({ exitCode, signal }) => {
      const active = this.sessions.get(id)
      if (active) {
        active.session.running = false
      }
      this.sessions.delete(id)
      this.onExit?.(id, exitCode, signal)
    })

    return session
  }

  write(sessionId: string, data: string): boolean {
    const active = this.sessions.get(sessionId)
    if (!active || !active.session.running) return false
    try {
      active.pty.write(data)
      return true
    } catch (error) {
      this.onError?.(sessionId, String(error))
      return false
    }
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const active = this.sessions.get(sessionId)
    if (!active || !active.session.running) return false
    try {
      active.pty.resize(cols, rows)
      return true
    } catch (error) {
      this.onError?.(sessionId, String(error))
      return false
    }
  }

  stop(sessionId: string): boolean {
    const active = this.sessions.get(sessionId)
    if (!active) return false
    try {
      active.pty.kill()
    } catch {
      // process may already be dead
    }
    active.session.running = false
    this.sessions.delete(sessionId)
    return true
  }

  getState(): LocalTerminalSession | undefined {
    // Return the most recently created session
    let latest: ActiveSession | undefined
    for (const active of this.sessions.values()) {
      if (!latest || active.session.createdAt > latest.session.createdAt) {
        latest = active
      }
    }
    return latest?.session
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  cleanupAll(): void {
    this.onData = undefined
    this.onExit = undefined
    this.onError = undefined

    for (const [id, active] of this.sessions) {
      try {
        active.pty.kill()
      } catch {
        // ignore
      }
      this.sessions.delete(id)
    }
  }

  private async resolveCwd(requested: string): Promise<string> {
    // Try the requested path first
    if (requested) {
      try {
        const resolved = normalize(requested)
        const stats = await stat(resolved)
        if (stats.isDirectory()) return resolved
      } catch {
        // fall through
      }
    }

    // Try the app working directory
    const appCwd = process.cwd()
    if (appCwd) {
      try {
        const stats = await stat(appCwd)
        if (stats.isDirectory()) return appCwd
      } catch {
        // fall through
      }
    }

    // Try active project path from env or config
    const home = homedir()
    try {
      const stats = await stat(home)
      if (stats.isDirectory()) return home
    } catch {
      // fall through
    }

    return '/'
  }
}

function shellArgsFor(shell: string): string[] {
  const shellName = shell.split('/').at(-1) ?? shell
  return shellName === 'zsh' ? ['-f', '-o', 'NO_PROMPT_SP', '-o', 'NO_PROMPT_CR'] : []
}

function sanitizeStartupTerminalData(data: string): string {
  // Some packaged zsh sessions render a startup line made only of prompt-sp
  // markers before the first real prompt. Drop only that initial artifact.
  return data
    .replace(/%{8,}[ \t]*(?:(?:\r?\n|\r)+)?/g, '')
    .replace(/^(?:\r|\n|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f])+/, '')
}

function startupTerminalData(active: ActiveSession, data: string): string {
  if (!active.startupPromptSent) {
    active.startupBuffer += data
    const prompt = startupPromptFrom(active.startupBuffer)
    if (!prompt) return ''

    active.startupBuffer = ''
    active.startupPromptSent = true
    return prompt
  }

  const sanitized = sanitizeStartupTerminalData(data)
  if (startupPromptOnly(sanitized)) return ''
  return sanitized
}

function startupPromptFrom(data: string): string | undefined {
  const visible = stripTerminalControls(data)
  const prompt = visible.match(/[^\r\n]*@[^\r\n]*[$#%]\s?$/)?.[0]
  return prompt
}

function startupPromptOnly(data: string): boolean {
  const visible = stripTerminalControls(data).trim()
  return /^[^\s@]+@[^\s]+(?:\s+[^\r\n]+)*\s+[$#%]$/.test(visible)
}

function stripTerminalControls(data: string): string {
  return data
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}
