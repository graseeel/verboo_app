/**
 * ControlBanner — sticky workspace banner shown when Computer Use is active
 * or paused.
 *
 * Per docs/computer-use-maestro-go.md M3 + Ciri proposal §1.3:
 *   - Always visible while status === 'active' | 'paused'. Non-negotiable.
 *   - Accent pulsing dot = operational signal (PRODUCT.md).
 *   - Sub-text shows current action verb + target so user knows it's not stuck.
 *   - Primary stop hint: plain Esc (helper, OS-wide and consumed).
 *   - Pause stops new actions but keeps session alive.
 *   - Stop = emergency stop (no confirmation — banner is the confirmation).
 *
 * Banner is mounted in App.tsx above the workspace, below the topbar.
 * FloatingHUD (P1) is the always-on-top OS surface for when Verboo is
 * minimized — until HUD ships, this banner + the global hotkey are the
 * contract.
 */

import { AppWindow, Pause, Play, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ComputerUseActionVerb, ComputerUseSession } from '../../../shared/types'
import { useI18n } from '../../i18n'

type ControlBannerProps = {
  session: ComputerUseSession
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onManageApps?: () => void
}

export function ControlBanner({ session, onPause, onResume, onCancel, onManageApps }: ControlBannerProps) {
  const { t } = useI18n()
  const isPaused = session.status === 'paused'
  const isSelfTest = session.isSelfTest
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const title = isPaused
    ? t('computerUse.paused.title')
    : isSelfTest
      ? t('computerUse.active.selfTestTitle')
      : t('computerUse.active.title')
  const body = isPaused
    ? t('computerUse.paused.body')
    : isSelfTest
      ? t('computerUse.active.selfTestBody')
      : t('computerUse.active.body')

  const elapsedSec = Math.max(0, Math.floor((now - session.startedAt) / 1000))
  const actionSubtext = session.currentAction
    ? t('computerUse.active.currentAction')
        .replace('{verb}', inProgressVerbLabel(session.currentAction.verb, t))
        .replace('{appName}', session.currentAction.appName)
    : session.lastAction
    ? t('computerUse.active.lastAction')
        .replace('{verb}', verbLabel(session.lastAction.verb, t))
        .replace('{appName}', session.lastAction.appName)
    : t('computerUse.starting.title').replace('{appName}', session.appName)

  const meta = [
    t('computerUse.active.durationSeconds').replace('{n}', String(elapsedSec)),
    t('computerUse.active.actionCount').replace('{n}', String(session.actionCount)),
  ].join(' · ')
  const approvedApps = session.approvedApps?.map(app => app.displayName).join(', ') || session.appName
  const executorMeta = session.temporaryExecutor && session.executorModel && session.originalModel
    ? t('computerUse.active.temporaryExecutor', {
        executor: session.executorModel.displayName,
        original: session.originalModel.displayName,
      })
    : session.executorModel
      ? t('computerUse.active.executor', { executor: session.executorModel.displayName })
      : undefined

  return (
    <div
      className={`control-banner ${isPaused ? 'is-paused' : 'is-active'} ${isSelfTest ? 'is-self-test' : ''}`}
      role="region"
      aria-label={title}
    >
      <div className="control-banner-main">
        <span className="control-banner-dot" aria-hidden="true" />
        <div className="control-banner-text">
          <strong className="control-banner-title">{title}</strong>
          <span className="control-banner-body">{body}</span>
          <span className="control-banner-action" role="status" aria-live="polite" aria-atomic="true">
            {actionSubtext}
          </span>
          <span className="control-banner-meta">{t('computerUse.active.approvedApps', { apps: approvedApps })}</span>
          {executorMeta && <span className="control-banner-meta control-banner-executor">{executorMeta}</span>}
          <span className="control-banner-meta">{meta}</span>
        </div>
      </div>
      <div className="control-banner-actions">
        {onManageApps && (
          <button
            type="button"
            onClick={onManageApps}
            className="control-banner-apps"
            aria-label={t('computerUse.apps.manage')}
          >
            <AppWindow size={13} aria-hidden="true" />
            <span>{t('computerUse.apps.manage')}</span>
          </button>
        )}
        {isPaused ? (
          <button
            type="button"
            onClick={onResume}
            className="control-banner-resume"
            aria-label={t('computerUse.active.resume')}
          >
            <Play size={13} aria-hidden="true" />
            <span>{t('computerUse.active.resume')}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onPause}
            className="control-banner-pause"
            aria-label={t('computerUse.active.pause')}
          >
            <Pause size={13} aria-hidden="true" />
            <span>{t('computerUse.active.pause')}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="control-banner-cancel"
          aria-label={t('computerUse.active.stopAria')}
        >
          <X size={13} aria-hidden="true" />
          <span>{t('computerUse.active.cancel')}</span>
        </button>
      </div>
    </div>
  )
}

function verbLabel(verb: ComputerUseActionVerb, t: (k: string) => string): string {
  const map: Record<ComputerUseActionVerb, string> = {
    click: 'computerUse.verb.clicked',
    move: 'computerUse.verb.moved',
    type: 'computerUse.verb.typed',
    drag: 'computerUse.verb.dragged',
    scroll: 'computerUse.verb.scrolled',
    read: 'computerUse.verb.read',
    launch: 'computerUse.verb.launched',
    close: 'computerUse.verb.closed',
    hotkey: 'computerUse.verb.hotkey',
  }
  return t(map[verb] ?? String(verb))
}

function inProgressVerbLabel(verb: ComputerUseActionVerb, t: (k: string) => string): string {
  const map: Record<ComputerUseActionVerb, string> = {
    click: 'computerUse.verb.clicking',
    move: 'computerUse.verb.moving',
    type: 'computerUse.verb.typing',
    drag: 'computerUse.verb.dragging',
    scroll: 'computerUse.verb.scrolling',
    read: 'computerUse.verb.reading',
    launch: 'computerUse.verb.launching',
    close: 'computerUse.verb.closing',
    hotkey: 'computerUse.verb.pressingKeys',
  }
  return t(map[verb] ?? String(verb))
}
