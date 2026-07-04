import { app, Menu, nativeImage, shell, Tray, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { MenuBarState, UserSettings } from '../../shared/types'

type TrayActions = {
  getWindow: () => BrowserWindow | undefined
  interrupt: () => void
  refreshData: () => void
}

// Alternating icon frames while the agent works: the mascot "breathes" by
// swapping between slightly different sizes (the tray recenters each frame),
// paired with a spinner glyph in the title.
const ICON_FRAME_SIZES = [18, 17, 16, 17]
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export class TrayStatusService {
  private tray: Tray | undefined
  private settings: UserSettings | undefined
  private state: MenuBarState = { execution: 'idle', label: 'Ready' }
  private ticker: ReturnType<typeof setInterval> | undefined
  private renderThrottle: ReturnType<typeof setTimeout> | undefined
  private lastRenderAt = 0
  private frameIndex = 0
  private iconFrames: Electron.NativeImage[] = []
  private readonly iconPath = getTrayIconPath()

  constructor(private readonly actions: TrayActions) {}

  configure(settings: UserSettings): void {
    this.settings = settings
    if (!settings.showInMenuBar) {
      this.stopTicker()
      if (this.renderThrottle) {
        clearTimeout(this.renderThrottle)
        this.renderThrottle = undefined
      }
      this.tray?.destroy()
      this.tray = undefined
      return
    }
    if (!this.tray) {
      const source = nativeImage.createFromPath(this.iconPath)
      this.iconFrames = ICON_FRAME_SIZES.map(size => {
        const frame = source.resize({ width: size, height: size })
        frame.setTemplateImage(false)
        return frame
      })
      this.tray = new Tray(this.iconFrames[0])
      this.tray.setToolTip('Verboo Code')
      this.tray.on('click', () => this.showWindow())
    }
    this.syncTicker()
    this.render()
  }

  update(state: Partial<MenuBarState>): void {
    this.state = { ...this.state, ...state }
    this.syncTicker()
    this.scheduleRender()
  }

  // Rapid updates (one per streamed token) previously rebuilt the whole native
  // tray menu each time. Coalesce them to at most ~5x/second — the context menu
  // is only seen when the user clicks the tray icon, so per-token rebuilds were
  // pure waste on the main thread.
  private scheduleRender(): void {
    const elapsed = Date.now() - this.lastRenderAt
    if (elapsed >= 180) {
      this.renderNow()
      return
    }
    if (!this.renderThrottle) {
      this.renderThrottle = setTimeout(() => this.renderNow(), 180 - elapsed)
    }
  }

  private renderNow(): void {
    if (this.renderThrottle) {
      clearTimeout(this.renderThrottle)
      this.renderThrottle = undefined
    }
    this.lastRenderAt = Date.now()
    this.render()
  }

  private render(): void {
    if (!this.tray || !this.settings?.showInMenuBar) return
    if (this.isAnimating()) {
      this.frameIndex = (this.frameIndex + 1) % (ICON_FRAME_SIZES.length * SPINNER_FRAMES.length)
      this.tray.setImage(this.iconFrames[this.frameIndex % this.iconFrames.length])
    } else if (this.iconFrames.length && this.frameIndex !== 0) {
      this.frameIndex = 0
      this.tray.setImage(this.iconFrames[0])
    }
    this.tray.setTitle(this.settings.showMenuBarText ? this.titleForState() : '')
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: this.titleForState(), enabled: false },
      { type: 'separator' },
      { label: this.state.email ? `Signed in: ${this.state.email}` : 'Not signed in', enabled: false },
      { label: `Model: ${this.state.modelDisplayName ?? this.state.modelId ?? 'not selected'}`, enabled: false },
      { label: `Context: ${formatContext(this.state.contextUsage, this.state.contextWindow)}`, enabled: false },
      this.state.workingDirectory
        ? { label: `Project: ${basename(this.state.workingDirectory)}`, enabled: false }
        : { label: 'Project: no project', enabled: false },
      { type: 'separator' },
      { label: 'Show Verboo', click: () => this.showWindow() },
      { label: 'Hide Window', click: () => this.hideWindow() },
      { label: 'Interrupt Run', enabled: this.state.execution !== 'idle', click: () => this.actions.interrupt() },
      { label: 'Refresh Models and Profile', click: () => this.actions.refreshData() },
      { label: 'Open Verboo Dashboard', click: () => shell.openExternal('https://code.verboo.ai/pt/dashboard') },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]))
  }

  private titleForState(): string {
    const elapsed = this.state.startedAt && this.state.execution !== 'idle'
      ? ` ${formatElapsed(Date.now() - this.state.startedAt)}`
      : ''
    const label = this.state.label ?? labelForExecution(this.state.execution)
    const spinner = this.isAnimating() ? `${SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length]} ` : ''
    return `${spinner}Verboo ${label}${elapsed}`
  }

  private isAnimating(): boolean {
    return this.state.execution !== 'idle'
      && this.state.execution !== 'done'
      && this.state.execution !== 'error'
  }

  private showWindow(): void {
    const window = this.actions.getWindow()
    if (!window) return
    window.show()
    window.focus()
  }

  private hideWindow(): void {
    this.actions.getWindow()?.hide()
  }

  private syncTicker(): void {
    const shouldTick = Boolean(
      this.tray
      && this.settings?.showInMenuBar
      && this.state.startedAt
      && this.state.execution !== 'idle'
      && this.state.execution !== 'done'
      && this.state.execution !== 'error',
    )
    if (shouldTick && !this.ticker) {
      // 400ms drives the icon/spinner frames; the elapsed-time label simply
      // updates a bit more often than before.
      this.ticker = setInterval(() => this.render(), 400)
    }
    if (!shouldTick) {
      this.stopTicker()
      // Rest the icon on its neutral frame when the run ends.
      if (this.tray && this.iconFrames.length && this.frameIndex !== 0) {
        this.frameIndex = 0
        this.tray.setImage(this.iconFrames[0])
      }
    }
  }

  private stopTicker(): void {
    if (!this.ticker) return
    clearInterval(this.ticker)
    this.ticker = undefined
  }
}

function getTrayIconPath(): string {
  return app.isPackaged
    ? join(app.getAppPath(), 'assets', 'branding', 'verboo-mascot.png')
    : join(process.cwd(), 'assets', 'branding', 'verboo-mascot.png')
}

function labelForExecution(execution: MenuBarState['execution']): string {
  if (execution === 'thinking') return 'thinking'
  if (execution === 'tool') return 'working'
  if (execution === 'permission') return 'waiting'
  if (execution === 'done') return 'done'
  if (execution === 'error') return 'error'
  return 'ready'
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

function formatContext(usage?: number, contextWindow?: number): string {
  const total = contextWindow ? formatCompact(contextWindow) : 'unavailable'
  if (usage === undefined) return total
  return `${Math.round(usage * 100)}% of ${total}`
}

function formatCompact(value: number): string {
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
