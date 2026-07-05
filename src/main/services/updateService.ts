import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
// electron-updater is CommonJS; in this ESM main process only the default
// export is reliable at runtime — named imports crash with
// "Named export 'autoUpdater' not found" in the packaged app.
import electronUpdater from 'electron-updater'
import type { ProgressInfo, UpdateCheckResult, UpdateInfo } from 'electron-updater'

const { autoUpdater } = electronUpdater
import packageJson from '../../../package.json'
import type { UpdateSettings, UpdateSnapshot } from '../../shared/types'

type UpdateListener = (snapshot: UpdateSnapshot) => void

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export class UpdateService {
  private settings: UpdateSettings = {
    channel: 'beta',
    autoCheck: true,
    autoDownload: false,
  }

  private snapshot: UpdateSnapshot = {
    status: app.isPackaged ? 'idle' : 'unsupported',
    channel: 'beta',
    currentVersion: packageJson.version,
  }

  private listener: UpdateListener
  private timer: NodeJS.Timeout | undefined
  private checking = false
  private downloaded = false

  constructor(listener: UpdateListener) {
    this.listener = listener

    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('checking-for-update', () => this.setSnapshot({ status: 'checking', error: undefined }))
    autoUpdater.on('update-available', info => this.setSnapshot(updateInfoToSnapshot('available', this.snapshot, info)))
    autoUpdater.on('update-not-available', info => this.setSnapshot(updateInfoToSnapshot('not-available', this.snapshot, info)))
    autoUpdater.on('download-progress', progress => this.onDownloadProgress(progress))
    autoUpdater.on('update-downloaded', info => {
      this.downloaded = true
      this.setSnapshot(updateInfoToSnapshot('downloaded', this.snapshot, info, {
        downloadedAt: Date.now(),
        percent: 100,
      }))
    })
    autoUpdater.on('error', error => this.setSnapshot({
      status: 'error',
      error: normalizeUpdateError(error),
    }))
  }

  configure(settings: UpdateSettings): void {
    this.settings = settings
    autoUpdater.autoDownload = settings.autoDownload
    autoUpdater.allowPrerelease = settings.channel === 'beta'
    this.setSnapshot({
      channel: settings.channel,
      status: this.updaterAvailable() ? this.snapshot.status : 'unsupported',
    })

    if (settings.autoCheck && this.updaterAvailable()) {
      this.startTimer()
    } else {
      this.stopTimer()
    }
  }

  getSnapshot(): UpdateSnapshot {
    return this.snapshot
  }

  // electron-updater needs the app-update.yml manifest that electron-builder
  // only emits for distributable targets (DMG/ZIP). Directory builds
  // (electron-builder --dir) are packaged but carry no manifest — checking
  // there would surface a raw ENOENT to the user instead of a clear state.
  private updaterAvailable(): boolean {
    if (!app.isPackaged) return false
    try {
      return existsSync(join(process.resourcesPath, 'app-update.yml'))
    } catch {
      return false
    }
  }

  async checkForUpdates(userInitiated = false): Promise<UpdateSnapshot> {
    if (!this.updaterAvailable()) {
      return this.setSnapshot({
        status: 'unsupported',
        error: 'Atualizações automáticas só funcionam em builds instalados a partir de um release (DMG/ZIP).',
        lastCheckedAt: Date.now(),
      })
    }

    if (this.checking) return this.snapshot

    this.checking = true
    this.downloaded = false
    try {
      const result: UpdateCheckResult | null = await autoUpdater.checkForUpdates()
      if (!result && userInitiated) {
        this.setSnapshot({
          status: 'not-available',
          lastCheckedAt: Date.now(),
        })
      }
      return this.snapshot
    } catch (error) {
      return this.setSnapshot({
        status: 'error',
        error: normalizeUpdateError(error),
        lastCheckedAt: Date.now(),
      })
    } finally {
      this.checking = false
    }
  }

  async downloadUpdate(): Promise<UpdateSnapshot> {
    if (!this.updaterAvailable()) {
      return this.setSnapshot({
        status: 'unsupported',
        error: 'Baixar atualização exige um build instalado a partir de um release (DMG/ZIP).',
      })
    }
    if (this.downloaded) return this.snapshot
    try {
      this.setSnapshot({ status: 'downloading', error: undefined })
      await autoUpdater.downloadUpdate()
      return this.snapshot
    } catch (error) {
      return this.setSnapshot({
        status: 'error',
        error: normalizeUpdateError(error),
      })
    }
  }

  quitAndInstall(): void {
    if (this.snapshot.status !== 'downloaded') return
    autoUpdater.quitAndInstall(false, true)
  }

  dispose(): void {
    this.stopTimer()
  }

  private startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(() => {
      void this.checkForUpdates(false)
    }, CHECK_INTERVAL_MS)
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  private onDownloadProgress(progress: ProgressInfo): void {
    this.setSnapshot({
      status: 'downloading',
      percent: progress.percent,
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    })
  }

  private setSnapshot(patch: Partial<UpdateSnapshot>): UpdateSnapshot {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      channel: patch.channel ?? this.settings.channel,
      currentVersion: packageJson.version,
    }
    this.listener(this.snapshot)
    return this.snapshot
  }
}

function updateInfoToSnapshot(
  status: UpdateSnapshot['status'],
  current: UpdateSnapshot,
  info: UpdateInfo,
  extra: Partial<UpdateSnapshot> = {},
): UpdateSnapshot {
  return {
    ...current,
    ...extra,
    status,
    availableVersion: info.version,
    releaseName: info.releaseName ?? undefined,
    releaseDate: info.releaseDate,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    lastCheckedAt: Date.now(),
    error: undefined,
  }
}

function normalizeUpdateError(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Falha desconhecida ao verificar atualização.'
}
