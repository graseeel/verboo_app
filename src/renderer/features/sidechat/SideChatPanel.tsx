import { MessageCircle, Send, Square, X } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { Annotation, StoredConversation } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { MarkdownMessage } from '../transcript/MarkdownMessage'
import { TurnErrorDetails } from '../transcript/TurnErrorDetails'
import { groupSideChatMessages } from './sideChatMessages'

export function SideChatPanel({
  conversation,
  context,
  busy,
  disabled = false,
  onSubmit,
  onStop,
  onClose,
  onFocusConversation,
  auxiliary,
}: {
  conversation: StoredConversation
  context: Annotation
  busy: boolean
  disabled?: boolean
  onSubmit: (message: string) => void
  onStop?: () => void
  onClose: () => void
  onFocusConversation?: () => void
  auxiliary?: ReactNode
}) {
  const { t } = useI18n()
  const stopMode = busy && Boolean(onStop)
  const [value, setValue] = useState('')
  const messages = groupSideChatMessages(conversation.items)
  const firstUserMessage = messages.find(item => item.role === 'user')?.text.trim()
  const title = firstUserMessage || t('sideChat.title')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = value.trim()
    if (!trimmed || busy || disabled) return
    setValue('')
    onSubmit(trimmed)
  }

  return (
    <aside
      className="sidechat-panel"
      aria-label={t('sideChat.panelAria')}
      onFocusCapture={onFocusConversation}
      onPointerDownCapture={onFocusConversation}
    >
      <header className="sidechat-header">
        <div className="sidechat-title">
          <MessageCircle size={15} aria-hidden="true" />
          <strong data-testid="sidechat-title" title={title}>{title}</strong>
        </div>
        <button type="button" className="sidechat-close" onClick={onClose} aria-label={t('sideChat.closeAria')}>
          <X size={16} />
        </button>
      </header>

      <section className="sidechat-context" aria-label={t('sideChat.contextLabel')}>
        <div className="sidechat-context-chip">{t('sideChat.selectedExcerptOne')}</div>
        <blockquote>{context.quote}</blockquote>
      </section>

      <section className="sidechat-messages" aria-live="polite">
        {messages.map(item => (
          <article key={item.id} className={`sidechat-message ${item.presentation === 'interruption' ? 'assistant' : item.role}`}>
            {item.presentation === 'interruption' || item.role === 'assistant' ? <MarkdownMessage text={item.text} /> : <p>{item.text}</p>}
            {item.errorDetail ? <TurnErrorDetails detail={item.errorDetail} /> : null}
          </article>
        ))}
        {busy && <div className="sidechat-thinking" role="status">{t('sideChat.thinking')}</div>}
      </section>

      {auxiliary}

      <form className="sidechat-form" aria-label={t('sideChat.composerAria')} onSubmit={submit}>
        <textarea
          aria-label={t('sideChat.questionAria')}
          placeholder={t('sideChat.questionPlaceholder')}
          value={value}
          disabled={busy || disabled}
          rows={2}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }}
        />
        <button
          type={stopMode ? 'button' : 'submit'}
          className={`sidechat-send${stopMode ? ' is-stop' : ''}`}
          onClick={stopMode ? onStop : undefined}
          aria-label={stopMode ? t('composer.stop') : t('sideChat.sendAria')}
          title={stopMode ? t('composer.stop') : t('sideChat.sendAria')}
          // Intencional: stop continua habilitado se as demais ações forem
          // bloqueadas, pois um processo já em execução ainda deve parar.
          disabled={!stopMode && (busy || disabled || !value.trim())}
        >
          {stopMode
            ? <Square size={12} fill="currentColor" aria-hidden="true" data-testid="sidechat-stop-icon" />
            : <Send size={15} aria-hidden="true" />}
        </button>
      </form>
    </aside>
  )
}
