/**
 * QueuePanel — persistent panel integrated into the composer's top edge.
 *
 * Appears automatically when items are queued; no toggle needed.
 * Each item shows: #N, text, edit-inline (matching composer textarea styling),
 * copy, send-now, and cancel/remove.
 */

import { useState } from 'react'
import { Check, Clipboard, Pencil, SendHorizontal, Trash2 } from 'lucide-react'
import { useI18n } from '../../i18n'

type QueuedItem = { id: string; message: string }

type QueuePanelProps = {
  items: QueuedItem[]
  conversationId?: string
  onSendNow: (conversationId: string, queueItemId: string) => void
  onEditQueued: (queueItemId: string, newText: string) => void
  onRemoveItem: (queueItemId: string) => void
}

export function QueuePanel({ items, conversationId, onSendNow, onEditQueued, onRemoveItem }: QueuePanelProps) {
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
    <div className="queue-panel">
      {items.map((item, idx) => (
        <div key={item.id} className="queue-item">
          <span className="queue-item-index">#{idx + 1}</span>
          {editId === item.id ? (
            <div className="queue-item-edit">
              <textarea
                className="queue-edit-input"
                value={editText}
                onChange={e => setEditText(e.target.value)}
                autoFocus
                rows={1}
              />
              <div className="queue-edit-actions">
                <button type="button" className="btn btn-primary btn-sm" disabled={!editText.trim()}
                  onClick={() => { onEditQueued(item.id, editText.trim()); setEditId(undefined) }}>
                  {t('common.save')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditId(undefined)}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <span className="queue-item-text">{item.message}</span>
              <div className="queue-item-actions">
                {conversationId && (
                  <button type="button" className="queue-item-btn queue-item-btn-primary"
                    onClick={() => onSendNow(conversationId, item.id)} title={t('queue.sendNow')}>
                    <SendHorizontal size={13} />
                  </button>
                )}
                <button type="button" className="queue-item-btn"
                  onClick={() => handleCopy(item.message, item.id)} title={t('transcript.copyText')}>
                  {copyFlash === item.id ? <Check size={13} /> : <Clipboard size={13} />}
                </button>
                <button type="button" className="queue-item-btn"
                  onClick={() => { setEditText(item.message); setEditId(item.id) }} title={t('transcript.editMessage')}>
                  <Pencil size={13} />
                </button>
                <button type="button" className="queue-item-btn queue-item-btn-remove"
                  onClick={() => onRemoveItem(item.id)} title={t('common.remove')}>
                  <Trash2 size={13} />
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
