/**
 * src/renderer/features/queue/QueuePanel.tsx
 *
 * Inline panel anchored above the composer showing queued messages.
 * Each item has inline-edit textarea, copy button, and send-now button.
 * Same visual pattern as VisionFallbackPanel / PermissionApprovalPanel.
 */

import { useState } from 'react'
import { Check, Clipboard, Pencil, SendHorizontal, X } from 'lucide-react'
import { useI18n } from '../../i18n'

type QueuedItem = { id: string; message: string }

type QueuePanelProps = {
  items: QueuedItem[]
  conversationId?: string
  onSendNow: (conversationId: string, queueItemId: string) => void
  onEditQueued: (queueItemId: string, newText: string) => void
  onClose: () => void
}

export function QueuePanel({ items, conversationId, onSendNow, onEditQueued, onClose }: QueuePanelProps) {
  const { t } = useI18n()
  const [editId, setEditId] = useState<string | undefined>()
  const [editText, setEditText] = useState('')
  const [copyFlash, setCopyFlash] = useState<string | undefined>()

  if (!items.length) return null

  function handleCopy(text: string, id: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopyFlash(id)
      setTimeout(() => setCopyFlash(undefined), 1200)
    }).catch(() => {})
  }

  return (
    <section className="queue-panel" role="dialog" aria-label={t('queue.title')}>
      <div className="queue-panel-header">
        <strong>{t('queue.title')}</strong>
        <button type="button" className="queue-panel-close" onClick={onClose} aria-label={t('common.close')}>
          <X size={14} />
        </button>
      </div>

      <div className="queue-panel-items">
        {items.map((item, idx) => (
          <div key={item.id} className="queue-panel-item">
            {editId === item.id ? (
              // Inline edit mode
              <>
                <textarea
                  className="queue-panel-edit-textarea"
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  autoFocus
                  rows={2}
                />
                <div className="queue-panel-edit-actions">
                  <button type="button" className="queue-panel-btn queue-panel-btn-primary" disabled={!editText.trim()}
                    onClick={() => { onEditQueued(item.id, editText.trim()); setEditId(undefined) }}>
                    {t('common.save')}
                  </button>
                  <button type="button" className="queue-panel-btn" onClick={() => setEditId(undefined)}>
                    {t('common.cancel')}
                  </button>
                </div>
              </>
            ) : (
              // Display mode
              <>
                <span className="queue-panel-index">#{idx + 1}</span>
                <span className="queue-panel-text">{item.message}</span>
                <div className="queue-panel-actions">
                  {conversationId && (
                    <button type="button" className="queue-panel-action" onClick={() => onSendNow(conversationId, item.id)}
                      title={t('queue.sendNow')}>
                      <SendHorizontal size={14} />
                    </button>
                  )}
                  <button type="button" className="queue-panel-action" onClick={() => handleCopy(item.message, item.id)}
                    title={t('transcript.copyText')}>
                    {copyFlash === item.id ? <Check size={14} /> : <Clipboard size={14} />}
                  </button>
                  <button type="button" className="queue-panel-action" onClick={() => { setEditText(item.message); setEditId(item.id) }}
                    title={t('transcript.editMessage')}>
                    <Pencil size={14} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
