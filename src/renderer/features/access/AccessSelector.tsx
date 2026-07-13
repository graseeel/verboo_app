import { Check, Hand, Lock, ShieldAlert, TerminalSquare } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  const [menuPos, setMenuPos] = useState<{ bottom: number; left: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const pillRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
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
  // Portal sits outside wrapRef — treat pill + menu as the dismiss boundary.
  useOutsideDismiss(wrapRef, open, () => setOpen(false), [menuRef])

  // Portal to document.body so `.composer { overflow: hidden }` cannot clip the
  // upward menu. Anchor ABOVE the pill (CSS `bottom` + `left`), mirroring
  // ModelSelector but anchored to the left edge since access sits on the
  // left side of the composer toolbar.
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null)
      return
    }
    const pill = pillRef.current
    if (!pill) return
    const compute = () => {
      const rect = pill.getBoundingClientRect()
      setMenuPos({
        bottom: window.innerHeight - rect.top + 10,
        left: Math.max(8, rect.left),
      })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [open])

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
      <button ref={pillRef} className={`composer-pill access-pill ${value === 'full' ? 'danger' : ''}`} type="button" onClick={() => setOpen(value => !value)}>
        <current.icon size={14} />
        {current.title}
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="access-menu popover-panel t-dropdown is-open access-menu-portal"
          data-origin="bottom-left"
          style={{
            position: 'fixed',
            bottom: `${menuPos.bottom}px`,
            left: `${menuPos.left}px`,
            top: 'auto',
            right: 'auto',
          }}
        >
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
        </div>,
        document.body,
      )}

    </div>
  )
}
