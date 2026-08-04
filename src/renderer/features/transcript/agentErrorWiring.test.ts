import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '../../../shared/types'
import { createTranslator } from '../../i18n'
import { presentAgentError } from './agentErrorWiring'

const translator = createTranslator('en-US')
const rawDiagnostic = '(signal, runtime=bundled-node, cwd=/project)'

describe('agent error wiring', () => {
  it('passes the production interruption label when a marked turn errors', () => {
    const event: Extract<AgentEvent, { type: 'error' }> = {
      type: 'error',
      turnId: 'turn-wired-interruption',
      message: rawDiagnostic,
    }

    const presentation = presentAgentError(event, new Set([event.turnId]), translator)

    expect(presentation.text).toBe('Turn interrupted by the user.')
    expect(presentation.technicalDetail).toBe(rawDiagnostic)
    expect(presentation.presentation).toBe('interruption')
  })

  it('keeps an unmarked error as a failure with its diagnostic', () => {
    const event: Extract<AgentEvent, { type: 'error' }> = {
      type: 'error',
      turnId: 'turn-wired-failure',
      message: rawDiagnostic,
    }

    expect(presentAgentError(event, new Set(), translator)).toEqual({ text: rawDiagnostic })
  })
})
