import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'

// @lobehub/icons transitively imports @lobehub/fluent-emoji, whose ESM is
// not resolvable in jsdom. Mock ModelIcon before importing ModelSelector.
vi.mock('./ModelIcon', () => ({ ModelIcon: () => null }))

import type { ModelDiscoveryResult, VerbooModel } from '../../../shared/types'
import { ModelSelector } from './ModelSelector'

/** Footer queries must be scoped — pill text "Ultra · Max" would otherwise
 *  collide with the level button "Max". */
function footer() {
  const label = screen.getByText(/Nível de raciocínio|Reasoning effort/i)
  return within(label.closest('.model-menu-effort-footer')!)
}

/**
 * Regression tests for the Option B refactor of ModelSelector.
 *
 * The footer is the single source of truth for reasoning effort:
 * - Renders only when the selected model exposes `effortLevels`.
 * - Shows "Usar padrão" + every dynamic level (no hardcoded list).
 * - "Usar padrão" clears the override; a level click persists it.
 * - Stale overrides (not in current effortLevels) fall back to default.
 * - No per-row arrow or submenu anywhere.
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

beforeEach(() => {
  cleanup()
})

describe('ModelSelector — effort footer (Option B)', () => {
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

  it('does NOT render the footer when selected model has no reasoning capability', () => {
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
    expect(screen.queryByText(/Nível de raciocínio|Reasoning effort/i)).toBeNull()
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
    const f = footer()
    // Every dynamic level rendered in the footer
    expect(f.getByText(/Nenhum|None/i)).toBeTruthy()
    expect(f.getByText(/Baixo|Low/i)).toBeTruthy()
    expect(f.getByText(/Médio|Medium/i)).toBeTruthy()
    expect(f.getByText(/Alto|High/i)).toBeTruthy()
    // No phantom Máximo/Max — qwen3 does not offer it
    expect(f.queryByText(/Máximo|Max/i)).toBeNull()
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
    const f = footer()
    const useDefault = f.getByText(/Usar padrão|Use default/i).closest('button')!
    expect(useDefault).toHaveClass('selected')
    // High is NOT marked selected — it coincides with default but isn't an override.
    const highBtn = f.getByText(/Alto|High/i).closest('button')!
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
    const f = footer()
    const useDefault = f.getByText(/Usar padrão|Use default/i).closest('button')!
    expect(useDefault).not.toHaveClass('selected')
    const maxBtn = f.getByText(/Máximo|Max/i).closest('button')!
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
    const f = footer()
    const useDefault = f.getByText(/Usar padrão|Use default/i).closest('button')!
    expect(useDefault).toHaveClass('selected')
    // No "Máximo" rendered at all because it's not in the dynamic levels.
    expect(f.queryByText(/Máximo|Max/i)).toBeNull()
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
    expect(footer().getByText(/Nenhum|None/i)).toBeTruthy()
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
    fireEvent.click(footer().getByText(/Máximo|Max/i))
    expect(onSelectEffort).toHaveBeenCalledWith('glm-5.2', 'max')
    // Menu closed (footer unmounted)
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
    fireEvent.click(footer().getByText(/Usar padrão|Use default/i))
    expect(onClearEffortOverride).toHaveBeenCalledWith('glm-5.2')
  })

  it('does not render any per-row effort arrow or submenu chevron', () => {
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
  })

  it('footer is keyboard-reachable: each level is a focusable button', () => {
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
    const footerButtons = screen.getAllByRole('button').filter(btn =>
      btn.classList.contains('model-effort-option'),
    )
    expect(footerButtons.length).toBe(4)
    for (const btn of footerButtons) {
      expect(btn.tagName).toBe('BUTTON')
      // TabIndex default (0) — focusable via Tab.
      expect(btn).not.toHaveAttribute('tabindex', '-1')
    }
  })
})
