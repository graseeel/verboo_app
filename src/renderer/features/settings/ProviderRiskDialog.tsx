import { TriangleAlert } from 'lucide-react'
import { useI18n } from '../../i18n'
import { ProviderIcon } from '../models/ProviderIcon'
import { providerDisplayName, providerToneStyle } from '../models/providerCatalog'

export type ProviderRiskDialogProps = {
  /** Provider whose CLI raised the policy acceptance screen. */
  provider: string
  /** The FULL risk notice, verbatim from provider-login:event — never
   *  summarized: the owner decides with the text in front of them. */
  message: string
  /** Accept the risk and continue (provider_login_confirm_risk). */
  onAccept: () => void
  /** Abort the login (provider_login_cancel). */
  onCancel: () => void
}

const URL_PATTERN = /(https?:\/\/[^\s)]+)/g

/** Faithful render of the notice: line breaks preserved (pre-line) and any
 *  policy/terms URLs in the text become real links. The wording itself is
 *  never touched. */
function FaithfulNotice({ text }: { text: string }) {
  const parts = text.split(URL_PATTERN)
  // String.split with a capturing group keeps the URLs at odd indices.
  return (
    <p className="provider-risk-copy">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <a key={index} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </p>
  )
}

/** F4 — risk_notice dialog (claude login): the Anthropic policy acceptance
 *  screen that precedes the browser flow. Two explicit actions; NO automatic
 *  acceptance. The frame follows the app's ConfirmDialog family (danger tile,
 *  title + subtitle head, neutral cancel + danger accept); the notice itself
 *  renders VERBATIM inside a readable document card. */
export function ProviderRiskDialog({ provider, message, onAccept, onCancel }: ProviderRiskDialogProps) {
  const { t } = useI18n()
  const providerName = providerDisplayName(provider, t)
  const title = t('settings.provider.riskTitle', { provider: providerName })
  return (
    <div className="modal-backdrop">
      <div className="confirm-modal t-modal is-open provider-risk-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="confirm-dialog-head">
          <span className="confirm-dialog-icon" aria-hidden="true">
            <TriangleAlert size={17} />
          </span>
          <div>
            <h2>
              <ProviderIcon providerId={provider} size={15} style={providerToneStyle(provider)} />
              <span>{title}</span>
            </h2>
            <p className="provider-risk-subtitle">{t('settings.provider.riskSubtitle', { provider: providerName })}</p>
          </div>
        </div>
        <div className="provider-risk-document">
          <FaithfulNotice text={message} />
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="danger-button" onClick={onAccept}>
            {t('settings.provider.riskAccept')}
          </button>
        </div>
      </div>
    </div>
  )
}
