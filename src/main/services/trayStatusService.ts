import { app, Menu, nativeImage, shell, Tray, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { MenuBarState, UserSettings } from '../../shared/types'

type TrayActions = {
  getWindow: () => BrowserWindow | undefined
  interrupt: () => void
  refreshData: () => void
}

export class TrayStatusService {
  private tray: Tray | undefined
  private settings: UserSettings | undefined
  private state: MenuBarState = { execution: 'idle', label: 'Pronto' }
  private readonly iconPath = getTrayIconPath()

  constructor(private readonly actions: TrayActions) {}

  configure(settings: UserSettings): void {
    this.settings = settings
    if (!settings.showInMenuBar) {
      this.tray?.destroy()
      this.tray = undefined
      return
    }
    if (!this.tray) {
      const image = nativeImage.createFromPath(this.iconPath).resize({ width: 18, height: 18 })
      this.tray = new Tray(image)
      this.tray.setToolTip('Verboo Code')
      this.tray.on('click', () => this.showWindow())
    }
    this.render()
  }

  update(state: Partial<MenuBarState>): void {
    this.state = { ...this.state, ...state }
    this.render()
  }

  private render(): void {
    if (!this.tray || !this.settings?.showInMenuBar) return
    this.tray.setTitle(this.settings.showMenuBarText ? this.titleForState() : '')
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: this.titleForState(), enabled: false },
      { type: 'separator' },
      { label: this.state.email ? `Conectado: ${this.state.email}` : 'Conta nao conectada', enabled: false },
      { label: `Modelo: ${this.state.modelDisplayName ?? this.state.modelId ?? 'nao selecionado'}`, enabled: false },
      { label: `Contexto: ${formatContext(this.state.contextUsage, this.state.contextWindow)}`, enabled: false },
      this.state.workingDirectory
        ? { label: `Projeto: ${basename(this.state.workingDirectory)}`, enabled: false }
        : { label: 'Projeto: sem projeto', enabled: false },
      { type: 'separator' },
      { label: 'Mostrar Verboo', click: () => this.showWindow() },
      { label: 'Ocultar janela', click: () => this.hideWindow() },
      { label: 'Interromper execucao', enabled: this.state.execution !== 'idle', click: () => this.actions.interrupt() },
      { label: 'Atualizar modelos e perfil', click: () => this.actions.refreshData() },
      { label: 'Abrir dashboard Verboo', click: () => shell.openExternal('https://code.verboo.ai/pt/dashboard') },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]))
  }

  private titleForState(): string {
    const elapsed = this.state.startedAt && this.state.execution !== 'idle'
      ? ` ${formatElapsed(Date.now() - this.state.startedAt)}`
      : ''
    const label = this.state.label ?? labelForExecution(this.state.execution)
    return `Verboo ${label}${elapsed}`
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
}

function getTrayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'assets', 'branding', 'verboo-mascot.png')
    : join(process.cwd(), 'assets', 'branding', 'verboo-mascot.png')
}

function labelForExecution(execution: MenuBarState['execution']): string {
  if (execution === 'thinking') return 'pensando'
  if (execution === 'tool') return 'executando'
  if (execution === 'permission') return 'permissao'
  if (execution === 'done') return 'concluido'
  if (execution === 'error') return 'erro'
  return 'pronto'
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

function formatContext(usage?: number, contextWindow?: number): string {
  const total = contextWindow ? formatCompact(contextWindow) : 'indisponivel'
  if (usage === undefined) return total
  return `${Math.round(usage * 100)}% de ${total}`
}

function formatCompact(value: number): string {
  return Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
