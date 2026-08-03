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

  it('summarizes multiple browser actions with the plural form and count', () => {
    const make = (): TurnAction => ({ kind: 'browser', label: 'Navegou no Chrome' })
    const en = summarizeActions([make(), make()], createTranslator('en-US'))
    expect(en).toContain('Chrome')
    expect(en).toContain('(2)')
  })
})
