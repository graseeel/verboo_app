import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { StepFlow } from './StepFlow'
import type { TranscriptItem } from '../../../shared/types'

// StepFlow → ActionRow uses useI18n + SlotText. Mock both since the text
// display is not what we're testing here (hideFinalTextId logic is).
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock('slot-text/react', () => ({ SlotText: () => null }))
// mascot PNG import: vite resolves assets to strings in build, but vitest
// needs an explicit mock to avoid resolving a binary file.
vi.mock('../../../../assets/branding/verboo-mascot.png', () => ({ default: 'mascot.png' }))

beforeEach(() => cleanup())

describe('StepFlow hideFinalTextId', () => {
  it('hides the text block matching hideFinalTextId by id identity', () => {
    const items: TranscriptItem[] = [
      { id: 't1:text:0', role: 'assistant', text: 'First step complete', timestamp: 0 },
      { id: 't1:text:1', role: 'assistant', text: 'Second step complete', timestamp: 0 },
    ]
    const { container } = render(<StepFlow items={items} hideFinalTextId="t1:text:1" />)
    const textBlocks = container.querySelectorAll('.step-text')
    expect(textBlocks.length).toBe(1)
    expect(textBlocks[0].textContent).toContain('First step complete')
  })

  it('renders all text blocks when hideFinalTextId is not provided', () => {
    const items: TranscriptItem[] = [
      { id: 't1:text:0', role: 'assistant', text: 'Alpha', timestamp: 0 },
      { id: 't1:text:1', role: 'assistant', text: 'Beta', timestamp: 0 },
    ]
    const { container } = render(<StepFlow items={items} />)
    expect(container.querySelectorAll('.step-text').length).toBe(2)
  })

  it('hides only the text block whose id matches (edge: actions follow text)', () => {
    const items: TranscriptItem[] = [
      { id: 't1:text:0', role: 'assistant', text: 'Final result', timestamp: 0 },
      { id: 't1:activity:0', role: 'assistant', kind: 'activity', activityKind: 'edit', text: 'Editou arquivo', activityDetail: 'foo.ts', timestamp: 0 },
    ]
    const { container } = render(<StepFlow items={items} hideFinalTextId="t1:text:0" />)
    // Text block with matching id is hidden
    expect(container.querySelectorAll('.step-text').length).toBe(0)
    // Actions block still renders — non-text blocks are untouched
    expect(container.querySelectorAll('.step-actions').length).toBe(1)
  })
})

describe('StepFlow browser action rows', () => {
  it('renders three consecutive browser actions as three labeled rows', () => {
    const items: TranscriptItem[] = [
      { id: 't1:activity:0', role: 'assistant', kind: 'activity', activityKind: 'browser', text: 'Navegou no Chrome', timestamp: 0 },
      { id: 't1:activity:1', role: 'assistant', kind: 'activity', activityKind: 'browser', text: 'Leu página no Chrome', timestamp: 0 },
      { id: 't1:activity:2', role: 'assistant', kind: 'activity', activityKind: 'browser', text: 'Capturou tela no Chrome', timestamp: 0 },
    ]

    const { container } = render(<StepFlow items={items} />)
    const labels = Array.from(container.querySelectorAll('.step-actions-label')).map(node => node.textContent)

    expect(container.querySelectorAll('.step-actions')).toHaveLength(3)
    expect(labels).toEqual([
      'Navegou no Chrome',
      'Leu página no Chrome',
      'Capturou tela no Chrome',
    ])
  })

  it('does not render the Checklist-owned planning activity as a generic tool row', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1:activity:0',
        role: 'tool',
        kind: 'activity',
        activityKind: 'planning',
        text: 'Usou ferramenta',
        toolOutput: 'Todos have been modified successfully...',
        timestamp: 0,
      },
      { id: 't1:activity:1', role: 'tool', kind: 'activity', activityKind: 'browser', text: 'Leu página no Chrome', timestamp: 0 },
    ]

    const { container } = render(<StepFlow items={items} />)

    expect(container.querySelectorAll('.step-actions')).toHaveLength(1)
    expect(container.querySelector('.step-actions-label')).toHaveTextContent('Leu página no Chrome')
    expect(container.textContent).not.toContain('Usou ferramenta')
  })

  it('keeps a browser row separate from a generic tool row instead of joining them with "e"', () => {
    const items: TranscriptItem[] = [
      { id: 't1:activity:0', role: 'tool', kind: 'activity', activityKind: 'browser', text: 'Leu página no Chrome', timestamp: 0 },
      { id: 't1:activity:1', role: 'tool', kind: 'activity', activityKind: 'tool', text: 'Usou ferramenta', toolOutput: 'generic output', timestamp: 0 },
    ]

    const { container } = render(<StepFlow items={items} />)
    const labels = Array.from(container.querySelectorAll('.step-actions-label')).map(node => node.textContent)

    expect(container.querySelectorAll('.step-actions')).toHaveLength(2)
    expect(labels).toEqual(['Leu página no Chrome', 'transcript.toolOne'])
    expect(labels[0]).not.toContain('transcript.and')
  })
})
