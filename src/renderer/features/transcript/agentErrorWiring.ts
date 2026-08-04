import type { AgentEvent } from '../../../shared/types'
import type { Translator } from '../../i18n'
import { presentTurnError, type TurnErrorPresentation } from './turnOutcomePresentation'

/**
 * Production seam for the App's error-event handler. Keeping the translation
 * lookup here means the event, interruption intent, and user-facing outcome
 * are tested together instead of testing the lower-level formatter alone.
 */
export function presentAgentError(
  event: Extract<AgentEvent, { type: 'error' }>,
  userInterruptedTurns: Set<string>,
  t: Translator,
): TurnErrorPresentation {
  return presentTurnError(event, userInterruptedTurns, t('transcript.turnInterrupted'))
}
