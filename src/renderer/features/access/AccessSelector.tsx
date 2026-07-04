import { Check, Hand, Lock, ShieldAlert, TerminalSquare } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { AccessMode } from '../../../shared/types'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { useI18n } from '../../i18n'

type AccessOption = {
  id: AccessMode
  title: string
  description: string
  icon: typeof Hand
}

type AccessSelectorProps = {
  value: AccessMode
  fullAccessEnabled: boolean
  onChange: (mode: AccessMode) => void
  onRequestFullAccessSettings: () => void
}

export function AccessSelector({ value, fullAccessEnabled, onChange, onRequestFullAccessSettings }: AccessSelectorProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const options = useMemo<AccessOption[]>(() => [
    {
      id: 'approval',
      title: t('access.approval.title'),
      description: t('access.approval.description'),
      icon: Hand,
    },
    {
      id: 'auto',
      title: t('access.auto.title'),
      description: t('access.auto.description'),
      icon: TerminalSquare,
    },
    {
      id: 'full',
      title: t('access.full.title'),
      description: t('access.full.description'),
      icon: ShieldAlert,
    },
  ], [t])
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
            <span>{t('access.heading')}</span>
            <a href="https://code.verboo.ai/pt" target="_blank" rel="noreferrer">{t('access.learnMore')}</a>
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
                  <small>{isFullLocked ? t('access.fullLocked') : option.description}</small>
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
