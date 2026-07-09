import { Check, ChevronDown, Eye, RefreshCw, Search } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { ModelDiscoveryResult, VerbooModel } from '../../../shared/types'
import { formatCompactNumber, useI18n } from '../../i18n'
import { ModelIcon } from './ModelIcon'

const SEARCH_THRESHOLD = 6

type ModelSelectorProps = {
  models: VerbooModel[]
  selectedModel?: string
  hasConversationHistory?: boolean
  modelResult: ModelDiscoveryResult
  onSelect: (modelId: string) => void
  onRefresh: () => void
}

export function ModelSelector({ models, selectedModel, hasConversationHistory = false, modelResult, onSelect, onRefresh }: ModelSelectorProps) {
  const { language, t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [menuPos, setMenuPos] = useState<{ bottom: number; right: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const pillRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const selected = models.find(model => model.id === selectedModel)
  const showSearch = models.length > SEARCH_THRESHOLD
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return models
    return models.filter(model =>
      model.id.toLowerCase().includes(normalized)
      || readableModelName(model).toLowerCase().includes(normalized),
    )
  }, [models, query])
  const grouped = useMemo(() => groupModels(filtered, t), [filtered, t])
  const flat = useMemo(() => grouped.flatMap(group => group.models), [grouped])
  const activeIndex = flat.length ? Math.min(highlighted, flat.length - 1) : 0
  const selectedTone = selected ? modelToneStyle(selected.id) : undefined
  const statusMessage = modelStatusMessage(modelResult, t)
  // Portal sits outside wrapRef — treat pill + menu as the dismiss boundary.
  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (wrapRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlighted(Math.max(0, flat.findIndex(model => model.id === selectedModel)))
    searchRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Portal to document.body so `.composer { overflow: hidden }` cannot clip the
  // upward menu into a micro-pill. Anchor ABOVE the pill (CSS `bottom` + `right`).
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
        right: Math.max(8, window.innerWidth - rect.right),
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

  function choose(model: VerbooModel) {
    onSelect(model.id)
    setOpen(false)
  }

  function handleSearchKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { setOpen(false); return }
    if (!flat.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted(index => (index + 1) % flat.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted(index => (index - 1 + flat.length) % flat.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(flat[activeIndex])
    }
  }

  return (
    <div className="selector-wrap" ref={wrapRef}>
      <button ref={pillRef} className="composer-pill model-pill" style={selectedTone} type="button" onClick={() => setOpen(value => !value)}>
        <span className="model-pill-icon" aria-hidden="true">
          {selected ? <ModelIcon modelId={selected.id} displayName={selected.displayName} size={15} /> : <ModelIcon modelId="" size={15} />}
        </span>
        <span>{selected ? readableModelName(selected) : t('model.label')}</span>
        <ChevronDown size={14} />
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="model-menu popover-panel t-dropdown is-open model-menu-portal"
          data-origin="bottom-right"
          style={{
            position: 'fixed',
            bottom: `${menuPos.bottom}px`,
            right: `${menuPos.right}px`,
            top: 'auto',
            left: 'auto',
          }}
        >
          <div className="popover-title">
            <span>{t('model.label')}</span>
            <button className="icon-button tiny" type="button" onClick={onRefresh} title={t('model.refresh')}>
              <RefreshCw size={13} />
            </button>
          </div>

          {showSearch && (
            <div className="model-search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                placeholder={t('model.searchPlaceholder')}
                onChange={event => { setQuery(event.target.value); setHighlighted(0) }}
                onKeyDown={handleSearchKeyDown}
              />
            </div>
          )}

          {statusMessage && (
            <div className={`model-menu-status ${modelResult.stale && models.length > 0 ? 'subtle' : ''}`}>
              <span>{statusMessage}</span>
              {modelResult.stale && models.length > 0 && <small>{t('model.usingSaved')}</small>}
            </div>
          )}

          {hasConversationHistory && (
            <div className="model-menu-hint">
              {t('model.switchWarning')}
            </div>
          )}

          {flat.length === 0 ? (
            <div className="empty-menu">{t('model.empty')}</div>
          ) : (
            grouped.map(group => (
              <div key={group.label} className="model-group">
                <div className="group-label">{group.label}</div>
                {group.models.map(model => {
                  const index = flat.indexOf(model)
                  return (
                    <button
                      key={model.id}
                      className={`model-option ${model.id === selectedModel ? 'selected' : ''} ${index === activeIndex ? 'highlighted' : ''}`}
                      style={modelToneStyle(model.id)}
                      type="button"
                      onMouseEnter={() => setHighlighted(index)}
                      onClick={() => choose(model)}
                    >
                      <span className="model-option-icon" aria-hidden="true">
                        <ModelIcon modelId={model.id} displayName={model.displayName} size={18} />
                      </span>
                      <span className="model-option-text">
                        <strong>{readableModelName(model)}</strong>
                        <small>{model.id}</small>
                      </span>
                      <span className="model-option-meta">
                        {model.supportsVision && (
                          <span className="model-badge" title={t('model.visionBadge')}>
                            <Eye size={11} />
                          </span>
                        )}
                        {model.contextWindow && (
                          <span className="model-badge">
                            {formatCompactNumber(model.contextWindow, language)}
                          </span>
                        )}
                        {model.id === selectedModel && <Check size={15} className="model-option-check" />}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

function modelToneStyle(modelId: string): CSSProperties {
  const hues = [266, 194, 146, 318, 28, 218]
  const hue = hues[hashString(modelId) % hues.length]
  return {
    '--model-color': `hsl(${hue} 92% 68%)`,
    '--model-bg': `hsl(${hue} 88% 60% / 0.14)`,
    '--model-border': `hsl(${hue} 88% 65% / 0.42)`,
  } as CSSProperties
}

function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash
}

function groupModels(models: VerbooModel[], t: (key: string) => string): Array<{ label: string; models: VerbooModel[] }> {
  const longContext = models.filter(model => (model.contextWindow ?? 0) >= 1_000_000)
  const regular = models.filter(model => !longContext.includes(model))
  return [
    { label: t('model.group.available'), models: regular },
    ...(longContext.length > 0 ? [{ label: t('model.group.longContext'), models: longContext }] : []),
  ].filter(group => group.models.length > 0)
}

function readableModelName(model: VerbooModel): string {
  const raw = model.displayName || model.id
  const preset = raw.match(/^(.*?)\s*\(@preset\/([^)]+)\)\s*$/)
  if (preset) {
    const prefix = preset[1].trim()
    const modelName = humanizeModelId(preset[2])
    return prefix ? `${prefix} · ${modelName}` : modelName
  }
  // If displayName is missing or equal to id, humanize the id so the
  // dropdown shows "Ultra (glm-5.2)" instead of just "glm-5.2".
  if (!model.displayName || model.displayName === model.id) {
    return humanizeModelId(model.id)
  }
  return raw.replace(/@preset\//g, '').replace(/\s+/g, ' ').trim()
}

function humanizeModelId(modelId: string): string {
  // Map known model id prefixes to friendly brand names. Mirrors the
  // Electron renderer's expectation that the dropdown shows "Ultra" for
  // glm-5.2, etc. Falls through to the generic humanizer for unknown ids.
  const lower = modelId.toLowerCase()
  const brandMap: Array<[RegExp, string]> = [
    [/^glm[-_]?5[-_.]?2$/i, 'Ultra'],
    [/^glm[-_]?4[-_.]?7$/i, 'GLM 4.7'],
    [/^glm4[-_]?7$/i, 'GLM 4.7'],
    [/^glm[-_]?4$/i, 'GLM 4'],
    [/^gpt[-_]?5$/i, 'GPT-5'],
    [/^gpt[-_]?4o$/i, 'GPT-4o'],
    [/^claude[-_]?opus[-_]?4[-_.]?6$/i, 'Claude Opus 4.6'],
    [/^claude[-_]?sonnet[-_]?4[-_.]?6$/i, 'Claude Sonnet 4.6'],
    [/^claude[-_]?haiku[-_]?4[-_.]?5$/i, 'Claude Haiku 4.5'],
    [/^claude[-_]?3[-_]?5[-_]?sonnet$/i, 'Claude 3.5 Sonnet'],
    [/^claude[-_]?3[-_]?opus$/i, 'Claude 3 Opus'],
    [/^claude[-_]?3[-_]?haiku$/i, 'Claude 3 Haiku'],
    [/^gemini[-_]?2[-_]?5[-_]?pro$/i, 'Gemini 2.5 Pro'],
    [/^gemini[-_]?2[-_]?5[-_]?flash$/i, 'Gemini 2.5 Flash'],
    [/^gemini[-_]?1[-_]?5[-_]?pro$/i, 'Gemini 1.5 Pro'],
    [/^o3$/i, 'o3'],
    [/^o4[-_]?mini$/i, 'o4-mini'],
  ]
  for (const [pattern, label] of brandMap) {
    if (pattern.test(lower)) return label
  }
  return modelId
    .replace(/^@preset\//, '')
    .replace(/glm4[-_]?7/i, 'GLM 4.7')
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => (/^[a-z]+$/i.test(part) ? part[0].toUpperCase() + part.slice(1) : part.toUpperCase()))
    .join(' ')
    .replace(/\bV(\d+)\b/g, 'v$1')
}

function modelStatusMessage(result: ModelDiscoveryResult, t: (key: string) => string): string | undefined {
  if (result.stale && result.models.length > 0) return t('model.savedLocal')
  if (!result.error) return result.stale ? t('model.cache') : undefined
  if (/401|expired token|invalid.*token/i.test(result.error)) {
    return t('model.expired')
  }
  if (/network|fetch|timeout|tempo limite/i.test(result.error)) {
    return t('model.networkError')
  }
  return t('model.genericError')
}
