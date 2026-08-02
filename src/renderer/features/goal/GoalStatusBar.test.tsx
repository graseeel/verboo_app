/**
 * GoalStatusBar — quieter redesign pins (user request: badge too loud).
 *
 * The terminal-state badge (completed/stopped) lost its tinted green/red
 * BOX; the state signal moved to the icon color, driven by the data-kind
 * attribute. Declared limit: jsdom cannot evaluate stylesheets, so the
 * quiet surface is pinned via the styling hooks (data-kind + icon class)
 * that ARE the documented CSS contract in goal.css — plus what the user
 * sees: the label text and the action buttons.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../../i18n'
import { GoalStatusBar, type GoalStatusBarState } from './GoalStatusBar'

afterEach(cleanup)

function renderBar(status: GoalStatusBarState, language: 'en-US' | 'pt-BR' = 'en-US') {
  return render(
    <I18nProvider language={language}>
      <GoalStatusBar
        status={status}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onClear={vi.fn()}
      />
    </I18nProvider>,
  )
}

describe('GoalStatusBar — quieter redesign', () => {
  it('completed: label reaches the DOM and the state signal is the data-kind hook, not a green box element', () => {
    const { container } = renderBar({ kind: 'completed', objective: 'Create /tmp/test.txt' })
    expect(screen.getByText('Goal complete: Create /tmp/test.txt')).toBeTruthy()
    const bar = container.querySelector('.goal-status-bar')
    expect(bar?.getAttribute('data-kind')).toBe('completed')
    // The icon that carries the state color is present…
    expect(container.querySelector('.goal-status-bar__objective-icon')).toBeTruthy()
    // …and there is NO extra badge/chip element inside — one line only.
    expect(container.querySelectorAll('.goal-status-bar__body > *')).toHaveLength(2)
  })

  it('stopped: shows the translated reason and resume/clear actions by name', () => {
    renderBar({ kind: 'stopped', objective: 'obj', reason: 'userPaused' }, 'pt-BR')
    // statusLabel = "Objetivo parado: <translated userPaused reason>"
    expect(screen.getByText(/^Objetivo parado: /)).toBeTruthy()
    expect(screen.getByTitle('Retomar')).toBeTruthy()
    expect(screen.getByTitle('Limpar objetivo')).toBeTruthy()
  })

  it('active states render NOTHING — the quiet panel owns them (no duplicate UI)', () => {
    // G-C10 mutual exclusion, pinned: the bar must not double-render
    // what GoalActivePanel already shows (the "two confirmations pollute"
    // veto the user made explicit).
    for (const status of [
      { kind: 'idle' },
      { kind: 'active', objective: 'o', turn: 1 },
      { kind: 'evaluating', objective: 'o', turn: 1 },
      { kind: 'continuing', objective: 'o', turn: 1 },
    ] as GoalStatusBarState[]) {
      const { container, unmount } = renderBar(status)
      expect(container.querySelector('.goal-status-bar')).toBeNull()
      unmount()
    }
  })
})
