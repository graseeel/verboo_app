import type { AgentEvent } from '../../../shared/types'
import type { Translator } from '../../i18n'
import { parseApiErrorFromBlob, presentApiErrorMessage } from './apiErrorPresentation'
import { presentTurnError, type TurnErrorPresentation } from './turnOutcomePresentation'

const CLI_HEADLESS_UNAUTH_RE = /não autenticado no verboo/i
const CLI_INVALID_API_KEY_RE = /api key inválida ou expirada/i

/** CLI headless auth gate is hardcoded Portuguese on every OS. */
export function isCliHeadlessAuthFailure(message: string): boolean {
  return CLI_HEADLESS_UNAUTH_RE.test(message) || CLI_INVALID_API_KEY_RE.test(message)
}

function technicalDetailFor(event: Extract<AgentEvent, { type: 'error' }>): string {
  const extra = event.payload?.technicalDetail?.trim()
  if (!extra || extra === event.message) return event.message
  if (event.message.includes(extra)) return event.message
  return `${event.message}\n${extra}`
}

/**
 * Production seam for the App's error-event handler. Keeping the translation
 * lookup here means the event, interruption intent, and user-facing outcome
 * are tested together instead of testing the lower-level formatter alone.
 */
export function presentAgentError(
  event: Extract<AgentEvent, { type: 'error' }>,
  userInterruptedTurns: Set<string>,
  t: Translator,
  accountLabel?: string,
): TurnErrorPresentation {
  const base = presentTurnError(event, userInterruptedTurns, t('transcript.turnInterrupted'))
  // Interruptions keep their own presentation untouched.
  if (base.presentation === 'interruption') return base
  if (isCliHeadlessAuthFailure(event.message) || isCliHeadlessAuthFailure(event.payload?.message ?? '')) {
    return {
      text: t('transcript.cliUnauthenticated'),
      technicalDetail: technicalDetailFor(event),
    }
  }
  // A recognized provider API error (usage_limit_reached) surfaces as a
  // readable headline; the raw diagnostic blob (exit code, runtime, cli
  // path, cwd) moves to the collapsed technical detail — internal internals
  // are never the first thing the user reads (field defect).
  const info = parseApiErrorFromBlob(event.message)
  const readable = info && accountLabel ? presentApiErrorMessage(info, accountLabel, t) : undefined
  if (!readable) return base
  return { text: readable, technicalDetail: event.message }
}
