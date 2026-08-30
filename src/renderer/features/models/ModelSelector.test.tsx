import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

// @lobehub/icons transitively imports @lobehub/fluent-emoji, whose ESM is
// not resolvable in jsdom. Mock ModelIcon before importing ModelSelector.
vi.mock('./ModelIcon', () => ({ ModelIcon: () => null }))

import type { ModelDiscoveryResult, VerbooModel } from '../../../shared/types'
import { ModelSelector } from './ModelSelector'
import { dedupModels } from './providerCatalog'

/** Regression coverage for the single-surface model selector. Model choices
 * render immediately; reasoning stays in a conditional dynamic footer. */

const baseModel: VerbooModel = {
  id: 'glm-5.2',
  displayName: 'Ultra',
  contextWindow: 200000,
  supportsVision: false,
  raw: {},
}

const modelWithoutReasoning: VerbooModel = {
  id: 'kimi-k2',
  displayName: 'Kimi K2',
  contextWindow: 128000,
  supportsVision: false,
  raw: {},
}

const modelWithReasoning: VerbooModel = {
  ...baseModel,
  reasoning: {
    effortLevels: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
}

const modelOfferingNone: VerbooModel = {
  ...baseModel,
  id: 'qwen3',
  displayName: 'Qwen3',
  reasoning: {
    effortLevels: ['none', 'low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
}

const discoveryOk: ModelDiscoveryResult = {
  models: [modelWithReasoning, modelWithoutReasoning, modelOfferingNone],
  source: 'cli',
  stale: false,
}

function Pill() {
  return screen.getByRole('button', { name: /Ultra|Kimi|Qwen3|Model/i })
}

function openMenu() {
  fireEvent.click(Pill())
}

beforeEach(() => {
  cleanup()
})

describe('ModelSelector — single popover: the chip opens the model list DIRECTLY', () => {
  /* User requirement: today the chip opens an intermediate dialog
   * (continuity warning + a "Modelo >" row) that demands a SECOND click
   * to reach the real selector. The chip must open the model list in ONE
   * popover: provider-grouped, current model highlighted, the continuity
   * warning demoted to a discreet line at the top of the selector itself.
   * Selecting applies and closes. */
  function renderSelector(overrides: Partial<Parameters<typeof ModelSelector>[0]> = {}) {
    return render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="glm-5.2"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        {...overrides}
      />,
    )
  }

  it('ONE click on the chip shows the model options — no intermediate "Modelo >" row in the way', () => {
    renderSelector()
    openMenu()
    expect(document.querySelectorAll('.model-option').length).toBe(discoveryOk.models.length)
    expect(document.querySelector('.model-rows .model-row')).toBeNull()
  })

  it('the continuity warning is a quiet footer note in the same selector', () => {
    renderSelector({ hasConversationHistory: true })
    openMenu()
    const hint = document.querySelector('.model-menu-hint')
    expect(hint).toBeTruthy()
    expect(hint!.textContent).toMatch(/continuity|continuidade/i)
    // It rides the same panel as the options, never instead of them.
    const menu = document.querySelector('.model-menu')!
    expect(menu.contains(hint)).toBe(true)
    expect(menu.querySelector('.model-option')).toBeTruthy()
    // It comes after the list so it does not interrupt model selection.
    const first = menu.querySelector('.model-option')!
    expect(first.compareDocumentPosition(hint!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('without conversation history there is no warning line (nothing to warn about)', () => {
    renderSelector({ hasConversationHistory: false })
    openMenu()
    expect(document.querySelector('.model-menu-hint')).toBeNull()
  })

  it('the CURRENT model renders highlighted with its check in the list', () => {
    renderSelector({ selectedModel: 'kimi-k2' })
    openMenu()
    const selected = document.querySelector('.model-option.selected')!
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    expect(selected.textContent).toContain('Kimi K2')
    expect(selected.querySelector('.model-option-check')).toBeTruthy()
  })

  it('selecting a model applies onSelect AND closes the popover', () => {
    const onSelect = vi.fn()
    renderSelector({ onSelect })
    openMenu()
    fireEvent.click(document.querySelector<HTMLButtonElement>('.model-option')!)
    expect(onSelect).toHaveBeenCalledWith('glm-5.2')
    expect(document.querySelector('.model-menu')).toBeNull()
  })

  it('keeps the search threshold at more than 12 visible models', () => {
    const twelveModels = Array.from({ length: 12 }, (_, index): VerbooModel => ({
      id: `model-${index}`,
      displayName: `Model ${index}`,
      raw: {},
    }))
    renderSelector({
      models: twelveModels,
      selectedModel: 'model-0',
      modelResult: { models: twelveModels, source: 'cli', stale: false },
    })
    openMenu()
    expect(document.querySelector('.model-search')).toBeNull()

    cleanup()

    const thirteenModels = [...twelveModels, {
      id: 'model-12',
      displayName: 'Model 12',
      raw: {},
    }]
    renderSelector({
      models: thirteenModels,
      selectedModel: 'model-0',
      modelResult: { models: thirteenModels, source: 'cli', stale: false },
    })
    openMenu()
    expect(document.querySelector('.model-search')).toBeTruthy()
  })

  it('uses ArrowDown and Enter in search to select the highlighted model', () => {
    const models = Array.from({ length: 13 }, (_, index): VerbooModel => ({
      id: `model-${index}`,
      displayName: `Model ${index}`,
      raw: {},
    }))
    const onSelect = vi.fn()
    renderSelector({
      models,
      selectedModel: 'model-0',
      modelResult: { models, source: 'cli', stale: false },
      onSelect,
    })
    openMenu()

    const search = screen.getByPlaceholderText(/Search models|Buscar modelos/i)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('model-1')
    expect(document.querySelector('.model-menu')).toBeNull()
  })

  it('refreshes through the existing accessible header action', () => {
    const onRefresh = vi.fn()
    renderSelector({ onRefresh })
    openMenu()

    fireEvent.click(screen.getByRole('button', { name: /Refresh|Atualizar/i }))

    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('keeps the last known selected label through a transient empty catalog snapshot', () => {
    const { rerender } = renderSelector()
    expect(Pill()).toHaveTextContent('Ultra')

    rerender(
      <ModelSelector
        models={[]}
        selectedModel="glm-5.2"
        modelResult={{ models: [], source: 'none', stale: false }}
        onSelect={() => {}}
        onRefresh={() => {}}
      />,
    )

    expect(Pill()).toHaveTextContent('Ultra')
  })

  it('renders model choices and reasoning in one surface with no drill-in navigation', () => {
    renderSelector({
      effortByModel: {},
      selectedEffortLevels: ['low', 'high', 'max'],
      selectedEffort: 'high',
    })
    openMenu()

    expect(document.querySelector('.model-rows')).toBeNull()
    expect(document.querySelector('.model-back-button')).toBeNull()
    expect(document.querySelector('.model-effort-list')).toBeNull()
    expect(screen.getByText(/Usar padrão|Use default/i)).toBeTruthy()
  })
})

describe('ModelSelector — compact list with reasoning footer', () => {
  it('warns when provider refresh fails while keeping Verboo models selectable', () => {
    const onSelect = vi.fn()
    const providerFailure = {
      ...discoveryOk,
      models: [baseModel],
      providerError: 'O CLI não retornou modelos de provedor.',
    }

    render(
      <ModelSelector
        models={providerFailure.models}
        selectedModel="glm-5.2"
        modelResult={providerFailure}
        onSelect={onSelect}
        onRefresh={() => {}}
      />,
    )

    openMenu()
    expect(screen.getByText(
      /Provider models couldn't be refreshed|Não foi possível atualizar os modelos dos provedores/,
    )).toBeVisible()

    // Single popover: the Verboo models stay selectable right there.
    fireEvent.click(document.querySelector<HTMLButtonElement>('.model-option')!)

    expect(onSelect).toHaveBeenCalledWith('glm-5.2')
  })

  it('renders pill label "Model · effort" using effective effort', () => {
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="glm-5.2"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{}}
        selectedEffortLevels={['low', 'high', 'max']}
        selectedEffort="high"
      />,
    )
    // Pill text: humanized "Ultra" + " · " + label for `high`.
    expect(Pill()).toHaveTextContent(/Ultra.*·.*Alto|Máximo|High|Max/)
  })

  it('does NOT render a reasoning footer when selected model has no reasoning capability', () => {
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="kimi-k2"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{}}
        selectedEffortLevels={[]}
        selectedEffort={undefined}
      />,
    )
    openMenu()
    expect(document.querySelector('.model-reasoning-footer')).toBeNull()
    expect(screen.queryByText(/Usar padrão|Use default/i)).toBeNull()
  })

  it('renders dynamic levels returned by the model (no hardcoded list)', () => {
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="qwen3"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{}}
        selectedEffortLevels={['none', 'low', 'medium', 'high']}
        selectedEffort="medium"
      />,
    )
    openMenu()
    expect(document.querySelector('.model-reasoning-label')).toHaveTextContent(
      /Reasoning effort|Nível de raciocínio/i,
    )
    // Every dynamic level rendered in the reasoning footer (scoped to effort
    // buttons to avoid collision with the pill text "Qwen3 · Médio").
    const effortButtons = screen.getAllByRole('button').filter(btn =>
      btn.classList.contains('model-reasoning-option'),
    )
    const labels = effortButtons.map(btn => btn.textContent ?? '')
    expect(labels.some(l => /Nenhum|None/i.test(l))).toBe(true)
    expect(labels.some(l => /Baixo|Low/i.test(l))).toBe(true)
    expect(labels.some(l => /Médio|Medium/i.test(l))).toBe(true)
    expect(labels.some(l => /Alto|High/i.test(l))).toBe(true)
    expect(labels.some(l => /Máximo|Max/i.test(l))).toBe(false)
  })

  it('keeps future reasoning levels through the label fallback', () => {
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="glm-5.2"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{}}
        selectedEffortLevels={['low', 'ultra']}
        selectedEffort="low"
      />,
    )
    openMenu()

    const footer = document.querySelector('.model-reasoning-footer')!
    const ultra = Array.from(footer.querySelectorAll('button'))
      .find(button => button.textContent === 'Ultra')
    expect(ultra).toHaveClass('model-reasoning-option')
    expect(screen.queryByRole('button', { name: /Medium|Médio/i })).toBeNull()
  })

  it('highlights "Usar padrão" when no override is saved (default in effect)', () => {
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="glm-5.2"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{}}
        selectedEffortLevels={['low', 'high', 'max']}
        selectedEffort="high"
      />,
    )
    openMenu()
    const useDefault = screen.getByText(/Usar padrão|Use default/i).closest('button')!
    expect(useDefault).toHaveClass('selected')
    // High is NOT marked selected — it coincides with default but isn't an override.
    const highBtn = screen.getByText(/^Alto$|^High$/i).closest('button')!
    expect(highBtn).not.toHaveClass('selected')
  })

  it('highlights the saved level when a valid override exists', () => {
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="glm-5.2"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{ 'glm-5.2': 'max' }}
        selectedEffortLevels={['low', 'high', 'max']}
        selectedEffort="max"
      />,
    )
    openMenu()
    const useDefault = screen.getByText(/Usar padrão|Use default/i).closest('button')!
    expect(useDefault).not.toHaveClass('selected')
    // Scope to effort buttons — the pill also shows "Ultra · Máximo".
    const effortButtons = screen.getAllByRole('button').filter(btn =>
      btn.classList.contains('model-reasoning-option'),
    )
    const maxBtn = effortButtons.find(btn => /Máximo|Max/i.test(btn.textContent ?? ''))!
    expect(maxBtn).toHaveClass('selected')
  })

  it('falls back to "Usar padrão" when the saved override is no longer in effortLevels', () => {
    // Model used to offer "max" but now only offers low/high — the stale
    // override must NOT be honored as selected.
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="glm-5.2"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{ 'glm-5.2': 'max' }}
        selectedEffortLevels={['low', 'high']}
        selectedEffort="high"
      />,
    )
    openMenu()
    const useDefault = screen.getByText(/Usar padrão|Use default/i).closest('button')!
    expect(useDefault).toHaveClass('selected')
    expect(screen.queryByText(/Máximo|Max/i)).toBeNull()
  })

  it('handles "none" tier when the router advertises it', () => {
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="qwen3"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{}}
        selectedEffortLevels={['none', 'low', 'medium', 'high']}
        selectedEffort="medium"
      />,
    )
    openMenu()
    expect(screen.getByText(/Nenhum|None/i)).toBeTruthy()
  })

  it('calls onSelectEffort when a level is clicked and closes the menu', () => {
    const onSelectEffort = vi.fn()
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="glm-5.2"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{}}
        selectedEffortLevels={['low', 'high', 'max']}
        selectedEffort="high"
        onSelectEffort={onSelectEffort}
      />,
    )
    openMenu()
    fireEvent.click(screen.getByText(/Máximo|Max/i))
    expect(onSelectEffort).toHaveBeenCalledWith('glm-5.2', 'max')
    expect(screen.queryByText(/Usar padrão|Use default/i)).toBeNull()
  })

  it('calls onClearEffortOverride when "Usar padrão" is clicked', () => {
    const onClearEffortOverride = vi.fn()
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="glm-5.2"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{ 'glm-5.2': 'max' }}
        selectedEffortLevels={['low', 'high', 'max']}
        selectedEffort="max"
        onClearEffortOverride={onClearEffortOverride}
      />,
    )
    openMenu()
    fireEvent.click(screen.getByText(/Usar padrão|Use default/i))
    expect(onClearEffortOverride).toHaveBeenCalledWith('glm-5.2')
    expect(document.querySelector('.model-menu')).toBeNull()
  })

  it('keeps compact rows while showing context and vision metadata', () => {
    const visionModel: VerbooModel = {
      ...modelWithReasoning,
      supportsVision: true,
    }
    render(
      <ModelSelector
        models={[visionModel]}
        selectedModel="glm-5.2"
        modelResult={{ ...discoveryOk, models: [visionModel] }}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{}}
        selectedEffortLevels={['low', 'high', 'max']}
        selectedEffort="high"
      />,
    )
    openMenu()

    const option = screen.getByRole('button', { name: 'Ultra' })
    expect(option.querySelector('small')).toBeNull()
    expect(option.querySelector('.model-badge')).toHaveTextContent('200K')
    expect(option.querySelector('.model-badge')).toHaveAttribute('title', 'Context window: 200,000')
    expect(option.querySelector('.model-badge-vision')).toHaveAttribute('title', 'Supports images')
    expect(document.querySelector('.model-option-effort-arrow')).toBeNull()
    expect(document.querySelector('.model-effort-submenu')).toBeNull()
    expect(document.querySelector('.model-option-wrap')).toBeNull()
  })

  it('does not infer vision from unpromoted raw metadata in the renderer', () => {
    const rawVisionModel: VerbooModel = {
      ...modelWithoutReasoning,
      supportsVision: undefined,
      raw: { vision: true },
    }
    render(
      <ModelSelector
        models={[rawVisionModel]}
        selectedModel="kimi-k2"
        modelResult={{ ...discoveryOk, models: [rawVisionModel] }}
        onSelect={() => {}}
        onRefresh={() => {}}
      />,
    )
    openMenu()

    const option = document.querySelector<HTMLButtonElement>('.model-option[aria-label="Kimi K2"]')!
    expect(option.querySelector('.model-badge')).toHaveTextContent('128K')
    expect(option.querySelector('.model-badge-vision')).toBeNull()
  })

  it('does not invent vision support for an external CLI-only model', () => {
    const cliOnlyModel: VerbooModel = {
      ...modelWithoutReasoning,
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6-Sol',
      provider: 'codex',
      supportsVision: undefined,
      raw: { provider: 'codex' },
    }
    render(
      <ModelSelector
        models={[cliOnlyModel]}
        selectedModel={cliOnlyModel.id}
        modelResult={{ ...discoveryOk, models: [cliOnlyModel] }}
        providerStatuses={[{ provider: 'codex', connected: true }]}
        onSelect={() => {}}
        onRefresh={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'GPT-5.6-Sol' }))

    const option = document.querySelector<HTMLButtonElement>('.model-option[aria-label="GPT-5.6-Sol"]')!
    expect(option.querySelector('.model-badge')).toHaveTextContent('128K')
    expect(option.querySelector('.model-badge-vision')).toBeNull()
  })

  it('reasoning footer buttons are keyboard-reachable native buttons', () => {
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="glm-5.2"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{}}
        selectedEffortLevels={['low', 'high', 'max']}
        selectedEffort="high"
      />,
    )
    openMenu()
    // "Usar padrão" + 3 levels = 4 effort buttons total.
    const effortButtons = screen.getAllByRole('button').filter(btn =>
      btn.classList.contains('model-reasoning-option'),
    )
    expect(effortButtons.length).toBe(4)
    for (const btn of effortButtons) {
      expect(btn.tagName).toBe('BUTTON')
      expect(btn).not.toHaveAttribute('tabindex', '-1')
    }
  })

  it('Escape closes the single selector from the reasoning footer', () => {
    render(
      <ModelSelector
        models={discoveryOk.models}
        selectedModel="glm-5.2"
        modelResult={discoveryOk}
        onSelect={() => {}}
        onRefresh={() => {}}
        effortByModel={{}}
        selectedEffortLevels={['low', 'high', 'max']}
        selectedEffort="high"
      />,
    )
    openMenu()
    expect(screen.getByText(/Usar padrão|Use default/i)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.model-menu')).toBeNull()
  })
})

describe('ModelSelector — provider grouping (F3)', () => {
  // Real F2 contract shapes: `provider` absent = verboo; 'claude'/'codex' seen
  // in the wild; an unknown id must still appear on its own (no hardcoding).
  const verbooUltra: VerbooModel = {
    id: 'glm-5.2',
    displayName: 'Ultra',
    contextWindow: 200000,
    supportsVision: false,
    raw: {},
  }
  const verbooLong: VerbooModel = {
    id: 'glm-4.7',
    displayName: 'GLM 4.7',
    contextWindow: 1_000_000,
    supportsVision: false,
    raw: {},
  }
  const claudeSonnet: VerbooModel = {
    id: 'claude-sonnet-4.6',
    displayName: 'Claude Sonnet 4.6',
    contextWindow: 200000,
    supportsVision: false,
    raw: {},
    provider: 'claude',
  }
  const codexGpt: VerbooModel = {
    id: 'gpt-5',
    displayName: 'GPT-5',
    contextWindow: 400000,
    supportsVision: false,
    raw: {},
    provider: 'codex',
  }
  const acmeModel: VerbooModel = {
    id: 'acme-1',
    displayName: 'Acme One',
    contextWindow: 64000,
    supportsVision: false,
    raw: {},
    provider: 'acme',
  }

  function discovery(models: VerbooModel[]): ModelDiscoveryResult {
    return { models, source: 'cli', stale: false }
  }

  /** The chip opens DIRECTLY on the models panel (single popover) — one
   *  click on the pill is the whole navigation. The menu is a portal to
   *  document.body, so queries go to `document`, not the render
   *  container. */
  function openModelsPanel() {
    fireEvent.click(document.querySelector('.model-pill')!)
  }

  function groupLabels(): string[] {
    return Array.from(document.querySelectorAll('.group-label')).map(el => el.textContent ?? '')
  }

  it('groups by provider when external providers are present — verboo first, account label, colored dots', () => {
    const models = [verbooUltra, claudeSonnet, codexGpt]
    render(
      <ModelSelector
        models={models}
        selectedModel="glm-5.2"
        modelResult={discovery(models)}
        onSelect={() => {}}
        onRefresh={() => {}}
        providerStatuses={[
          { provider: 'claude', connected: true },
          { provider: 'codex', connected: true },
        ]}
      />,
    )
    openModelsPanel()
    const labels = groupLabels()
    expect(labels.length).toBe(3)
    expect(labels[0]).toMatch(/^Verboo/)
    expect(labels.some(label => /Claude — (your account|sua conta)/.test(label))).toBe(true)
    expect(labels.some(label => /Codex — (your account|sua conta)/.test(label))).toBe(true)
    // Brand icons for the external providers; the verboo group keeps today's
    // colored dot (its identity is unchanged).
    expect(document.querySelectorAll('.group-label .group-dot').length).toBe(1)
    expect(document.querySelector('.group-label [data-testid="provider-icon-claude"]')).toBeTruthy()
    expect(document.querySelector('.group-label [data-testid="provider-icon-codex"]')).toBeTruthy()
    // The provider IS the grouping axis — today's Available/Long-context
    // labels must not appear in provider mode.
    expect(labels.some(label => /Available|Disponíveis|Long context|Contexto longo/i.test(label))).toBe(false)
    expect(screen.getByRole('button', { name: 'Claude Sonnet 4.6' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'GPT-5' })).toBeTruthy()
  })

  it('shows the Verboo plan in the verboo group label when provided', () => {
    const models = [verbooUltra, claudeSonnet]
    render(
      <ModelSelector
        models={models}
        selectedModel="glm-5.2"
        modelResult={discovery(models)}
        onSelect={() => {}}
        onRefresh={() => {}}
        verbooPlan="Pro"
        providerStatuses={[{ provider: 'claude', connected: true }]}
      />,
    )
    openModelsPanel()
    expect(groupLabels()[0]).toMatch(/Verboo — (plan Pro|plano Pro)/)
  })

  it('gives an unknown provider a generic title-case label so it appears on its own', () => {
    const models = [verbooUltra, acmeModel]
    render(
      <ModelSelector
        models={models}
        selectedModel="acme-1"
        modelResult={discovery(models)}
        onSelect={() => {}}
        onRefresh={() => {}}
        providerStatuses={[{ provider: 'acme', connected: true }]}
      />,
    )
    openModelsPanel()
    expect(groupLabels().some(label => /Acme — (your account|sua conta)/.test(label))).toBe(true)
    expect(document.querySelector('.model-option[aria-label="Acme One"]')).toBeTruthy()
    const icon = document.querySelector('.group-label [data-testid="provider-icon-acme"]')!
    expect(icon.querySelector('svg')).toBeNull()
    expect(icon.querySelector('.provider-icon-fallback')!.textContent).toBe('A')
  })

  it('verboo-only list keeps today\'s exact groups — Available/Long context, no dots, no provider labels', () => {
    const models = [verbooUltra, verbooLong]
    render(
      <ModelSelector
        models={models}
        selectedModel="glm-5.2"
        modelResult={discovery(models)}
        onSelect={() => {}}
        onRefresh={() => {}}
      />,
    )
    openModelsPanel()
    const labels = groupLabels()
    expect(labels).toEqual(['Available', 'Long context'])
    expect(document.querySelectorAll('.group-dot').length).toBe(0)
    expect(document.querySelectorAll('[data-testid^="provider-icon-"]').length).toBe(0)
    expect(labels.some(label => /your account|sua conta|plano|plan/i.test(label))).toBe(false)
  })

  it('hides a disconnected external provider even when its models remain in the discovered catalog', () => {
    const models = [verbooUltra, codexGpt]
    render(
      <ModelSelector
        models={models}
        selectedModel="glm-5.2"
        modelResult={discovery(models)}
        onSelect={() => {}}
        onRefresh={() => {}}
        providerStatuses={[{ provider: 'codex', connected: false }]}
      />,
    )
    openModelsPanel()

    expect(screen.queryByText('GPT-5')).toBeNull()
    expect(groupLabels().some(label => /Codex/i.test(label))).toBe(false)
    expect(document.querySelector('.group-connect')).toBeNull()
  })

  it('shows external models only when the matching provider is connected', () => {
    const models = [verbooUltra, claudeSonnet, codexGpt]
    render(
      <ModelSelector
        models={models}
        selectedModel="glm-5.2"
        modelResult={discovery(models)}
        onSelect={() => {}}
        onRefresh={() => {}}
        providerStatuses={[
          { provider: 'claude', connected: true, account: 'user@example.com' },
          { provider: 'codex', connected: false },
        ]}
      />,
    )
    openModelsPanel()

    expect(screen.getByText('Claude Sonnet 4.6')).toBeTruthy()
    expect(screen.queryByText('GPT-5')).toBeNull()
    expect(groupLabels().some(label => /Claude — (your account|sua conta)/.test(label))).toBe(true)
    expect(groupLabels().some(label => /Codex/i.test(label))).toBe(false)
  })

  it('treats a missing provider status as disconnected for external catalog entries', () => {
    const models = [verbooUltra, claudeSonnet]
    render(
      <ModelSelector
        models={models}
        selectedModel="glm-5.2"
        modelResult={discovery(models)}
        onSelect={() => {}}
        onRefresh={() => {}}
      />,
    )
    openModelsPanel()

    expect(screen.queryByText('Claude Sonnet 4.6')).toBeNull()
    expect(groupLabels()).toEqual(['Available'])
  })
})

describe('T14: dedupModels — uma entrada por id no seletor', () => {
  // T14 field defect: the Rust merge (model_service.rs:190
  // `models.extend(provider_models)`) produces duplicates when the router
  // cache and the CLI listing both contain the same model. The two entries
  // differ by field — router owns capabilities/context; CLI owns provider
  // attachment and can backfill reasoning when the router omits it.

  it('uma entrada por id quando router e CLI both tem o mesmo id', () => {
    const routerEntry: VerbooModel = {
      id: 'ultra/glm-5.2',
      displayName: 'Ultra (glm-5.2)',
      contextWindow: 200000,
      maxOutputTokens: 16384,
      supportsVision: false,
      visionSupportSource: 'router',
      raw: { id: 'ultra/glm-5.2', source: 'router' },
    }
    const cliEntry: VerbooModel = {
      id: 'ultra/glm-5.2',
      displayName: 'Ultra (glm-5.2)',
      contextWindow: 999999,
      supportsVision: true,
      visionSupportSource: 'raw-capabilities',
      provider: 'verboo',
      reasoning: { effortLevels: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      raw: { provider: 'verboo', id: 'ultra/glm-5.2', source: 'cli' },
    }
    const deduped = dedupModels([routerEntry, cliEntry])
    expect(deduped).toHaveLength(1)
    const merged = deduped[0]
    // CLI supplies provider/reasoning; Router remains capability authority.
    expect(merged.provider).toBe('verboo')
    expect(merged.supportsVision).toBe(false)
    expect(merged.visionSupportSource).toBe('router')
    expect(merged.contextWindow).toBe(200000)
    expect(merged.raw).toEqual({ id: 'ultra/glm-5.2', source: 'router' })
    expect(merged.reasoning).toEqual({ effortLevels: ['low', 'medium', 'high'], defaultEffort: 'medium' })
    // Router wins: maxOutputTokens (CLI lacks it)
    expect(merged.maxOutputTokens).toBe(16384)
  })

  it('preserva maxOutputTokens do router quando CLI nao tem', () => {
    const routerEntry: VerbooModel = {
      id: 'm1',
      displayName: 'M1',
      maxOutputTokens: 8192,
      supportsVision: false,
      raw: {},
    }
    const cliEntry: VerbooModel = {
      id: 'm1',
      displayName: 'M1',
      supportsVision: true,
      provider: 'verboo',
      raw: {},
    }
    const deduped = dedupModels([routerEntry, cliEntry])
    expect(deduped).toHaveLength(1)
    expect(deduped[0].maxOutputTokens).toBe(8192)
    expect(deduped[0].supportsVision).toBe(false)
    expect(deduped[0].provider).toBe('verboo')
  })

  it('nao duplica quando so uma fonte tem o id', () => {
    const models: VerbooModel[] = [
      { id: 'a', displayName: 'A', raw: {} },
      { id: 'b', displayName: 'B', raw: {} },
      { id: 'c', displayName: 'C', raw: {} },
    ]
    const deduped = dedupModels(models)
    expect(deduped).toHaveLength(3)
    expect(deduped.map(m => m.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('H.6: deixa rastro (console.warn) quando funde duplicatas', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const router: VerbooModel = { id: 'ultra/glm-5.2', displayName: 'Ultra', maxOutputTokens: 16384, raw: {} }
    const cli: VerbooModel = { id: 'ultra/glm-5.2', displayName: 'Ultra', provider: 'verboo', supportsVision: true, raw: {} }
    dedupModels([router, cli])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = warnSpy.mock.calls[0][0] as string
    expect(msg).toContain('ultra/glm-5.2')
    expect(msg).toContain('fused 2')
    warnSpy.mockRestore()
  })

  it('H.6: silencio quando nao ha duplicatas (rastro so quando funde)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dedupModels([
      { id: 'a', displayName: 'A', raw: {} },
      { id: 'b', displayName: 'B', raw: {} },
    ])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('T14 seletor: renderiza UMA entrada por id mesmo com duplicatas na entrada', () => {
    const routerEntry: VerbooModel = {
      id: 'ultra/glm-5.2',
      displayName: 'Ultra (glm-5.2)',
      contextWindow: 200000,
      maxOutputTokens: 16384,
      supportsVision: false,
      raw: {},
    }
    const cliEntry: VerbooModel = {
      id: 'ultra/glm-5.2',
      displayName: 'Ultra (glm-5.2)',
      contextWindow: 999999,
      supportsVision: true,
      provider: 'verboo',
      raw: {},
    }
    const models = dedupModels([routerEntry, cliEntry])
    const discovery: ModelDiscoveryResult = {
      models,
      source: 'cache',
      stale: false,
    }
    render(
      <ModelSelector
        models={models}
        selectedModel="ultra/glm-5.2"
        modelResult={discovery}
        onSelect={() => {}}
        onRefresh={() => {}}
      />,
    )
    fireEvent.click(document.querySelector('.model-pill')!)
    const modelRows = [...document.querySelectorAll('.model-option')]
      .filter(button => button.getAttribute('aria-label') === 'Ultra (glm-5.2)')
    expect(modelRows).toHaveLength(1)
    expect(modelRows[0].querySelector('.model-badge')).toHaveTextContent('200K')
    expect(modelRows[0].querySelector('.model-badge-vision')).toBeNull()
  })
})
