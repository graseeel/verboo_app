import { AlertTriangle, Bug, CheckCircle2, Mail, Send, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { FeedbackCategory, FeedbackDiagnostics, FeedbackRequest, FeedbackResult } from '../../../shared/types'
import { useI18n } from '../../i18n'

type FeedbackErrors = Partial<Record<'title' | 'description', string>>

type FeedbackDialogProps = {
  open: boolean
  defaultContact?: string
  diagnostics: FeedbackDiagnostics
  onClose: () => void
  onSubmit: (request: FeedbackRequest) => Promise<FeedbackResult>
}

export function FeedbackDialog({ open, defaultContact, diagnostics, onClose, onSubmit }: FeedbackDialogProps) {
  const { t } = useI18n()
  const [category, setCategory] = useState<FeedbackCategory>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [contact, setContact] = useState(defaultContact ?? '')
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<FeedbackResult | undefined>()
  const [errors, setErrors] = useState<FeedbackErrors>({})

  useEffect(() => {
    if (!open) return
    setCategory('bug')
    setTitle('')
    setDescription('')
    setContact(defaultContact ?? '')
    setIncludeDiagnostics(true)
    setResult(undefined)
    setErrors({})
  }, [defaultContact, open])

  if (!open) return null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextErrors = validateFeedback(title, description, t)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0 || submitting) return
    setSubmitting(true)
    try {
      setResult(await onSubmit({
        category,
        title,
        description,
        contact,
        includeDiagnostics,
        diagnostics: includeDiagnostics ? diagnostics : undefined,
      }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop feedback-backdrop" onMouseDown={onClose}>
      <section
        className="feedback-modal t-modal is-open"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="feedback-header">
          <div>
            <span className="feedback-icon">
              <Bug size={18} />
            </span>
            <div>
              <h2 id="feedback-title">{t('feedback.title')}</h2>
              <p>{t('feedback.subtitle')}</p>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('feedback.close')}>
            <X size={17} />
          </button>
        </header>

        <form className="feedback-form" onSubmit={submit} noValidate>
          <div className="feedback-field-group">
            <div className="feedback-field">
              <label className="feedback-label" htmlFor="feedback-category">{t('feedback.type')}</label>
              <select
                id="feedback-category"
                value={category}
                onChange={event => setCategory(event.target.value as FeedbackCategory)}
              >
                <option value="bug">{t('feedback.bug')}</option>
                <option value="feedback">{t('feedback.feedback')}</option>
                <option value="question">{t('feedback.question')}</option>
              </select>
              <p className="feedback-description">{t('feedback.typeHelp')}</p>
            </div>

            <div className="feedback-field" data-invalid={Boolean(errors.title)}>
              <label className="feedback-label" htmlFor="feedback-title-input">{t('feedback.fieldTitle')}</label>
              <input
                id="feedback-title-input"
                value={title}
                onChange={event => {
                  setTitle(event.target.value)
                  setErrors(current => ({ ...current, title: undefined }))
                }}
                aria-invalid={Boolean(errors.title)}
                aria-describedby={errors.title ? 'feedback-title-error' : 'feedback-title-help'}
                maxLength={160}
                placeholder={t('feedback.titlePlaceholder')}
              />
              {errors.title ? (
                <p id="feedback-title-error" className="feedback-error">{errors.title}</p>
              ) : (
                <p id="feedback-title-help" className="feedback-description">{t('feedback.titleHelp')}</p>
              )}
            </div>

            <div className="feedback-field" data-invalid={Boolean(errors.description)}>
              <label className="feedback-label" htmlFor="feedback-description-input">{t('feedback.description')}</label>
              <textarea
                id="feedback-description-input"
                value={description}
                onChange={event => {
                  setDescription(event.target.value)
                  setErrors(current => ({ ...current, description: undefined }))
                }}
                aria-invalid={Boolean(errors.description)}
                aria-describedby={errors.description ? 'feedback-description-error' : 'feedback-description-help'}
                maxLength={8000}
                rows={6}
                placeholder={t('feedback.descriptionPlaceholder')}
              />
              {errors.description ? (
                <p id="feedback-description-error" className="feedback-error">{errors.description}</p>
              ) : (
                <p id="feedback-description-help" className="feedback-description">{t('feedback.descriptionHelp')}</p>
              )}
            </div>

            <div className="feedback-field">
              <label className="feedback-label" htmlFor="feedback-contact-input">{t('feedback.contact')}</label>
              <input
                id="feedback-contact-input"
                value={contact}
                onChange={event => setContact(event.target.value)}
                maxLength={160}
                placeholder={t('feedback.contactPlaceholder')}
              />
              <p className="feedback-description">{t('feedback.contactHelp')}</p>
            </div>

            <label className="feedback-check">
              <input
                type="checkbox"
                checked={includeDiagnostics}
                onChange={event => setIncludeDiagnostics(event.target.checked)}
              />
              <span>
                <strong>{t('feedback.includeDiagnostics')}</strong>
                <small>{t('feedback.includeDiagnosticsHelp')}</small>
              </span>
            </label>
          </div>

          {result && (
            <div className={`feedback-result ${result.channel}`}>
              {result.channel === 'supabase' ? <CheckCircle2 size={17} /> : <Mail size={17} />}
              <span>{feedbackResultMessage(result, t)}</span>
            </div>
          )}

          {result?.error && (
            <div className="feedback-result warning">
              <AlertTriangle size={17} />
              <span>{t('feedback.submitWarning')}</span>
            </div>
          )}

          <footer className="modal-actions">
            <button type="button" onClick={onClose}>{t('common.cancel')}</button>
            <button className="danger-button" type="submit" disabled={submitting}>
              <Send size={16} />
              {submitting ? t('feedback.sending') : t('feedback.submit')}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

function validateFeedback(title: string, description: string, t: (key: string) => string): FeedbackErrors {
  const errors: FeedbackErrors = {}

  if (title.trim().length < 3) {
    errors.title = t('feedback.titleError')
  }

  if (description.trim().length < 12) {
    errors.description = t('feedback.descriptionError')
  }

  return errors
}

function feedbackResultMessage(result: FeedbackResult, t: (key: string) => string): string {
  return result.channel === 'supabase' ? t('feedback.sentSupabase') : t('feedback.mailFallback')
}
