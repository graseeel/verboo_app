import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

// @lobehub/icons transitively imports @lobehub/fluent-emoji, whose ESM is
// not resolvable in jsdom. Mock ModelIcon before importing ModelSelector.
vi.mock('./ModelIcon', () => ({ ModelIcon: () => null }))

import type { ModelDiscoveryResult, VerbooModel } from '../../../shared/types'
import { ModelSelector } from './ModelSelector'
import { dedupModels } from './providerCatalog'

/**
 * Regression tests for the Codex-style ModelSelector refactor.
 *
 * Root menu shows rows (Model / Effort). Effort levels live behind a
 * drill-in panel (`.model-effort-list`), not an inline footer.
 *
 * Coverage preserved from the footer-era tests:
 * - Pill label "Model · effort" uses effective effort.
 * - Effort row only renders when selected model exposes effortLevels.
 * - Dynamic levels (no hardcoded list).
 * - "Usar padrão" selected when no override; level selected when override exists.
 * - Stale override falls back to "Usar padrão".
 * - "none" tier handled.
 * - onSelectEffort / onClearEffortOverride wired.
 * - No legacy per-row arrow/submenu classes.
 * - Effort buttons are focusable.
 */

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

/** Open the effort drill-in panel: the chip lands on the model list
 *  (single popover), the back button reveals the settings rows, and the
 *  "Esforço" row drills in. */
function openEffortPanel() {
  openMenu()
  fireEvent.click(document.querySelector<HTMLButtonElement>('.model-back-button')!)
  const effortRow = screen.getByText(/Esforço|Effort/i).closest('button')!
  fireEvent.click(effortRow)
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
    // The list itself is what greets the user…
    expect(document.querySelectorAll('.model-option').length).toBe(discoveryOk.models.length)
    // …not the drill-in rows of the old intermediate dialog.
    expect(document.querySelector('.model-rows .model-row')).toBeNull()
  })

  it('the continuity warning is a discreet line AT THE TOP of the selector, not a separate step', () => {
    renderSelector({ hasConversationHistory: true })
    openMenu()
    const hint = document.querySelector('.model-menu-hint')
    expect(hint).toBeTruthy()
    expect(hint!.textContent).toMatch(/continuity|continuidade/i)
    // It rides the SAME panel as the options (top), never instead of them.
    const menu = document.querySelector('.model-menu')!
    expect(menu.contains(hint)).toBe(true)
    expect(menu.querySelector('.model-option')).toBeTruthy()
    // And it comes BEFORE the first option (top line, not a footer).
    const first = menu.querySelector('.model-option')!
    expect(hint!.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
    expect(selected.textContent).toContain('kimi-k2')
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

  it('the effort drill-in stays reachable: back row → effort row → effort panel', () => {
    renderSelector({
      effortByModel: {},
      selectedEffortLevels: ['low', 'high', 'max'],
      selectedEffort: 'high',
    })
    openMenu()
    // From the list, the back affordance leads to the settings rows…
    fireEvent.click(document.querySelector<HTMLButtonElement>('.model-back-button')!)
    const effortRow = screen.getByText(/Esforço|Effort/i).closest('button')!
    fireEvent.click(effortRow)
    expect(screen.getByText(/Usar padrão|Use default/i)).toBeTruthy()
  })
})

describe('ModelSelector — Codex rows + effort drill-in', () => {
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

    // Single popover: the Verboo models stay selectable right there —
    // no intermediate row to drill through.
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

  it('does NOT render the effort row when selected model has no reasoning capability', () => {
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
    // Root menu shows the Model row but no Effort row.
    expect(screen.queryByText(/Esforço|Effort/i)).toBeNull()
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
    openEffortPanel()
    // Every dynamic level rendered in the effort list (scoped to effort
    // buttons to avoid collision with the pill text "Qwen3 · Médio").
    const effortButtons = screen.getAllByRole('button').filter(btn =>
      btn.classList.contains('model-effort-option'),
    )
    const labels = effortButtons.map(btn => btn.textContent ?? '')
    expect(labels.some(l => /Nenhum|None/i.test(l))).toBe(true)
    expect(labels.some(l => /Baixo|Low/i.test(l))).toBe(true)
    expect(labels.some(l => /Médio|Medium/i.test(l))).toBe(true)
    expect(labels.some(l => /Alto|High/i.test(l))).toBe(true)
    // No phantom Máximo/Max — qwen3 does not offer it.
    expect(labels.some(l => /Máximo|Max/i.test(l))).toBe(false)
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
    openEffortPanel()
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
    openEffortPanel()
    const useDefault = screen.getByText(/Usar padrão|Use default/i).closest('button')!
    expect(useDefault).not.toHaveClass('selected')
    // Scope to effort buttons — the pill also shows "Ultra · Máximo".
    const effortButtons = screen.getAllByRole('button').filter(btn =>
      btn.classList.contains('model-effort-option'),
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
    openEffortPanel()
    const useDefault = screen.getByText(/Usar padrão|Use default/i).closest('button')!
    expect(useDefault).toHaveClass('selected')
    // No "Máximo" rendered at all because it's not in the dynamic levels.
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
    openEffortPanel()
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
    openEffortPanel()
    fireEvent.click(screen.getByText(/Máximo|Max/i))
    expect(onSelectEffort).toHaveBeenCalledWith('glm-5.2', 'max')
    // Menu closed (effort list unmounted)
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
    openEffortPanel()
    fireEvent.click(screen.getByText(/Usar padrão|Use default/i))
    expect(onClearEffortOverride).toHaveBeenCalledWith('glm-5.2')
  })

  it('does not render any legacy per-row effort arrow or submenu classes', () => {
    const { container } = render(
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
    // The legacy arrow/submenu classes must not be present anywhere.
    expect(container.querySelector('.model-option-effort-arrow')).toBeNull()
    expect(container.querySelector('.model-effort-submenu')).toBeNull()
    expect(container.querySelector('.model-option-wrap')).toBeNull()
    // The old inline footer must not be present either.
    expect(container.querySelector('.model-menu-effort-footer')).toBeNull()
  })

  it('effort panel buttons are keyboard-reachable: each level is a focusable button', () => {
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
    openEffortPanel()
    // "Usar padrão" + 3 levels = 4 effort buttons total.
    const effortButtons = screen.getAllByRole('button').filter(btn =>
      btn.classList.contains('model-effort-option'),
    )
    expect(effortButtons.length).toBe(4)
    for (const btn of effortButtons) {
      expect(btn.tagName).toBe('BUTTON')
      // TabIndex default (0) — focusable via Tab.
      expect(btn).not.toHaveAttribute('tabindex', '-1')
    }
  })

  it('Escape from effort panel returns to root (does not close menu)', () => {
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
    openEffortPanel()
    // Effort list visible.
    expect(screen.getByText(/Usar padrão|Use default/i)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    // Back to root — effort list gone, Model row visible again (the row
    // label "Modelo" coexists with the popover title, so getAllByText).
    expect(screen.queryByText(/Usar padrão|Use default/i)).toBeNull()
    expect(screen.getAllByText(/Modelo|Model/i).length).toBeGreaterThan(0)
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
      />,
    )
    openModelsPanel()
    const labels = groupLabels()
    // One group per provider, verboo first.
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
    // Models still render with name + slug inside their provider group.
    expect(screen.getByText('Claude Sonnet 4.6')).toBeTruthy()
    expect(screen.getByText('claude-sonnet-4.6')).toBeTruthy()
    expect(screen.getByText('gpt-5')).toBeTruthy()
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
      />,
    )
    openModelsPanel()
    expect(groupLabels().some(label => /Acme — (your account|sua conta)/.test(label))).toBe(true)
    expect(screen.getByText('acme-1')).toBeTruthy()
    // Unknown provider: generic initial tile, no invented glyph.
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

  it('disconnected bridge entries render a DIMMED group whose Conectar action fires onConnectProvider', () => {
    const onConnectProvider = vi.fn()
    const models = [verbooUltra]
    render(
      <ModelSelector
        models={models}
        selectedModel="glm-5.2"
        modelResult={discovery(models)}
        onSelect={() => {}}
        onRefresh={() => {}}
        providerStatuses={[{ provider: 'codex', connected: false }]}
        onConnectProvider={onConnectProvider}
      />,
    )
    openModelsPanel()
    // Mockup: "Codex — não conectado · Conectar →" (en-US default context).
    const dimmed = document.querySelector('.group-label.is-dimmed')
    expect(dimmed).toBeTruthy()
    expect(dimmed!.textContent).toMatch(/Codex — (not connected|não conectado)/i)
    expect(dimmed!.textContent).toMatch(/Connect|Conectar/i)
    // The disconnected provider still carries its official brand icon.
    expect(dimmed!.querySelector('[data-testid="provider-icon-codex"]')).toBeTruthy()
    const connectButton = dimmed!.querySelector('button')!
    fireEvent.click(connectButton)
    expect(onConnectProvider).toHaveBeenCalledWith('codex')
  })

  it('connected bridge entries do NOT get a dimmed group — their models come from the listing', () => {
    const models = [verbooUltra, claudeSonnet]
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
        onConnectProvider={() => {}}
      />,
    )
    openModelsPanel()
    const dimmed = document.querySelectorAll('.group-label.is-dimmed')
    expect(dimmed.length).toBe(1)
    expect(dimmed[0].textContent).toMatch(/Codex/)
    // The connected provider renders as a normal provider group instead.
    expect(groupLabels().some(label => /Claude — (your account|sua conta)/.test(label))).toBe(true)
  })

  it('no providerStatuses prop → no dimmed groups at all (zero regression for old mounts)', () => {
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
    expect(document.querySelectorAll('.group-label.is-dimmed').length).toBe(0)
    expect(document.querySelectorAll('.group-connect').length).toBe(0)
  })
})

describe('T14: dedupModels — uma entrada por id no seletor', () => {
  // T14 field defect: the Rust merge (model_service.rs:190
  // `models.extend(provider_models)`) produces duplicates when the router
  // cache and the CLI listing both contain the same model. The two entries
  // differ by field — router has maxOutputTokens, CLI has provider/vision.
  // Dropping either loses information, so dedupModels merges per field.

  it('uma entrada por id quando router e CLI both tem o mesmo id', () => {
    const routerEntry: VerbooModel = {
      id: 'ultra/glm-5.2',
      displayName: 'Ultra (glm-5.2)',
      contextWindow: 200000,
      maxOutputTokens: 16384,
      supportsVision: false,
      visionSupportSource: 'router',
      raw: { id: 'ultra/glm-5.2' },
    }
    const cliEntry: VerbooModel = {
      id: 'ultra/glm-5.2',
      displayName: 'Ultra (glm-5.2)',
      contextWindow: 200000,
      supportsVision: true,
      visionSupportSource: 'raw-capabilities',
      provider: 'verboo',
      reasoning: { effortLevels: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      raw: { provider: 'verboo', id: 'ultra/glm-5.2' },
    }
    const deduped = dedupModels([routerEntry, cliEntry])
    expect(deduped).toHaveLength(1)
    const merged = deduped[0]
    // CLI wins: provider, vision, reasoning
    expect(merged.provider).toBe('verboo')
    expect(merged.supportsVision).toBe(true)
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
    expect(deduped[0].supportsVision).toBe(true)
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
    // Simulates the Rust merge output: router entry + CLI entry for the same id.
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
      contextWindow: 200000,
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
    // Pin ONE entry per id — the selector must not show duplicates.
    const modelRows = [...document.querySelectorAll('.model-option')]
      .filter(btn => btn.querySelector('small')?.textContent === 'ultra/glm-5.2')
    expect(modelRows).toHaveLength(1)
  })
})
