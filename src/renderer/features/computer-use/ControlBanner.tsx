/**
 * ControlBanner — sticky workspace banner shown when Computer Use is active
 * or paused.
 *
 * Per docs/computer-use-maestro-go.md M3 + Ciri proposal §1.3:
 *   - Always visible while status === 'active' | 'paused'. Non-negotiable.
 *   - Accent pulsing dot = operational signal (PRODUCT.md).
 *   - Sub-text shows current action verb + target so user knows it's not stuck.
 *   - Primary stop hint: ⌘⇧Esc (helper, OS-wide).
 *   - Secondary: Esc when Verboo focused (wired in useComputerUseSession).
 *   - Pause stops new actions but keeps session alive.
 *   - Cancel = emergency stop (no confirmation — banner is the confirmation).
 *
 * Banner is mounted in App.tsx above the workspace, below the topbar.
 * FloatingHUD (P1) is the always-on-top OS surface for when Verboo is
 * minimized — until HUD ships, this banner + the global hotkey are the
 * contract.
 */

import { Pause, Play, X } from 'lucide-react'
import type { ComputerUseActionVerb, ComputerUseSession } from '../../../shared/types'
import { useI18n } from '../../i18n'

type ControlBannerProps = {
  session: ComputerUseSession
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}

export function ControlBanner({ session, onPause, onResume, onCancel }: ControlBannerProps) {
  const { t } = useI18n()
  const isPaused = session.status === 'paused'
  const isSelfTest = session.isSelfTest

  const title = isSelfTest
    ? t('computerUse.active.selfTestTitle')
    : t('computerUse.active.title')
  const body = isPaused
    ? t('computerUse.paused.body')
    : isSelfTest
      ? t('computerUse.active.selfTestBody')
      : t('computerUse.active.body')

  // Action subtext — only when we have a lastAction. Otherwise show a
  // "starting…" hint for the first 2s.
  const elapsedSec = Math.floor((Date.now() - session.startedAt) / 1000)
  const actionSubtext = session.lastAction
    ? t('computerUse.active.action')
        .replace('{verb}', verbLabel(session.lastAction.verb, t))
        .replace('{appName}', session.lastAction.appName)
    : t('computerUse.starting.title').replace('{appName}', session.appName)

  const meta = [
    t('computerUse.active.durationSeconds').replace('{n}', String(elapsedSec)),
    t('computerUse.active.actionCount').replace('{n}', String(session.actionCount)),
  ].join(' · ')

  return (
    <div
      className={`control-banner ${isPaused ? 'is-paused' : 'is-active'} ${isSelfTest ? 'is-self-test' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={title}
    >
      <div className="control-banner-main">
        <span className="control-banner-dot" aria-hidden="true" />
        <div className="control-banner-text">
          <strong className="control-banner-title">{title}</strong>
          <span className="control-banner-body">{body}</span>
          <span className="control-banner-action">{actionSubtext}</span>
          <span className="control-banner-meta">{meta}</span>
        </div>
      </div>
      <div className="control-banner-actions">
        {isPaused ? (
          <button type="button" onClick={onResume} className="control-banner-resume">
            <Play size={13} aria-hidden="true" />
            <span>{t('computerUse.active.resume')}</span>
          </button>
        ) : (
          <button type="button" onClick={onPause} className="control-banner-pause">
            <Pause size={13} aria-hidden="true" />
            <span>{t('computerUse.active.pause')}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="control-banner-cancel"
          aria-label={t('computerUse.active.cancel')}
        >
          <X size={13} aria-hidden="true" />
          <span>{t('computerUse.active.cancel')}</span>
        </button>
      </div>
    </div>
  )
}

function verbLabel(verb: ComputerUseActionVerb, t: (k: string) => string): string {
  // Map verb to a human-readable present-continuous label. The i18n keys
  // are kept short; we don't ship full verb tables yet.
  const map: Record<ComputerUseActionVerb, string> = {
    click: 'clicking',
    type: 'typing',
    drag: 'dragging',
    scroll: 'scrolling',
    read: 'reading screen',
    launch: 'launching',
    close: 'closing',
    hotkey: 'pressing keys',
  }
  return map[verb] ?? String(verb)
}
