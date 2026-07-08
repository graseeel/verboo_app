import { ShieldCheck, Terminal, XCircle } from 'lucide-react'
import { useI18n } from '../../i18n'

export type PendingPermissionPrompt = {
  id: string
  turnId: string
  conversationId: string
  command?: string
  detail: string
  autoApprove: boolean
}

type PermissionApprovalPanelProps = {
  prompt: PendingPermissionPrompt
  onAllow: () => void
  onDeny: () => void
  onAlwaysAllow: () => void
}

export function PermissionApprovalPanel({ prompt, onAllow, onDeny, onAlwaysAllow }: PermissionApprovalPanelProps) {
  const { t } = useI18n()
  return (
    <section className="permission-approval-panel" aria-live="polite">
      <div className="permission-approval-icon">
        <Terminal size={16} />
      </div>
      <div className="permission-approval-copy">
        <strong>{t('permissionPrompt.title')}</strong>
        <p>{prompt.command ? t('permissionPrompt.commandBody') : prompt.detail}</p>
        {prompt.command && <code>{prompt.command}</code>}
      </div>
      <div className="permission-approval-actions">
        <button type="button" onClick={onDeny}>
          <XCircle size={15} />
          {t('permissionPrompt.deny')}
        </button>
        {prompt.command && (
          <button className="trust" type="button" onClick={onAlwaysAllow}>
            <ShieldCheck size={15} />
            {t('permissionPrompt.alwaysAllow')}
          </button>
        )}
        <button className="primary" type="button" onClick={onAllow}>
          {t('permissionPrompt.allow')}
        </button>
      </div>
    </section>
  )
}
