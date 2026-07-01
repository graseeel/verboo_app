import { Check, ChevronDown, Cpu, RefreshCw } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ModelDiscoveryResult, VerbooModel } from '../../../shared/types'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'

type ModelSelectorProps = {
  models: VerbooModel[]
  selectedModel?: string
  modelResult: ModelDiscoveryResult
  onSelect: (modelId: string) => void
  onRefresh: () => void
}

export function ModelSelector({ models, selectedModel, modelResult, onSelect, onRefresh }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const selected = models.find(model => model.id === selectedModel)
  const grouped = useMemo(() => groupModels(models), [models])
  const selectedTone = selected ? modelToneStyle(selected.id) : undefined
  const statusMessage = modelStatusMessage(modelResult)
  useOutsideDismiss(wrapRef, open, () => setOpen(false))

  return (
    <div className="selector-wrap" ref={wrapRef}>
      <button className="composer-pill model-pill" style={selectedTone} type="button" onClick={() => setOpen(value => !value)}>
        <Cpu size={14} />
        {selected && <i className="model-color-dot" aria-hidden="true" />}
        <span>{selected ? readableModelName(selected) : 'Model'}</span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="model-menu popover-panel t-dropdown is-open" data-origin="bottom-right">
          <div className="popover-title">
            <span>Modelo</span>
            <button className="icon-button tiny" type="button" onClick={onRefresh} title="Atualizar">
              <RefreshCw size={13} />
            </button>
          </div>

          {statusMessage && (
            <div className={`model-menu-status ${modelResult.stale && models.length > 0 ? 'subtle' : ''}`}>
              <span>{statusMessage}</span>
              {modelResult.stale && models.length > 0 && <small>Usando modelos salvos localmente.</small>}
            </div>
          )}

          {models.length === 0 ? (
            <div className="empty-menu">Nenhum modelo carregado. Entre com Verboo ou adicione uma chave API nas configuracoes.</div>
          ) : (
            grouped.map(group => (
              <div key={group.label} className="model-group">
                <div className="group-label">{group.label}</div>
                {group.models.map(model => (
                  <button
                    key={model.id}
                    className={`model-option ${model.id === selectedModel ? 'selected' : ''}`}
                    style={modelToneStyle(model.id)}
                    type="button"
                    onClick={() => {
                      onSelect(model.id)
                      setOpen(false)
                    }}
                  >
                    <span>
                      <strong>{readableModelName(model)}</strong>
                      <small>{model.id}{model.contextWindow ? ` · ${formatTokens(model.contextWindow)} ctx` : ''}</small>
                    </span>
                    {model.id === selectedModel && <Check size={15} />}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
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

function groupModels(models: VerbooModel[]): Array<{ label: string; models: VerbooModel[] }> {
  const longContext = models.filter(model => (model.contextWindow ?? 0) >= 1_000_000)
  const regular = models.filter(model => !longContext.includes(model))
  return [
    { label: 'Disponiveis', models: regular },
    ...(longContext.length > 0 ? [{ label: 'Long context', models: longContext }] : []),
  ].filter(group => group.models.length > 0)
}

function formatTokens(tokens: number): string {
  return Intl.NumberFormat('en-US', { notation: 'compact' }).format(tokens)
}

function readableModelName(model: VerbooModel): string {
  const raw = model.displayName || model.id
  const preset = raw.match(/^(.*?)\s*\(@preset\/([^)]+)\)\s*$/)
  if (preset) {
    const prefix = preset[1].trim()
    const modelName = humanizeModelId(preset[2])
    return prefix ? `${prefix} · ${modelName}` : modelName
  }
  return raw.replace(/@preset\//g, '').replace(/\s+/g, ' ').trim()
}

function humanizeModelId(modelId: string): string {
  return modelId
    .replace(/^@preset\//, '')
    .replace(/glm4[-_]?7/i, 'GLM 4.7')
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => (/^[a-z]+$/i.test(part) ? part[0].toUpperCase() + part.slice(1) : part.toUpperCase()))
    .join(' ')
    .replace(/\bV(\d+)\b/g, 'v$1')
}

function modelStatusMessage(result: ModelDiscoveryResult): string | undefined {
  if (result.stale && result.models.length > 0) return 'Modelos salvos localmente.'
  if (!result.error) return result.stale ? 'Modelos em cache.' : undefined
  if (/401|expired token|invalid.*token/i.test(result.error)) {
    return 'Sessao Verboo expirada. Entre novamente ou salve uma chave API valida.'
  }
  if (/network|fetch|timeout|tempo limite/i.test(result.error)) {
    return 'Nao foi possivel atualizar os modelos agora.'
  }
  return 'Nao foi possivel atualizar os modelos.'
}
