import { describe, it, expect } from 'vitest'
import type { Translator } from '../../i18n'
import {
  parseApiErrorText,
  parseApiErrorFromBlob,
  isInvalidThinkingError,
  presentInvalidThinkingMessage,
  presentUsageLimitMessage,
  presentApiErrorMessage,
  presentProviderQuotaMessage,
} from './apiErrorPresentation'

// T8: the REAL payload that kills the conversation (field photo do dono,
// vídeo de hoje). Colado da forma que o CLI encaminha — sem inventar.
const API_ERROR_400_THINKING =
  'API Error: 400 {"error":{"type":"invalid_request_error","message":"messages.157.content.0.thinking... each thinking block must contain non-whitespace thinking"}}'

// The 429 quota payload (already shipped) — used to prove the dispatcher
// still routes it correctly and does NOT misclassify it as a thinking block.
const API_ERROR_429_QUOTA =
  'API Error: 429 {"error":{"type":"usage_limit_reached","plan_type":"plus","resets_in_seconds":72000}}'

const t: Translator = (key) => key

describe('T8: the thinking-block 400 is classified, not leaked as raw JSON', () => {
  it('parseApiErrorText extracts status 400, type invalid_request_error, and the thinking message', () => {
    const info = parseApiErrorText(API_ERROR_400_THINKING)!
    expect(info, 'the real payload must parse').toBeTruthy()
    expect(info.status).toBe(400)
    expect(info.type).toBe('invalid_request_error')
    expect(info.message).toMatch(/thinking/i)
  })

  it('isInvalidThinkingError is true for the thinking-block 400', () => {
    const info = parseApiErrorText(API_ERROR_400_THINKING)!
    expect(isInvalidThinkingError(info)).toBe(true)
  })

  it('presentInvalidThinkingMessage returns the readable headline (not undefined)', () => {
    const info = parseApiErrorText(API_ERROR_400_THINKING)!
    const readable = presentInvalidThinkingMessage(info, t)
    expect(readable, 'must surface a readable headline, not undefined').toBeTruthy()
    expect(readable).toBe('transcript.conversationCannotContinue')
  })

  it('presentUsageLimitMessage returns undefined for the thinking-block 400 (not a quota)', () => {
    const info = parseApiErrorText(API_ERROR_400_THINKING)!
    expect(presentUsageLimitMessage(info, 'Ada', t)).toBeUndefined()
  })

  it('presentApiErrorMessage dispatcher routes the thinking-block 400 to the readable headline', () => {
    const info = parseApiErrorText(API_ERROR_400_THINKING)!
    expect(presentApiErrorMessage(info, 'Ada', t)).toBe('transcript.conversationCannotContinue')
  })

  it('parseApiErrorFromBlob finds the thinking-block 400 inside the multi-line terminal blob', () => {
    const blob = [
      API_ERROR_400_THINKING,
      'O CLI Verboo encerrou com código 1.',
      'exit=1 · runtime=node20 · cli=/opt/verboo/bin/verboo · cwd=/Users/alice/project',
    ].join('\n')
    const info = parseApiErrorFromBlob(blob)!
    expect(isInvalidThinkingError(info)).toBe(true)
  })
})

describe('T8: the dispatcher does not regress the 429 quota classification', () => {
  it('isInvalidThinkingError is false for the 429 quota payload', () => {
    const info = parseApiErrorText(API_ERROR_429_QUOTA)!
    expect(isInvalidThinkingError(info)).toBe(false)
  })

  it('presentApiErrorMessage dispatcher still routes the 429 to the usage-limit headline', () => {
    const info = parseApiErrorText(API_ERROR_429_QUOTA)!
    // The quota headline carries a renewal suffix — assert the routed
    // headline (plan variant), not the exact full string.
    expect(presentApiErrorMessage(info, 'Ada', t)).toContain('transcript.usageLimitReachedPlan')
  })

  it('presentInvalidThinkingMessage returns undefined for the 429 quota payload', () => {
    const info = parseApiErrorText(API_ERROR_429_QUOTA)!
    expect(presentInvalidThinkingMessage(info, t)).toBeUndefined()
  })

  it('presents normalized selected-account and aggregate reset copy', () => {
    expect(presentProviderQuotaMessage('Codex 1', 'Aug 12, 2026, 2:30 PM', false, t))
      .toContain('transcript.providerQuotaSelectedAccount')
    expect(presentProviderQuotaMessage('Codex', undefined, true, t))
      .toContain('transcript.providerQuotaAllAccounts')
  })
})
