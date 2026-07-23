import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Transcript } from './Transcript'
import type { TranscriptItem } from '../../shared/types'

// Transcript → TurnView imports MarkdownMessage, StepFlow, ThinkingIcon,
// useI18n. Mock all so the test focuses on the .turn-recap mounting behavior.
vi.mock('../features/transcript/MarkdownMessage', () => ({
  MarkdownMessage: ({ text }: { text: string }) => <div className="mock-markdown">{text}</div>,
  normalizeThinkingProse: (t: string) => t,
}))
vi.mock('../features/transcript/StepFlow', () => ({
  StepFlow: ({ hideFinalTextId }: { hideFinalTextId?: string }) => (
    <div className="mock-stepflow" data-hide-id={hideFinalTextId ?? ''} />
  ),
}))
vi.mock('../features/transcript/TranscriptIcons', () => ({ ThinkingIcon: () => null }))
vi.mock('../i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))

beforeEach(() => cleanup())

describe('TurnView — .turn-recap stays mounted after expand', () => {
  const turnId = 'turn-recap-test'

  it('renders .turn-recap when turn has final text and actions (non-streaming)', () => {
    const items: TranscriptItem[] = [
      {
        id: `${turnId}:activity:0`,
        role: 'assistant',
        kind: 'activity',
        activityKind: 'edit',
        text: 'Editou arquivo',
        activityDetail: 'src/foo.ts',
        timestamp: 0,
      },
      {
        id: `${turnId}:text:0`,
        role: 'assistant',
        text: 'I fixed the bug by correcting the type annotation.',
        timestamp: 0,
      },
    ]
    const { container } = render(<Transcript items={items} />)
    // .turn-recap should be present BEFORE expand (no longer gated on !expanded)
    const recap = container.querySelector('.turn-recap')
    expect(recap).toBeTruthy()
    expect(recap?.textContent).toContain('I fixed the bug by correcting the type annotation.')

    // Click the expand button
    const collapseBtn = container.querySelector('.turn-collapsed')
    expect(collapseBtn).toBeTruthy()
    fireEvent.click(collapseBtn!)

    // .turn-recap must STILL be mounted after expand
    expect(container.querySelector('.turn-recap')).toBeTruthy()
  })

  it('renders .turn-recap even when turn has no actions (text only, non-streaming)', () => {
    const items: TranscriptItem[] = [
      {
        id: `${turnId}:text:0`,
        role: 'assistant',
        text: 'Just a response message.',
        timestamp: 0,
      },
    ]
    const { container } = render(<Transcript items={items} />)
    // Text-only turns still show the recap (the "static" span variant)
    expect(container.querySelector('.turn-recap')).toBeTruthy()
  })

  it('renders persisted browser annotations as image thumbnails', () => {
    const items: TranscriptItem[] = [{
      id: 'user:annotation',
      role: 'user',
      text: 'Use this visual context',
      timestamp: 0,
      attachments: [{
        path: '/app/browser_captures/owner/crop.png',
        name: 'browser-annotation.png',
        size: 100,
        kind: 'browser-annotation',
        browserAnnotation: {
          kind: 'pen', crop: '/app/browser_captures/owner/crop.png', url: 'http://localhost:3000',
          rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 },
        },
      }],
    }]

    const { container } = render(<Transcript items={items} />)

    expect(container.querySelector('.message-attachment-image img')).toBeTruthy()
    expect(container.querySelector('.message-attachment-file')).toBeNull()
  })
})
