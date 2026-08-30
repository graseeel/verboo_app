import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import type { SideChatState } from './sideChat'
import { SIDE_CHAT_SKIP_CLOSE_CONFIRMATION_STORAGE_KEY } from './sideChat'
import { SideChatPanel } from './SideChatPanel'

function hasSkippedCloseConfirmation() {
  return typeof window !== 'undefined'
    && window.localStorage.getItem(SIDE_CHAT_SKIP_CLOSE_CONFIRMATION_STORAGE_KEY) === '1'
}

function persistSkippedCloseConfirmation(skipped: boolean) {
  if (typeof window === 'undefined') return
  if (skipped) {
    window.localStorage.setItem(SIDE_CHAT_SKIP_CLOSE_CONFIRMATION_STORAGE_KEY, '1')
  } else {
    window.localStorage.removeItem(SIDE_CHAT_SKIP_CLOSE_CONFIRMATION_STORAGE_KEY)
  }
}

function SideChatCloseDialog({
  skipConfirmation,
  onSkipConfirmationChange,
  onCancel,
  onConfirm,
}: {
  skipConfirmation: boolean
  onSkipConfirmationChange: (value: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useI18n()
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  return (
    <div className="sidechat-close-backdrop">
      <section
        className="sidechat-close-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidechat-close-title"
        aria-describedby="sidechat-close-body"
      >
        <h2 id="sidechat-close-title">{t('sideChat.closeConfirmTitle')}</h2>
        <p id="sidechat-close-body">{t('sideChat.closeConfirmBody')}</p>
        <label className="sidechat-close-checkbox">
          <input
            type="checkbox"
            checked={skipConfirmation}
            onChange={event => onSkipConfirmationChange(event.target.checked)}
          />
          <span>{t('sideChat.closeConfirmDontAsk')}</span>
        </label>
        <div className="sidechat-close-actions">
          <button ref={cancelRef} type="button" className="sidechat-close-cancel" onClick={onCancel}>
            {t('sideChat.cancel')}
          </button>
          <button type="button" className="sidechat-close-confirm" onClick={onConfirm}>
            {t('sideChat.confirmClose')}
          </button>
        </div>
      </section>
    </div>
  )
}

/**
 * The side chat is a parallel surface, not another active conversation view.
 * Keeping this boundary independent from App's activeView/activeConversationId
 * prevents the main transcript navigation state from controlling its lifetime.
 */
export function SideChatSurface({
  sideChat,
  busy,
  disabled = false,
  onSubmit,
  onStop,
  onClose,
  onFocusConversation,
  auxiliary,
}: {
  sideChat: SideChatState | undefined
  busy: boolean
  disabled?: boolean
  onSubmit: (message: string) => void
  onStop?: () => void
  onClose: () => void
  onFocusConversation?: () => void
  auxiliary?: ReactNode
}) {
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [skipCloseConfirmation, setSkipCloseConfirmation] = useState(hasSkippedCloseConfirmation)

  if (!sideChat) return null

  function requestClose() {
    if (hasSkippedCloseConfirmation()) {
      onClose()
      return
    }
    setCloseDialogOpen(true)
  }

  function cancelClose() {
    setCloseDialogOpen(false)
  }

  function confirmClose() {
    persistSkippedCloseConfirmation(skipCloseConfirmation)
    setCloseDialogOpen(false)
    onClose()
  }

  return (
    <>
      <SideChatPanel
        conversation={sideChat.conversation}
        context={sideChat.context}
        busy={busy}
        disabled={disabled}
        onSubmit={onSubmit}
        onStop={onStop}
        onClose={requestClose}
        onFocusConversation={onFocusConversation}
        auxiliary={auxiliary}
      />
      {closeDialogOpen && (
        <SideChatCloseDialog
          skipConfirmation={skipCloseConfirmation}
          onSkipConfirmationChange={setSkipCloseConfirmation}
          onCancel={cancelClose}
          onConfirm={confirmClose}
        />
      )}
    </>
  )
}
