import { Check, ChevronDown, Eye, RefreshCw, Search } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { ModelDiscoveryResult, ProviderAuthStatus, VerbooModel } from '../../../shared/types'
import { formatCompactNumber, useI18n } from '../../i18n'
import { ModelIcon } from './ModelIcon'
import { ProviderIcon } from './ProviderIcon'
import { VERBOO_PROVIDER, groupModelsByProvider, hasExternalProvider, hashString, modelProvider } from './providerCatalog'

const SEARCH_THRESHOLD = 12

type ModelSelectorProps = {
  models: VerbooModel[]
  selectedModel?: string
  hasConversationHistory?: boolean
  modelResult: ModelDiscoveryResult
  onSelect: (modelId: string) => void
  onRefresh: () => void
  /** Verboo subscription label (e.g. "Pro") shown in the verboo group header
   *  when the selector renders provider groups (F3). Unused in the verboo-only
   *  selector, which stays byte-identical to today. */
  verbooPlan?: string
  /** Login bridge universe ({ provider, connected, account? }). External
   *  models render only when their matching provider is connected. */
  providerStatuses?: ProviderAuthStatus[]
  // Reasoning effort integration
  effortByModel?: Record<string, string>
  selectedEffortLevels?: string[]
  selectedEffort?: string
  onSelectEffort?: (modelId: string, effort: string) => void
  /** Remove the per-model override so it falls back to the model's defaultEffort. */
  onClearEffortOverride?: (modelId: string) => void
}

/** Map known effort level keys to display labels. Unknown → Title Case. */
function effortLabel(level: string, t: (key: string) => string): string {
  const known: Record<string, string> = {
    none: t('composer.effortNone'),
    low: t('composer.effortLow'),
    medium: t('composer.effortMedium'),
    high: t('composer.effortHigh'),
    max: t('composer.effortMax'),
  }
  return known[level] ?? level.charAt(0).toUpperCase() + level.slice(1)
}

export function ModelSelector({ models, selectedModel, hasConversationHistory = false, modelResult, onSelect, onRefresh, verbooPlan, providerStatuses, effortByModel, selectedEffortLevels = [], selectedEffort, onSelectEffort, onClearEffortOverride }: ModelSelectorProps) {
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
  // An explicit selection can be missing from a transient catalog snapshot:
  // provider models are attached per refresh and the attach degrades
  // silently (model_service.rs). Keep displaying the last known model — or
  // at least the raw id — instead of dropping to the generic label. The
  // popover listing itself stays catalog-truthful; only the pill/row do this.
  const lastKnownRef = useRef<VerbooModel | undefined>(undefined)
  useEffect(() => {
    if (selected) lastKnownRef.current = selected
  }, [selected])
  const displayed = selected ?? (selectedModel ? lastKnownRef.current : undefined)
  const connectedProviders = useMemo(
    () => new Set(
      (providerStatuses ?? [])
        .filter(status => status.connected)
        .map(status => status.provider),
    ),
    [providerStatuses],
  )
  const visibleModels = useMemo(
    () => models.filter(model => {
      const provider = modelProvider(model)
      return provider === VERBOO_PROVIDER || connectedProviders.has(provider)
    }),
    [models, connectedProviders],
  )
  const showSearch = visibleModels.length > SEARCH_THRESHOLD
  // Override is only "valid" when it's still in the model's current
  // effortLevels. A stale value (model changed its levels) falls back to
  // defaultEffort, surfaced as "Use default" selected in the reasoning footer.
  const hasEffortOverride = Boolean(
    selected
    && effortByModel?.[selected.id]
    && selectedEffortLevels.includes(effortByModel[selected.id]),
  )
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return visibleModels
    return visibleModels.filter(model =>
      model.id.toLowerCase().includes(normalized)
      || readableModelName(model).toLowerCase().includes(normalized),
    )
  }, [visibleModels, query])
  const providerMode = hasExternalProvider(filtered)
  const grouped = useMemo<Array<{ label: string; models: VerbooModel[]; dotStyle?: CSSProperties; providerId?: string }>>(
    // Provider mode (F3): one group per provider. Verboo-only: today's exact
    // Available/Long-context grouping — zero visual regression.
    () => providerMode ? groupModelsByProvider(filtered, t, verbooPlan) : groupModels(filtered, t),
    [providerMode, filtered, t, verbooPlan],
  )
  const flat = useMemo(() => grouped.flatMap(group => group.models), [grouped])
  const activeIndex = flat.length ? Math.min(highlighted, flat.length - 1) : 0
  const selectedTone = displayed ? modelToneStyle(displayed.id) : undefined
  const statusMessage = modelStatusMessage(modelResult, t)
  const providerStatusMessage = modelResult.providerError
    ? t('model.providerRefreshError')
    : undefined
  const showEffortRow = Boolean(selected && selectedEffortLevels.length > 0)
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
          {displayed ? <ModelIcon modelId={displayed.id} displayName={displayed.displayName} size={15} /> : <ModelIcon modelId="" size={15} />}
        </span>
        <span>
          {displayed ? readableModelName(displayed) : (selectedModel ?? t('model.label'))}
          {selected && selectedEffort ? <>{' · '}{effortLabel(selectedEffort, t)}</> : null}
        </span>
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
            <button
              className="icon-button tiny"
              type="button"
              onClick={onRefresh}
              title={t('model.refresh')}
              aria-label={t('model.refresh')}
            >
              <RefreshCw size={13} />
            </button>
          </div>

          <div className="model-menu-body">
            {statusMessage && (
              <div className={`model-menu-status ${modelResult.stale && models.length > 0 ? 'subtle' : ''}`}>
                <span>{statusMessage}</span>
                {modelResult.stale && models.length > 0 && <small>{t('model.usingSaved')}</small>}
              </div>
            )}

            {providerStatusMessage && (
              <div className="model-menu-status subtle" role="status">
                <span>{providerStatusMessage}</span>
              </div>
            )}

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

            {flat.length === 0 ? (
              <div className="empty-menu">{t('model.empty')}</div>
            ) : (
              grouped.map(group => (
                <div key={group.label} className="model-group">
                  <div className="group-label" style={group.dotStyle}>
                    {group.dotStyle && (group.providerId && group.providerId !== VERBOO_PROVIDER ? (
                      <ProviderIcon providerId={group.providerId} size={13} />
                    ) : (
                      <span className="group-dot" aria-hidden="true" />
                    ))}
                    {group.label}
                  </div>
                  {group.models.map(model => {
                    const index = flat.indexOf(model)
                    const modelName = readableModelName(model)
                    const isSelected = model.id === selectedModel
                    return (
                      <button
                        key={model.id}
                        className={`model-option ${isSelected ? 'selected' : ''} ${index === activeIndex ? 'highlighted' : ''}`}
                        type="button"
                        aria-label={modelName}
                        aria-pressed={isSelected}
                        onMouseEnter={() => setHighlighted(index)}
                        onClick={() => choose(model)}
                      >
                        <span className="model-option-icon" aria-hidden="true">
                          <ModelIcon modelId={model.id} displayName={model.displayName} size={18} />
                        </span>
                        <strong className="model-option-name">
                          <span className="model-option-name-text">{modelName}</span>
                          {model.supportsVision === true && (
                            <span className="model-badge-vision" title={t('model.visionBadge')}>
                              <Eye size={13} aria-hidden="true" />
                            </span>
                          )}
                        </strong>
                        <span className="model-option-meta" aria-hidden="true">
                          {typeof model.contextWindow === 'number' && model.contextWindow > 0 && (
                            <span
                              className="model-badge"
                              title={`${t('settings.contextWindow')}: ${model.contextWindow.toLocaleString(language)}`}
                            >
                              {formatCompactNumber(model.contextWindow, language)}
                            </span>
                          )}
                          {isSelected && <Check size={15} className="model-option-check" />}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>

          {showEffortRow && selected && (
            <div className="model-reasoning-footer">
              <span className="model-reasoning-label">{t('composer.effortTitle')}</span>
              <div className="model-reasoning-levels" role="group" aria-label={t('composer.effortTitle')}>
                <button
                  type="button"
                  className={`model-reasoning-option${hasEffortOverride ? '' : ' selected'}`}
                  aria-pressed={!hasEffortOverride}
                  onClick={() => {
                    onClearEffortOverride?.(selected.id)
                    setOpen(false)
                  }}
                >
                  {t('composer.effortUseDefault')}
                </button>
                {selectedEffortLevels.map(level => {
                  const isSelected = hasEffortOverride && effortByModel?.[selected.id] === level
                  return (
                    <button
                      key={level}
                      type="button"
                      className={`model-reasoning-option${isSelected ? ' selected' : ''}`}
                      aria-pressed={isSelected}
                      onClick={() => {
                        onSelectEffort?.(selected.id, level)
                        setOpen(false)
                      }}
                    >
                      {effortLabel(level, t)}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {hasConversationHistory && (
            <div className="model-menu-hint">
              {t('model.switchWarning')}
            </div>
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
    '--model-color': `hsl(${hue} 72% 66%)`,
    '--model-bg': `hsl(${hue} 60% 58% / 0.08)`,
    '--model-border': `hsl(${hue} 48% 60% / 0.22)`,
  } as CSSProperties
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
