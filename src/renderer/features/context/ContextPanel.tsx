/**
 * src/renderer/features/context/ContextPanel.tsx
 *
 * Popover panel opened by clicking the ContextMeter. Shows estimated context
 * composition (user/assistant text, attachments, skills, queue) and offers
 * honest pruning actions: remove attachments, clear skills, dismiss queued
 * items. All values are clearly labeled as estimates.
 */

import { FileText, Gauge, List, MessageSquare, Trash2, UserRound } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AttachmentMeta, ContextUsageSnapshot, SkillSummary, TranscriptItem } from '../../../shared/types'

// Minimal shape matching App.tsx's local QueuedFollowUp type
type QueuedFollowUp = { id: string; message: string }
import { useI18n } from '../../i18n'

// ── Helpers ────────────────────────────────────────────────────

/** Rough estimate: ~4 chars per token for English/Portuguese text. */
const CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN)
}

/**
 * Total estimated tokens for everything the next turn carries — the same
 * math the panel's per-section breakdown uses, exported so the ContextMeter
 * can show a live percentage when the CLI reports no real usage (the Verboo
 * Router sends all-zero usage objects).
 */
export function estimateTotalContextTokens(
  items: readonly TranscriptItem[],
  attachments: AttachmentMeta[],
  skills: SkillSummary[],
  queue: QueuedFollowUp[],
): number {
  const itemTokens = items
    .filter(i => i.role === 'user' || i.role === 'assistant')
    .reduce((sum, i) => sum + estimateTokens(i.text), 0)
  const attachTokens = attachments
    .filter(a => a.extractedText)
    .reduce((sum, a) => sum + estimateTokens(a.extractedText!), 0)
  const skillTokens = skills.reduce((sum, s) => sum + estimateTokens(s.name + (s.description ?? '')), 0)
  const queueTokens = queue.reduce((sum, q) => sum + estimateTokens(q.message), 0)
  return itemTokens + attachTokens + skillTokens + queueTokens
}

export type ContextSection = {
  key: string
  icon: React.ReactNode
  labelKey: string
  tokens: number
  removable?: boolean
  onRemove?: () => void
}

// ── Component ──────────────────────────────────────────────────

type ContextPanelProps = {
  usage?: ContextUsageSnapshot
  /** Max tokens for the selected model window */
  maxWindow?: number
  /** Conversation items — included in the next turn */
  items: readonly TranscriptItem[]
  /** Pending attachments with extracted text */
  attachments: AttachmentMeta[]
  /** Selected skills (injected into turn) */
  skills: SkillSummary[]
  /** Queued follow-ups */
  queue: QueuedFollowUp[]
  onClearAttachments: () => void
  onClearSkills: () => void
  onOpenSettings?: () => void
  onClose: () => void
}

export function ContextPanel({
  usage,
  maxWindow,
  items,
  attachments,
  skills,
  queue,
  onClearAttachments,
  onClearSkills,
  onOpenSettings,
  onClose,
}: ContextPanelProps) {
  const { t } = useI18n()
  const maxTokens = usage?.maxTokens ?? maxWindow

  // ── Compute sections ────────────────────────────────────────

  const sections = useMemo<ContextSection[]>(() => {
    const result: ContextSection[] = []

    // User messages
    const userTokens = items
      .filter(i => i.role === 'user')
      .reduce((sum, i) => sum + estimateTokens(i.text), 0)
    if (userTokens > 0) result.push({ key: 'user', icon: <UserRound size={14} />, labelKey: 'context.panelUser', tokens: userTokens })

    // Assistant messages
    const asstTokens = items
      .filter(i => i.role === 'assistant')
      .reduce((sum, i) => sum + estimateTokens(i.text), 0)
    if (asstTokens > 0) result.push({ key: 'assistant', icon: <MessageSquare size={14} />, labelKey: 'context.panelAssistant', tokens: asstTokens })

    // Attachments with extracted text
    const attachTokens = attachments
      .filter(a => a.extractedText)
      .reduce((sum, a) => sum + estimateTokens(a.extractedText!), 0)
    if (attachTokens > 0) result.push({
      key: 'attachments',
      icon: <FileText size={14} />,
      labelKey: 'context.panelAttachments',
      tokens: attachTokens,
      removable: true,
      onRemove: onClearAttachments,
    })

    // Skills
    const skillTokens = skills.reduce((sum, s) => sum + estimateTokens(s.name + (s.description ?? '')), 0)
    if (skillTokens > 0) result.push({
      key: 'skills',
      icon: <Gauge size={14} />,
      labelKey: 'context.panelSkills',
      tokens: skillTokens,
      removable: true,
      onRemove: onClearSkills,
    })

    // Queue items
    const queueTokens = queue.reduce((sum, q) => sum + estimateTokens(q.message), 0)
    if (queueTokens > 0) result.push({
      key: 'queue',
      icon: <List size={14} />,
      labelKey: 'context.panelQueue',
      tokens: queueTokens,
      removable: false, // each item can be removed individually; covered by task 1.4
    })

    return result
  }, [items, attachments, skills, queue, onClearAttachments, onClearSkills])

  const totalEstimated = sections.reduce((sum, s) => sum + s.tokens, 0)

  // ── Render ──────────────────────────────────────────────────

  return (
    <div className="context-panel" role="dialog" aria-label={t('context.panelTitle')}>
      <div className="context-panel-header">
        <strong>{t('context.panelTitle')}</strong>
        <small>{t('context.panelSubtitle')}</small>
      </div>

      {/* Composition breakdown */}
      {maxTokens && totalEstimated > 0 && (
        <div className="context-panel-bar" role="img" aria-label={t('context.panelBarAria')}>
          {sections.map(s => {
            const pct = Math.max(3, (s.tokens / maxTokens) * 100)
            return (
              <div
                key={s.key}
                className={`context-panel-bar-seg context-bar-${s.key}`}
                style={{ flexGrow: Math.min(pct, 100) }}
                title={`${s.tokens.toLocaleString()} ${t('context.panelTokens')}`}
              />
            )
          })}
        </div>
      )}

      <div className="context-panel-sections">
        {sections.length === 0 && (
          <div className="context-panel-empty">{t('context.panelEmpty')}</div>
        )}
        {sections.map(s => {
          const pct = maxTokens && maxTokens > 0 ? ((s.tokens / maxTokens) * 100) : undefined
          return (
            <div key={s.key} className={`context-panel-row context-row-${s.key}`}>
              <span className="context-panel-icon">{s.icon}</span>
              <span className="context-panel-label">{t(s.labelKey)}</span>
              <span className="context-panel-tokens">
                {s.tokens.toLocaleString()} t
                {pct !== undefined && <small> ({pct.toFixed(1)}%)</small>}
              </span>
              {s.removable && s.onRemove && (
                <button
                  type="button"
                  className="context-panel-remove"
                  onClick={s.onRemove}
                  aria-label={t('context.panelRemove', { item: t(s.labelKey) })}
                  title={t('context.panelRemove', { item: t(s.labelKey) })}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Disclaimer */}
      <div className="context-panel-disclaimer">
        {t('context.panelDisclaimer')}
      </div>

      {/* Actions footer */}
      <div className="context-panel-footer">
        {onOpenSettings && (
          <button type="button" className="context-panel-action" onClick={onOpenSettings}>
            {t('settings.contextWindow')}
          </button>
        )}
        {totalEstimated > 0 && sections.some(s => s.removable) && (
          <button type="button" className="context-panel-action context-panel-action-warn" onClick={() => {
            sections.filter(s => s.removable && s.onRemove).forEach(s => s.onRemove!())
          }}>
            {t('context.panelClearAll')}
          </button>
        )}
      </div>
    </div>
  )
}
