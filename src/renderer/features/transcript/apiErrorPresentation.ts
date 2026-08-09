import type { Translator } from '../../i18n'

/**
 * The CLI forwards provider API errors as assistant text in the shape
 *   API Error: 429 {"error":{"type":"usage_limit_reached","plan_type":"plus","resets_in_seconds":72000}}
 * and the same line rides inside the terminal diagnostic blob (exit code,
 * runtime, cli path, cwd). Showing that raw to the user is an internal-detail
 * leak (field defect): recognize the payload and render a readable headline,
 * keeping the raw line for the collapsed technical detail.
 */

export type ApiErrorInfo = {
  status: number
  type?: string
  planType?: string
  resetsInSeconds?: number
  /** The provider's human-readable message (e.g. the thinking-block path).
   *  Kept for classification — never shown raw to the user. */
  message?: string
  /** The original line, kept for the collapsed technical detail. */
  raw: string
}

const API_ERROR_LINE_RE = /^\s*API Error:\s*(\d{3})\s*(\{.*\})\s*$/s

export function parseApiErrorText(text: string): ApiErrorInfo | undefined {
  const match = text.match(API_ERROR_LINE_RE)
  if (!match) return undefined
  try {
    const parsed = JSON.parse(match[2]) as {
      error?: { type?: unknown; plan_type?: unknown; resets_in_seconds?: unknown; message?: unknown }
    }
    const error = parsed?.error
    if (!error || typeof error !== 'object') return undefined
    return {
      status: Number(match[1]),
      type: typeof error.type === 'string' ? error.type : undefined,
      planType: typeof error.plan_type === 'string' ? error.plan_type : undefined,
      resetsInSeconds: typeof error.resets_in_seconds === 'number' ? error.resets_in_seconds : undefined,
      message: typeof error.message === 'string' ? error.message : undefined,
      raw: text.trim(),
    }
  } catch {
    return undefined
  }
}

/** The terminal blob is multi-line — the API error is one of the lines. */
export function parseApiErrorFromBlob(blob: string): ApiErrorInfo | undefined {
  for (const line of blob.split('\n')) {
    const info = parseApiErrorText(line)
    if (info) return info
  }
  return undefined
}

export function humanizeResetSeconds(seconds: number, t: Translator): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `~${minutes} ${t(minutes === 1 ? 'transcript.duration.minuteOne' : 'transcript.duration.minuteMany')}`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `~${hours} ${t(hours === 1 ? 'transcript.duration.hourOne' : 'transcript.duration.hourMany')}`
  }
  const days = Math.round(hours / 24)
  return `~${days} ${t(days === 1 ? 'transcript.duration.dayOne' : 'transcript.duration.dayMany')}`
}

/** Readable headline for the recognized payload. Scoped to
 *  usage_limit_reached (the field defect): any other API error returns
 *  undefined and the caller keeps today's raw rendering. */
export function presentUsageLimitMessage(info: ApiErrorInfo, account: string, t: Translator): string | undefined {
  if (info.type !== 'usage_limit_reached') return undefined
  const headline = info.planType
    ? t('transcript.usageLimitReachedPlan', { account, plan: info.planType })
    : t('transcript.usageLimitReached', { account })
  const renews = info.resetsInSeconds !== undefined
    ? ` ${t('transcript.usageLimitRenews', { reset: humanizeResetSeconds(info.resetsInSeconds, t) })}`
    : ''
  return `${headline}${renews}`
}

/** A `retry_delay_ms` at or above this is not a retry backoff — it's the CLI
 *  waiting out a quota reset. Derived: the measured quota event declares
 *  retry_delay_ms=154_650_000 (43h); a legitimate retry backoff is seconds
 *  to low minutes (the existing test shows ~18s per retry over 10 attempts).
 *  1h (3_600_000ms) is the natural boundary between the two regimes — 43×
 *  below the measured reset, 120× above a 30s retry. The two don't confuse. */
export const QUOTA_RETRY_DELAY_THRESHOLD_MS = 3_600_000

/** When the CLI's declared retry wait is hour-scale, the "retry" is really a
 *  quota reset — surface the readable headline instead of sitting on a mute
 *  "Thinking…" for 43h. Returns the readable message when the wait crosses
 *  the threshold, undefined otherwise (normal retry → keep the live notice).
 *  Reuses presentUsageLimitMessage — no second formatter. */
/** T19: unified duplication guard — the SINGLE check applied at every point
 *  where a readable headline is inserted as role system (there are 4; grep
 *  `role: 'system'` in App.tsx). If the assistant body is a recognized API
 *  error line, ApiErrorAwareText in the turn-recap will parse it into the
 *  SAME headline — the same sentence twice. Returns true to suppress the
 *  system row's text (keep only the collapsed technical-detail toggle).
 *
 *  The check is `parseApiErrorText(bodyText) !== undefined` — it asks whether
 *  ApiErrorAwareText WILL render a parsed headline, not whether the raw error
 *  text appears somewhere in the body. Context-overflow errors ("prompt is
 *  too long", "too many tokens") are NOT "API Error: NNN {json}" lines, so
 *  parseApiErrorText returns undefined for them and the guard never fires —
 *  no `isContextOverflow` exception needed, no unproven assumption. */
export function shouldSuppressSystemErrorText(bodyText: string): boolean {
  return parseApiErrorText(bodyText) !== undefined
}

export function quotaResetMessageFromRetry(
  retryDelayMs: number | undefined,
  accountLabel: string,
  t: Translator,
): string | undefined {
  if (retryDelayMs === undefined || retryDelayMs < QUOTA_RETRY_DELAY_THRESHOLD_MS) return undefined
  const info: ApiErrorInfo = {
    status: 429,
    type: 'usage_limit_reached',
    resetsInSeconds: Math.round(retryDelayMs / 1000),
    raw: `api_retry retry_delay_ms=${retryDelayMs}`,
  }
  return presentUsageLimitMessage(info, accountLabel, t)
}

/** T8: a 400 invalid_request_error whose message references a thinking
 *  block (e.g. "messages.157.content.0.thinking... each thinking block
 *  must contain non-whitespace thinking") leaves the conversation
 *  PERMANENTLY dead — every new turn fails the same way. The root cause
 *  is in the CLI (their fence); our job is to not leave the owner stuck
 *  without knowing. Match on the stable shape (status 400 +
 *  invalid_request_error + "thinking" in the message), not the exact
 *  index, so a different turn depth still classifies. */
export function isInvalidThinkingError(info: ApiErrorInfo): boolean {
  if (info.status !== 400) return false
  if (info.type !== 'invalid_request_error') return false
  return /thinking/i.test(info.message ?? '')
}

/** Readable headline for the thinking-block 400. Honest: says THIS
 *  conversation can't continue, the history is saved, new turns fail,
 *  and the fix depends on the CLI — never promises a repair we don't
 *  deliver. The caller offers the exit (start a new conversation) as a
 *  button next to this headline. */
export function presentInvalidThinkingMessage(info: ApiErrorInfo, t: Translator): string | undefined {
  if (!isInvalidThinkingError(info)) return undefined
  return t('transcript.conversationCannotContinue')
}

/** Dispatcher: tries the usage-limit headline, then the thinking-block
 *  headline. Returns undefined for unrecognized payloads so the caller
 *  keeps today's raw rendering. */
export function presentApiErrorMessage(info: ApiErrorInfo, account: string, t: Translator): string | undefined {
  return presentUsageLimitMessage(info, account, t) ?? presentInvalidThinkingMessage(info, t)
}

/** Presentation for the normalized provider-usage protocol. Reset dates are
 * already locale-formatted by the renderer; an absent date stays explicit. */
export function presentProviderQuotaMessage(
  account: string,
  resetAt: string | undefined,
  allAccounts: boolean,
  t: Translator,
): string {
  const key = allAccounts
    ? 'transcript.providerQuotaAllAccounts'
    : 'transcript.providerQuotaSelectedAccount'
  return t(key, {
    account,
    reset: resetAt ?? t('transcript.providerQuotaResetUnknown'),
  })
}
