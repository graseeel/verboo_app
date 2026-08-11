import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '../../../shared/types'
import { presentTurnError } from './turnOutcomePresentation'

const rawSignalMessage = '(signal, runtime=managed-cli(node=/Users/example/Library/Application Support/ai.verboo.code.desktop/runtime/node/24.19.0/aarch64-apple-darwin/node, cli=/Users/example/Library/Application Support/ai.verboo.code.desktop/cli/versions/0.15.6/dist/cli.mjs), cwd=/workspace)'

describe('turn error presentation', () => {
  it('turns an explicitly requested interruption into a friendly result and keeps the diagnostic expandable', () => {
    const interruptedTurn: Extract<AgentEvent, { type: 'error' }> = {
      type: 'error',
      turnId: 'turn-user-interrupted',
      message: rawSignalMessage,
    }
    const userInterruptedTurns = new Set([interruptedTurn.turnId])

    expect(presentTurnError(interruptedTurn, userInterruptedTurns, 'Turn interrupted by the user.')).toEqual({
      text: 'Turn interrupted by the user.',
      technicalDetail: rawSignalMessage,
      presentation: 'interruption',
    })
  })

  it('keeps a signal from a turn that failed on its own as a failure', () => {
    const failedTurn: Extract<AgentEvent, { type: 'error' }> = {
      type: 'error',
      turnId: 'turn-real-failure',
      message: rawSignalMessage,
    }

    expect(presentTurnError(failedTurn, new Set(), 'Turn interrupted by the user.')).toEqual({
      text: rawSignalMessage,
    })
  })
})
