import { ShieldAlert } from 'lucide-react'
import type { SkillSummary } from '../../../shared/types'
import { useI18n } from '../../i18n'

type SkillApprovalPanelProps = {
  skills: SkillSummary[]
  onRespond: (action: { allowOnce: boolean } | { trust: string } | { cancel: true }) => void
}

/**
 * Inline approval panel for untrusted project-root skills. Follows the same
 * bottom-dock pattern as VisionFallbackPanel and PermissionApprovalPanel.
 */
export function SkillApprovalPanel({ skills, onRespond }: SkillApprovalPanelProps) {
  const { t } = useI18n()
  const multiple = skills.length > 1

  return (
    <section className="skill-approval-panel" role="dialog" aria-modal="true">
      <div className="skill-approval-header">
        <ShieldAlert size={16} aria-hidden="true" />
        <span>{multiple ? t('skillApproval.titleMultiple') : t('skillApproval.title')}</span>
      </div>

      <div className="skill-approval-skills">
        {skills.map(s => (
          <div key={s.id} className="skill-approval-item">
            <span className="skill-approval-name">{s.name}</span>
            <span className="skill-approval-path">{s.path}</span>
          </div>
        ))}
      </div>

      <div className="skill-approval-description">
        {t('skillApproval.description')}
      </div>

      <div className="skill-approval-actions">
        <button type="button" onClick={() => onRespond({ allowOnce: true })}>
          {multiple ? t('skillApproval.allowOnceAll') : t('skillApproval.allowOnce')}
        </button>
        {!multiple && (
          <button type="button" onClick={() => onRespond({ trust: skills[0].path })}>
            {t('skillApproval.alwaysTrust')}
          </button>
        )}
        <button className="skill-approval-cancel" type="button" onClick={() => onRespond({ cancel: true })}>
          {t('skillApproval.cancel')}
        </button>
      </div>
    </section>
  )
}
