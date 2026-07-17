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
