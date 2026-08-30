import type { CliTerminalFailure } from '../../../shared/types'

const LEGACY_AUTH_FAILURE = /authentication_failed|failed to authenticate|invalid or expired token|oauth session expired|api error:\s*401|não autenticado no verboo|api key inválida ou expirada/i

export function isAuthenticationFailure(
  failure: CliTerminalFailure | undefined,
  legacyMessage: string,
): boolean {
  if (failure) return failure.category === 'authentication_failed'
  return LEGACY_AUTH_FAILURE.test(legacyMessage)
}

export function shouldAutoRecoverAuthentication(
  failure: CliTerminalFailure | undefined,
  recoveryInProgress: boolean,
): boolean {
  return Boolean(
    failure?.recoveryReady
    && !recoveryInProgress
    && isAuthenticationFailure(failure, failure.message),
  )
}

export function shouldRetryIncompleteTurn(
  failure: CliTerminalFailure | undefined,
  alreadyRetriedWithoutSession: boolean,
): boolean {
  return failure?.category === 'incomplete_turn' && !alreadyRetriedWithoutSession
}
