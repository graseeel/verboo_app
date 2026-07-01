import { AlertTriangle, Bug, CheckCircle2, Mail, Send, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { FeedbackCategory, FeedbackDiagnostics, FeedbackRequest, FeedbackResult } from '../../../shared/types'

type FeedbackErrors = Partial<Record<'title' | 'description', string>>

type FeedbackDialogProps = {
  open: boolean
  defaultContact?: string
  diagnostics: FeedbackDiagnostics
  onClose: () => void
  onSubmit: (request: FeedbackRequest) => Promise<FeedbackResult>
}

export function FeedbackDialog({ open, defaultContact, diagnostics, onClose, onSubmit }: FeedbackDialogProps) {
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
    const nextErrors = validateFeedback(title, description)
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
              <h2 id="feedback-title">Ajuda e feedback</h2>
              <p>Descreva o problema ou sugestao. Se o Supabase falhar, abriremos um e-mail preenchido.</p>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar feedback">
            <X size={17} />
          </button>
        </header>

        <form className="feedback-form" onSubmit={submit} noValidate>
          <div className="feedback-field-group">
            <div className="feedback-field">
              <label className="feedback-label" htmlFor="feedback-category">Tipo</label>
              <select
                id="feedback-category"
                value={category}
                onChange={event => setCategory(event.target.value as FeedbackCategory)}
              >
                <option value="bug">Bug</option>
                <option value="feedback">Feedback</option>
                <option value="question">Duvida</option>
              </select>
              <p className="feedback-description">Ajuda a direcionar o envio para o fluxo correto.</p>
            </div>

            <div className="feedback-field" data-invalid={Boolean(errors.title)}>
              <label className="feedback-label" htmlFor="feedback-title-input">Titulo</label>
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
                placeholder="Ex.: Login nao valida a sessao do CLI"
              />
              {errors.title ? (
                <p id="feedback-title-error" className="feedback-error">{errors.title}</p>
              ) : (
                <p id="feedback-title-help" className="feedback-description">Use uma frase curta para identificar o problema.</p>
              )}
            </div>

            <div className="feedback-field" data-invalid={Boolean(errors.description)}>
              <label className="feedback-label" htmlFor="feedback-description-input">Descricao</label>
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
                placeholder="O que aconteceu, o que voce esperava e como reproduzir."
              />
              {errors.description ? (
                <p id="feedback-description-error" className="feedback-error">{errors.description}</p>
              ) : (
                <p id="feedback-description-help" className="feedback-description">Inclua passos para reproduzir, resultado atual e resultado esperado.</p>
              )}
            </div>

            <div className="feedback-field">
              <label className="feedback-label" htmlFor="feedback-contact-input">Contato para retorno</label>
              <input
                id="feedback-contact-input"
                value={contact}
                onChange={event => setContact(event.target.value)}
                maxLength={160}
                placeholder="E-mail, X ou telefone"
              />
              <p className="feedback-description">Opcional, usado apenas se precisarmos pedir mais detalhes.</p>
            </div>

            <label className="feedback-check">
              <input
                type="checkbox"
                checked={includeDiagnostics}
                onChange={event => setIncludeDiagnostics(event.target.checked)}
              />
              <span>
                <strong>Incluir diagnosticos do app</strong>
                <small>Inclui versao, plataforma e estado tecnico; nao envia transcript completo.</small>
              </span>
            </label>
          </div>

          {result && (
            <div className={`feedback-result ${result.channel}`}>
              {result.channel === 'supabase' ? <CheckCircle2 size={17} /> : <Mail size={17} />}
              <span>{result.message}</span>
            </div>
          )}

          {result?.error && (
            <div className="feedback-result warning">
              <AlertTriangle size={17} />
              <span>{result.error}</span>
            </div>
          )}

          <footer className="modal-actions">
            <button type="button" onClick={onClose}>Cancelar</button>
            <button className="danger-button" type="submit" disabled={submitting}>
              <Send size={16} />
              {submitting ? 'Enviando' : 'Enviar'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

function validateFeedback(title: string, description: string): FeedbackErrors {
  const errors: FeedbackErrors = {}

  if (title.trim().length < 3) {
    errors.title = 'Informe um titulo com pelo menos 3 caracteres.'
  }

  if (description.trim().length < 12) {
    errors.description = 'Descreva o problema ou sugestao com pelo menos 12 caracteres.'
  }

  return errors
}
