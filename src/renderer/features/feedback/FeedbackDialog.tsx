import { AlertTriangle, Bug, CheckCircle2, Mail, Send, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { FeedbackCategory, FeedbackDiagnostics, FeedbackRequest, FeedbackResult } from '../../../shared/types'

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

  useEffect(() => {
    if (!open) return
    setCategory('bug')
    setTitle('')
    setDescription('')
    setContact(defaultContact ?? '')
    setIncludeDiagnostics(true)
    setResult(undefined)
  }, [defaultContact, open])

  if (!open) return null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!title.trim() || !description.trim() || submitting) return
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

        <form className="feedback-form" onSubmit={submit}>
          <label>
            Tipo
            <select value={category} onChange={event => setCategory(event.target.value as FeedbackCategory)}>
              <option value="bug">Bug</option>
              <option value="feedback">Feedback</option>
              <option value="question">Duvida</option>
            </select>
          </label>

          <label>
            Titulo
            <input
              value={title}
              onChange={event => setTitle(event.target.value)}
              maxLength={160}
              placeholder="Ex.: Login nao valida a sessao do CLI"
            />
          </label>

          <label>
            Descricao
            <textarea
              value={description}
              onChange={event => setDescription(event.target.value)}
              maxLength={8000}
              rows={6}
              placeholder="O que aconteceu, o que voce esperava e como reproduzir."
            />
          </label>

          <label>
            Contato para retorno
            <input
              value={contact}
              onChange={event => setContact(event.target.value)}
              maxLength={160}
              placeholder="E-mail, X ou telefone"
            />
          </label>

          <label className="feedback-check">
            <input
              type="checkbox"
              checked={includeDiagnostics}
              onChange={event => setIncludeDiagnostics(event.target.checked)}
            />
            Incluir diagnosticos do app, sem transcript completo
          </label>

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
            <button className="danger-button" type="submit" disabled={!title.trim() || !description.trim() || submitting}>
              <Send size={16} />
              {submitting ? 'Enviando' : 'Enviar'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}
