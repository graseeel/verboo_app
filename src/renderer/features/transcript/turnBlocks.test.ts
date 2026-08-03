import { describe, it, expect } from 'vitest'
import { groupTurnBlocks, summarizeActions } from './turnBlocks'
import type { TranscriptItem, TurnAction } from '../../../shared/types'
import { createTranslator } from '../../i18n'

function browserActivity(text: string): TranscriptItem {
  return {
    id: 't1:activity:0',
    role: 'assistant',
    kind: 'activity',
    activityKind: 'browser',
    text,
    timestamp: 0,
  }
}

describe('browser (Verboo-in-Chrome) transcript presentation', () => {
  it('maps a browser activityKind to the browser TurnActionKind, not the tool fallback', () => {
    const blocks = groupTurnBlocks([browserActivity('Navegou no Chrome')])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('actions')
    if (blocks[0].kind === 'actions') {
      expect(blocks[0].actions[0].kind).toBe('browser')
    }
  })

  it('summarizes browser actions with a Chrome-naming label in both locales', () => {
    const action: TurnAction = { kind: 'browser', label: 'Navegou no Chrome' }
    const en = summarizeActions([action], createTranslator('en-US'))
    expect(en).toContain('Chrome')
    const pt = summarizeActions([action], createTranslator('pt-BR'))
    expect(pt).toContain('Chrome')
  })

  it('lists distinct labels for different browser tools in one action block', () => {
    const summary = summarizeActions([
      { kind: 'browser', label: 'Navegou no Chrome' },
      { kind: 'browser', label: 'Leu página no Chrome' },
    ], createTranslator('pt-BR'))

    expect(summary).toBe('Navegou no Chrome, Leu página no Chrome')
  })

  it('keeps edits for different files in separate blocks', () => {
    const blocks = groupTurnBlocks([
      { id: 't1:activity:0', role: 'assistant', kind: 'activity', activityKind: 'edit', text: 'Editou arquivo', activityDetail: 'src/a.ts', timestamp: 0 },
      { id: 't1:activity:1', role: 'assistant', kind: 'activity', activityKind: 'edit', text: 'Editou arquivo', activityDetail: 'src/b.ts', timestamp: 0 },
    ])

    expect(blocks).toHaveLength(2)
    expect(blocks.every(block => block.kind === 'actions' && block.actions.length === 1)).toBe(true)
  })

  it('continues grouping consecutive read actions', () => {
    const blocks = groupTurnBlocks([
      { id: 't1:activity:0', role: 'assistant', kind: 'activity', activityKind: 'read', text: 'Leu arquivo', activityDetail: 'src/a.ts', timestamp: 0 },
      { id: 't1:activity:1', role: 'assistant', kind: 'activity', activityKind: 'read', text: 'Leu arquivo', activityDetail: 'src/b.ts', timestamp: 0 },
    ])

    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind === 'actions' && blocks[0].actions).toHaveLength(2)
  })
})
