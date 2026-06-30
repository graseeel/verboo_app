import { Check, Hand, ShieldAlert, TerminalSquare } from 'lucide-react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AccessMode } from '../../../shared/types'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'

type AccessOption = {
  id: AccessMode
  title: string
  description: string
  icon: typeof Hand
}

const options: AccessOption[] = [
  {
    id: 'approval',
    title: 'Solicitar aprovacao',
    description: 'Sempre pedir aprovacao para editar arquivos externos e usar a internet',
    icon: Hand,
  },
  {
    id: 'auto',
    title: 'Aprovar por mim',
    description: 'Solicitar aprovacao apenas para acoes detectadas como potencialmente inseguras',
    icon: TerminalSquare,
  },
  {
    id: 'full',
    title: 'Acesso completo',
    description: 'Acesso irrestrito a internet e a qualquer arquivo no seu computador',
    icon: ShieldAlert,
  },
]

type AccessSelectorProps = {
  value: AccessMode
  onChange: (mode: AccessMode) => void
}

export function AccessSelector({ value, onChange }: AccessSelectorProps) {
  const [open, setOpen] = useState(false)
  const [confirmingFull, setConfirmingFull] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const current = options.find(option => option.id === value)!
  useOutsideDismiss(wrapRef, open, () => setOpen(false))

  function choose(option: AccessOption) {
    if (option.id === 'full') {
      setConfirmingFull(true)
      setOpen(false)
      return
    }
    onChange(option.id)
    setOpen(false)
  }

  return (
    <div className="selector-wrap" ref={wrapRef}>
      <button className={`composer-pill access-pill ${value === 'full' ? 'danger' : ''}`} type="button" onClick={() => setOpen(value => !value)}>
        <current.icon size={14} />
        {current.title}
      </button>

      {open && (
        <div className="access-menu popover-panel t-dropdown is-open" data-origin="bottom-left">
          <div className="access-heading">
            <span>Como as acoes do Verboo devem ser aprovadas?</span>
            <a href="https://code.verboo.ai/pt" target="_blank" rel="noreferrer">Saiba mais</a>
          </div>

          {options.map(option => {
            const Icon = option.icon
            return (
              <button key={option.id} className="access-option" data-mode={option.id} type="button" onClick={() => choose(option)}>
                <Icon size={22} />
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
                {value === option.id && <Check size={20} />}
              </button>
            )
          })}
        </div>
      )}

      {confirmingFull && createPortal(
        <div className="modal-backdrop">
          <div className="confirm-modal t-modal is-open" role="dialog" aria-modal="true">
            <h2>Ativar Acesso completo</h2>
            <p>
              O Verboo Code podera ler, criar, modificar e apagar arquivos em qualquer pasta acessivel pelo seu usuario,
              executar comandos no shell, acessar a internet, iniciar ferramentas locais, usar servidores MCP/plugins/skills
              e enviar conteudo necessario para provedores de IA configurados.
            </p>
            <p className="danger-copy">
              Isso pode expor codigo, documentos, segredos, tokens e chaves de API. Ative apenas em workspaces e ferramentas que voce confia.
            </p>
            <label>
              Digite <strong>ACESSO COMPLETO</strong> para continuar.
              <input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoFocus />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  setConfirmingFull(false)
                  setConfirmation('')
                }}
              >
                Cancelar
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={confirmation !== 'ACESSO COMPLETO'}
                onClick={() => {
                  onChange('full')
                  setConfirmingFull(false)
                  setOpen(false)
                  setConfirmation('')
                }}
              >
                Ativar Acesso completo
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
