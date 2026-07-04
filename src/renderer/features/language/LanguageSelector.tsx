import { Check, ChevronDown, Languages } from 'lucide-react'
import { useRef, useState } from 'react'
import type { LanguageCode } from '../../../shared/types'
import { languageOptions, useI18n } from '../../i18n'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'

type LanguageSelectorProps = {
  value: LanguageCode
  onChange: (language: LanguageCode) => void
  compact?: boolean
}

// Custom select (shadcn Select pattern): app-styled trigger + popover with a
// check on the active option, replacing the OS-native <select> popover.
export function LanguageSelector({ value, onChange, compact = false }: LanguageSelectorProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useOutsideDismiss(rootRef, open, () => setOpen(false))

  const current = languageOptions.find(option => option.value === value) ?? languageOptions[0]

  return (
    <div ref={rootRef} className={`language-selector ${compact ? 'compact' : ''}`}>
      <button
        type="button"
        className="language-selector-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('language.label')}
        onClick={() => setOpen(current => !current)}
      >
        <Languages size={14} aria-hidden="true" />
        <span>{compact ? current.shortLabel : current.label}</span>
        <ChevronDown size={13} className={`language-selector-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="language-menu popover-panel t-dropdown is-open" role="listbox" aria-label={t('language.label')}>
          {languageOptions.map(option => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`language-option ${option.value === value ? 'selected' : ''}`}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              <span className="language-option-check" aria-hidden="true">
                {option.value === value && <Check size={13} />}
              </span>
              <span className="language-option-label">{option.label}</span>
              <span className="language-option-short">{option.shortLabel}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
