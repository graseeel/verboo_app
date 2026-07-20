import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

// @lobehub/icons transitively imports @lobehub/fluent-emoji, whose ESM is
// not resolvable in jsdom. Mock ModelIcon before importing ModelSelector.
vi.mock('./ModelIcon', () => ({ ModelIcon: () => null }))

import type { ModelDiscoveryResult, VerbooModel } from '../../../shared/types'
import { ModelSelector } from './ModelSelector'

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

/** Open the effort drill-in panel from the root menu. */
function openEffortPanel() {
  openMenu()
  // Click the "Esforço" row (labelled with the effort row label).
  const effortRow = screen.getByText(/Esforço|Effort/i).closest('button')!
  fireEvent.click(effortRow)
}

beforeEach(() => {
  cleanup()
})

describe('ModelSelector — Codex rows + effort drill-in', () => {
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
