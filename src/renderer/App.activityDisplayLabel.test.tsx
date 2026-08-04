import { describe, expect, it } from 'vitest'
import type { TurnAction } from '../shared/types'
import { createTranslator } from './i18n'
import { summarizeActions } from './features/transcript/turnBlocks'

describe('browser transcript action labels', () => {
  it('uses both specific labels for navigate and read_page in the real summary path', () => {
    const actions: TurnAction[] = [
      { kind: 'browser', label: 'Navegou no Chrome' },
      { kind: 'browser', label: 'Leu página no Chrome' },
    ]

    const summary = summarizeActions(actions, createTranslator('pt-BR'))

    expect(summary).toContain('Navegou no Chrome')
    expect(summary).toContain('Leu página no Chrome')
    expect(summary).not.toBe('Usou o Chrome (2)')
  })
})
