import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Download,
  Loader2,
  RotateCw,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { SidebarUpdatePresentation } from '../../shared/types'
import { useI18n, type Translator } from '../i18n'

type SidebarUpdateControlProps = {
  presentation: SidebarUpdatePresentation
  onAction: () => void
}

type UpdateCopy = {
  title: string
  detail: string
  actionLabel: string
  icon: ReactNode
  pending: boolean
}

export function SidebarUpdateControl({ presentation, onAction }: SidebarUpdateControlProps) {
  const { t } = useI18n()
  const percent = Math.round(Math.min(100, Math.max(0, presentation.percent ?? 0)))
  const copy = getUpdateCopy(presentation, percent, t)

  return (
    <div
      className={`sidebar-update sidebar-update--${presentation.phase}`}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        className="sidebar-update-button ui-tooltip"
        onClick={onAction}
        disabled={!presentation.actionEnabled}
        aria-label={copy.actionLabel}
        data-tooltip={copy.title}
      >
        <span
          key={`icon-${presentation.phase}`}
          className={`sidebar-update-icon ${copy.pending ? 'is-pending' : ''}`}
          aria-hidden="true"
        >
          {copy.icon}
        </span>

        <span key={`copy-${presentation.phase}`} className="sidebar-update-copy">
          <strong>{copy.title}</strong>
          <small>{copy.detail}</small>
        </span>

        <span className="sidebar-update-meta" aria-hidden="true">
          {presentation.phase === 'downloading' ? `${percent}%` : (
            presentation.actionEnabled ? <ChevronRight size={14} /> : null
          )}
        </span>

        {presentation.phase === 'downloading' && (
          <span
            className="sidebar-update-progress"
            role="progressbar"
            aria-label={t('updates.progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span
              className="sidebar-update-progress-fill"
              style={{ transform: `scaleX(${percent / 100})` }}
            />
          </span>
        )}
      </button>
    </div>
  )
}

function getUpdateCopy(
  presentation: SidebarUpdatePresentation,
  percent: number,
  t: Translator,
): UpdateCopy {
  const version = presentation.version ?? ''
  const appVersion = presentation.appVersion ?? version
  const cliVersion = presentation.cliVersion ?? version
  const target = presentation.target ?? 'app'

  switch (presentation.phase) {
    case 'available':
      return {
        title: target === 'both'
          ? t('updates.sidebarBothAvailable')
          : target === 'cli'
            ? t('updates.sidebarCliAvailable')
            : t('updates.sidebarAvailable'),
        detail: target === 'both'
          ? t('updates.statusBothAvailable', { appVersion, cliVersion })
          : target === 'cli'
            ? t('updates.statusCliAvailable', { version: cliVersion })
            : t('updates.statusAvailable', { version: appVersion }),
        actionLabel: target === 'both'
          ? t('updates.downloadBothAria', { appVersion, cliVersion })
          : target === 'cli'
            ? t('updates.downloadCliAria', { version: cliVersion })
            : t('updates.downloadAria', { version: appVersion }),
        icon: <Download size={16} />,
        pending: false,
      }
    case 'downloading':
      return {
        title: target === 'both'
          ? t('updates.sidebarBothDownloading')
          : target === 'cli'
            ? t('updates.sidebarCliDownloading')
            : t('updates.sidebarDownloading'),
        detail: t('updates.statusDownloading', { percent }),
        actionLabel: target === 'both'
          ? t('updates.downloadingBothAria')
          : target === 'cli'
            ? t('updates.downloadingCliAria', { version: cliVersion })
            : t('updates.downloadingAria', { version: appVersion }),
        icon: <Loader2 size={16} />,
        pending: true,
      }
    case 'ready':
      return {
        title: target === 'both'
          ? t('updates.sidebarBothReady')
          : target === 'cli'
            ? t('updates.sidebarCliReady')
            : t('updates.sidebarReady'),
        detail: target === 'both'
          ? t('updates.statusBothDownloaded', { appVersion, cliVersion })
          : target === 'cli'
            ? t('updates.statusCliDownloaded', { version: cliVersion })
            : t('updates.statusDownloaded', { version: appVersion }),
        actionLabel: target === 'both'
          ? t('updates.restartBothAria', { appVersion, cliVersion })
          : target === 'cli'
            ? t('updates.restartCliAria', { version: cliVersion })
            : t('updates.restartAria', { version: appVersion }),
        icon: <CircleCheck size={16} />,
        pending: false,
      }
    case 'waiting':
      return {
        title: t('updates.sidebarWaiting'),
        detail: t('updates.sidebarWaitingBody'),
        actionLabel: t('updates.waitingAria'),
        icon: <Clock3 size={16} />,
        pending: false,
      }
    case 'restarting':
      return {
        title: t('updates.sidebarRestarting'),
        detail: t('updates.sidebarRestartingBody'),
        actionLabel: t('updates.restartingAria'),
        icon: <RotateCw size={16} />,
        pending: true,
      }
    case 'error':
      return {
        title: t('updates.sidebarError'),
        detail: presentation.error || t('updates.statusError'),
        actionLabel: t('updates.retryAria'),
        icon: <CircleAlert size={16} />,
        pending: false,
      }
  }
}
