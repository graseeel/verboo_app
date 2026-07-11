import { useEffect, useState } from 'react'
import type { CustomSlashCommand } from '../../../shared/types'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/Toast'
import {
  generateCustomCommandId,
  isReservedCommandName,
  isValidCustomCommandName,
} from '../composer/customSlashCommands'

type Editing = { kind: 'new' } | { kind: 'edit'; index: number } | null

type CustomCommandsManagerProps = {
  commands: CustomSlashCommand[]
  onSave: (next: CustomSlashCommand[]) => void
}

function emptyDraft(): { name: string; description: string; body: string } {
  return { name: '', description: '', body: '' }
}

function draftFrom(command: CustomSlashCommand): { name: string; description: string; body: string } {
  return {
    name: command.name,
    description: command.description,
    body: command.body,
  }
}

export function CustomCommandsManager({ commands, onSave }: CustomCommandsManagerProps) {
  const { t } = useI18n()
  const { toast } = useToast()
  const [editing, setEditing] = useState<Editing>(null)
  const [draft, setDraft] = useState(emptyDraft())
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)

  // Clear the form whenever we leave edit mode.
  useEffect(() => {
    if (editing === null) {
      setDraft(emptyDraft())
      setError(null)
    }
  }, [editing])

  function startNew() {
    setDraft(emptyDraft())
    setError(null)
    setEditing({ kind: 'new' })
  }

  function startEdit(index: number) {
    if (index < 0 || index >= commands.length) return
    setDraft(draftFrom(commands[index]))
    setError(null)
    setEditing({ kind: 'edit', index })
  }

  function cancel() {
    setEditing(null)
  }

  function validate(raw: { name: string; description: string; body: string }): string | null {
    const trimmedName = raw.name.trim()
    if (!isValidCustomCommandName(trimmedName)) {
      return t('settings.customCommandsErrorName')
    }
    if (isReservedCommandName(trimmedName)) {
      return t('settings.customCommandsErrorReserved')
    }
    const lower = trimmedName.toLowerCase()
    const dupeIndex = commands.findIndex((c, i) => {
      if (c.name.toLowerCase() !== lower) return false
      if (editing && editing.kind === 'edit' && editing.index === i) return false
      return true
    })
    if (dupeIndex !== -1) {
      return t('settings.customCommandsErrorDuplicate')
    }
    return null
  }

  function save() {
    const trimmedName = draft.name.trim()
    const err = validate({ name: trimmedName, description: draft.description, body: draft.body })
    if (err) {
      setError(err)
      return
    }
    const next: CustomSlashCommand[] = commands.slice()
    const payload: CustomSlashCommand = {
      id: editing && editing.kind === 'edit' ? commands[editing.index].id : generateCustomCommandId(),
      name: trimmedName,
      description: draft.description,
      body: draft.body,
      createdAt: editing && editing.kind === 'edit' ? commands[editing.index].createdAt : Date.now(),
    }
    if (editing && editing.kind === 'edit') {
      next[editing.index] = payload
    } else {
      next.push(payload)
    }
    onSave(next)
    toast(t('settings.customCommandsSaved'))
    setEditing(null)
  }

  function confirmDelete() {
    if (pendingDelete === null) return
    const next = commands.filter((_, i) => i !== pendingDelete)
    onSave(next)
    toast(t('settings.customCommandsDeleted'))
    setPendingDelete(null)
    // If we were editing the deleted row, exit edit mode.
    if (editing && editing.kind === 'edit' && editing.index === pendingDelete) {
      setEditing(null)
    }
  }

  return (
    <section className="settings-panel custom-commands-panel">
      <ConfirmDialog
        request={
          pendingDelete !== null && commands[pendingDelete]
            ? {
                title: t('settings.customCommandsConfirmDeleteTitle'),
                description: t('settings.customCommandsConfirmDeleteBody', { name: commands[pendingDelete].name }),
                confirmLabel: t('settings.customCommandsConfirmDeleteCta'),
                danger: true,
                onConfirm: confirmDelete,
              }
            : undefined
        }
        onClose={() => setPendingDelete(null)}
      />

      {commands.length === 0 && editing === null && (
        <div className="custom-commands-empty">{t('settings.customCommandsEmpty')}</div>
      )}

      <ul className="custom-commands-list">
        {commands.map((command, index) => {
          const isEditing = editing !== null && editing.kind === 'edit' && editing.index === index
          if (isEditing) {
            return (
              <li key={command.id} className="custom-commands-list-item">
                <CustomCommandForm
                  draft={draft}
                  onChange={setDraft}
                  error={error}
                  onCancel={cancel}
                  onSubmit={save}
                  t={t}
                />
              </li>
            )
          }
          return (
            <li key={command.id} className="custom-commands-list-item">
              <article className="custom-commands-card">
                <header className="custom-commands-card-head">
                  <code className="custom-commands-name">/{command.name}</code>
                  <small className="custom-commands-description">
                    {command.description || <span aria-hidden="true">—</span>}
                  </small>
                </header>
                {command.body ? (
                  <pre className="custom-commands-body">{command.body}</pre>
                ) : (
                  <pre className="custom-commands-body is-empty">—</pre>
                )}
                <footer className="custom-commands-card-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => startEdit(index)}
                  >
                    <Pencil size={13} />
                    <span>{t('settings.customCommandsEdit')}</span>
                  </button>
                  <button
                    type="button"
                    className="danger-soft-button"
                    onClick={() => setPendingDelete(index)}
                  >
                    <Trash2 size={13} />
                    <span>{t('settings.customCommandsDelete')}</span>
                  </button>
                </footer>
              </article>
            </li>
          )
        })}

        {editing !== null && editing.kind === 'new' && (
          <li className="custom-commands-list-item">
            <CustomCommandForm
              draft={draft}
              onChange={setDraft}
              error={error}
              onCancel={cancel}
              onSubmit={save}
              t={t}
            />
          </li>
        )}
      </ul>

      {editing === null && (
        <button type="button" className="primary-soft-button" onClick={startNew}>
          <Plus size={14} />
          <span>{t('settings.customCommandsAdd')}</span>
        </button>
      )}
    </section>
  )
}

type CustomCommandFormProps = {
  draft: { name: string; description: string; body: string }
  onChange: (next: { name: string; description: string; body: string }) => void
  error: string | null
  onCancel: () => void
  onSubmit: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

function CustomCommandForm({ draft, onChange, error, onCancel, onSubmit, t }: CustomCommandFormProps) {
  return (
    <form
      className="custom-commands-form"
      onSubmit={event => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <label className="custom-commands-field">
        <span>{t('settings.customCommandsNameLabel')}</span>
        <input
          type="text"
          value={draft.name}
          onChange={event => onChange({ ...draft, name: event.target.value })}
          autoFocus
          spellCheck={false}
          className="custom-commands-input"
        />
        <small>{t('settings.customCommandsNameHint')}</small>
      </label>
      <label className="custom-commands-field">
        <span>{t('settings.customCommandsDescriptionLabel')}</span>
        <input
          type="text"
          value={draft.description}
          onChange={event => onChange({ ...draft, description: event.target.value })}
          spellCheck
          className="custom-commands-input"
        />
        <small>{t('settings.customCommandsDescriptionHint')}</small>
      </label>
      <label className="custom-commands-field">
        <span>{t('settings.customCommandsBodyLabel')}</span>
        <textarea
          value={draft.body}
          onChange={event => onChange({ ...draft, body: event.target.value })}
          rows={6}
          spellCheck
          className="custom-commands-input custom-commands-textarea"
        />
        <small>{t('settings.customCommandsBodyHint')}</small>
      </label>
      {error && (
        <p className="custom-commands-error" role="alert">{error}</p>
      )}
      <footer className="custom-commands-form-actions">
        <button type="button" className="ghost-button" onClick={onCancel}>
          <X size={13} />
          <span>{t('common.cancel')}</span>
        </button>
        <button type="submit" className="primary-soft-button">
          {t('common.save')}
        </button>
      </footer>
    </form>
  )
}
