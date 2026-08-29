import type { AgentEvent } from '../../../shared/types'

export type TurnErrorPresentation = {
  text: string
  technicalDetail?: string
  correlationId?: string
  presentation?: 'interruption'
}

/**
 * An interrupt and a process failure can produce the same native `error`
 * event. The renderer records explicit user intent before calling interrupt;
 * consuming that turn id here keeps an unsolicited process failure technical.
 */
export function presentTurnError(
  event: Extract<AgentEvent, { type: 'error' }>,
  userInterruptedTurns: Set<string>,
  interruptedLabel: string,
): TurnErrorPresentation {
  if (!userInterruptedTurns.delete(event.turnId)) return { text: event.message }
  return {
    text: interruptedLabel,
    technicalDetail: event.message,
    presentation: 'interruption',
  }
}
