import { Check, Hand, Lock, ShieldAlert, TerminalSquare } from 'lucide-react'
import { useRef, useState } from 'react'
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
  fullAccessEnabled: boolean
  onChange: (mode: AccessMode) => void
  onRequestFullAccessSettings: () => void
}

export function AccessSelector({ value, fullAccessEnabled, onChange, onRequestFullAccessSettings }: AccessSelectorProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const current = options.find(option => option.id === value)!
  useOutsideDismiss(wrapRef, open, () => setOpen(false))

  function choose(option: AccessOption) {
    if (option.id === 'full' && !fullAccessEnabled) {
      setOpen(false)
      onRequestFullAccessSettings()
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
            const isFullLocked = option.id === 'full' && !fullAccessEnabled
            return (
              <button
                key={option.id}
                className={`access-option ${isFullLocked ? 'access-option--locked' : ''}`}
                data-mode={option.id}
                type="button"
                onClick={() => choose(option)}
              >
                {isFullLocked ? <Lock size={22} className="access-option__lock" /> : <Icon size={22} />}
                <span>
                  <strong>{option.title}</strong>
                  <small>{isFullLocked ? 'Ative em Configuracoes > Permissoes para liberar este modo.' : option.description}</small>
                </span>
                {value === option.id && !isFullLocked && <Check size={20} />}
              </button>
            )
          })}
        </div>
      )}

    </div>
  )
}
