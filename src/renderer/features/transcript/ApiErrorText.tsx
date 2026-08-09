import { useI18n } from '../../i18n'
import { parseApiErrorText, presentUsageLimitMessage, presentInvalidThinkingMessage, isInvalidThinkingError } from './apiErrorPresentation'
import { MarkdownMessage } from './MarkdownMessage'

/** Assistant text that may be a provider API error line. Recognized payloads
 *  (usage_limit_reached, the thinking-block 400) render as a readable
 *  headline — never raw JSON in the user's face (field defect). The raw
 *  diagnostic stays available in the turn's system row, behind the collapsed
 *  technical detail. Anything unrecognized renders exactly as before.
 *
 *  T8: the thinking-block 400 also offers an exit — a button to start a
 *  new conversation, since THIS conversation is permanently dead (every
 *  new turn fails the same way until the CLI fixes the block). */
export function ApiErrorAwareText({ text, account, onStartNewConversation }: { text: string; account: string; onStartNewConversation?: () => void }) {
  const { t } = useI18n()
  const info = parseApiErrorText(text)
  const usageLimit = info ? presentUsageLimitMessage(info, account, t) : undefined
  const thinkingBlock = info ? presentInvalidThinkingMessage(info, t) : undefined
  if (usageLimit) return <span className="api-error-readable">{usageLimit}</span>
  if (thinkingBlock) {
    return (
      <span className="api-error-readable api-error-thinking-block">
        <span className="api-error-headline">{thinkingBlock}</span>
        {onStartNewConversation && (
          <button type="button" className="api-error-action" onClick={onStartNewConversation}>
            {t('transcript.startNewConversation')}
          </button>
        )}
      </span>
    )
  }
  return <MarkdownMessage text={text} />
}
