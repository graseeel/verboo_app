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

  it('localizes the CLI headless unauthenticated gate and keeps the raw message as technical detail', () => {
    const raw =
      'Não autenticado no Verboo. Execute `verboo /login` em um terminal interativo antes de usar o modo headless.\n(exit=1)'
    const event: Extract<AgentEvent, { type: 'error' }> = {
      type: 'error',
      turnId: 'turn-cli-unauth',
      message: raw,
      payload: {
        category: 'authentication_failed',
        message: raw,
        details: [raw],
        exitCode: 1,
        recoveryReady: false,
        technicalDetail: '(exit=1, runtime=installed-node(version=0.15.17, node=/secret/node, cli=/secret/cli.mjs), cwd=/secret/project)',
      },
    }

    const en = presentAgentError(event, new Set(), translator)
    expect(en.text).toBe(
      'CLI session is not authenticated — sign in with the CLI or check your API key.',
    )
    expect(en.text).not.toContain('/secret')
    expect(en.technicalDetail).toContain('Não autenticado no Verboo')
    expect(en.technicalDetail).toContain('/secret/node')

    const pt = presentAgentError(event, new Set(), createTranslator('pt-BR'))
    expect(pt.text).toBe(
      'Sessão do CLI não autenticada — entre pelo CLI ou verifique sua API key.',
    )
    expect(pt.text).not.toContain('Não autenticado no Verboo. Execute')
    expect(pt.technicalDetail).toContain('Não autenticado no Verboo')
  })

  it('localizes the CLI unauthenticated gate from the message alone (no payload)', () => {
    const event: Extract<AgentEvent, { type: 'error' }> = {
      type: 'error',
      turnId: 'turn-cli-unauth-bare',
      message:
        'Não autenticado no Verboo. Execute `verboo /login` em um terminal interativo antes de usar o modo headless.\n(exit=1, runtime=installed-node(version=0.15.17))',
    }

    const presented = presentAgentError(event, new Set(), translator)
    expect(presented.text).toBe(
      'CLI session is not authenticated — sign in with the CLI or check your API key.',
    )
    expect(presented.text).not.toContain('installed-node')
    expect(presented.technicalDetail).toContain('Não autenticado no Verboo')
    expect(presented.technicalDetail).toContain('exit=1')
  })
})
