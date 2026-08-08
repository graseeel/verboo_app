import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../../i18n'
import { ApiErrorAwareText } from './ApiErrorText'
import { shouldSuppressSystemErrorText } from './apiErrorPresentation'

// T8: the REAL payload that kills the conversation (field photo do dono,
// vídeo de hoje). Colado da forma que o CLI encaminha — sem inventar.
const API_ERROR_400_THINKING =
  'API Error: 400 {"error":{"type":"invalid_request_error","message":"messages.157.content.0.thinking... each thinking block must contain non-whitespace thinking"}}'

function renderWith(text: string, onStartNewConversation?: () => void, language: 'en-US' | 'pt-BR' = 'en-US') {
  return render(
    <I18nProvider language={language}>
      <ApiErrorAwareText text={text} account="Ada" onStartNewConversation={onStartNewConversation} />
    </I18nProvider>,
  )
}

describe('T8: ApiErrorAwareText surfaces the thinking-block 400 with an exit, not raw JSON', () => {
  it('en: renders the readable headline + "Start a new conversation" button (not the raw JSON)', () => {
    const onStartNewConversation = vi.fn()
    renderWith(API_ERROR_400_THINKING, onStartNewConversation, 'en-US')

    // The readable headline is on the surface…
    expect(screen.getByText(/This conversation can't continue/)).toBeTruthy()
    // …the exit button is offered…
    const button = screen.getByRole('button', { name: /Start a new conversation/ })
    expect(button).toBeTruthy()
    // …and the raw JSON is NOT bare on the surface (no "invalid_request_error" leaking).
    expect(screen.queryByText(/invalid_request_error/)).toBeNull()
    expect(screen.queryByText(/messages\.157/)).toBeNull()
  })

  it('pt-BR: renders the readable headline + "Começar uma nova conversa" button', () => {
    const onStartNewConversation = vi.fn()
    renderWith(API_ERROR_400_THINKING, onStartNewConversation, 'pt-BR')

    expect(screen.getByText(/Esta conversa não pode continuar/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Começar uma nova conversa/ })).toBeTruthy()
    expect(screen.queryByText(/invalid_request_error/)).toBeNull()
    // T7/T8 linguagem: "thinking" é jargão nosso — em pt-BR escrevemos
    // "raciocínio". Pina o vazamento de termo inglês cru no texto pt.
    // Case-insensitive: "THINKING"/"Thinking" também é jargão (Cadinho).
    expect(screen.queryByText(/thinking/i)).toBeNull()
  })

  it('clicking the button calls onStartNewConversation (the exit fires)', () => {
    const onStartNewConversation = vi.fn()
    renderWith(API_ERROR_400_THINKING, onStartNewConversation, 'en-US')
    fireEvent.click(screen.getByRole('button', { name: /Start a new conversation/ }))
    expect(onStartNewConversation).toHaveBeenCalledTimes(1)
  })

  it('without onStartNewConversation, the headline shows but no button', () => {
    renderWith(API_ERROR_400_THINKING, undefined, 'en-US')
    expect(screen.getByText(/This conversation can't continue/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

// T19/K.3: the unified duplication guard shouldSuppressSystemErrorText
// replaces the old bodyHasRawError + !isContextOverflow exception. The
// guard asks parseApiErrorText "would ApiErrorAwareText render a parsed
// headline from this body?" — context-overflow messages are NOT "API Error:
// NNN {json}" lines, so parseApiErrorText returns undefined and the guard
// never fires. No isContextOverflow exception, no unproven assumption.
describe('shouldSuppressSystemErrorText (T19/K.3)', () => {
  it('fires for a recognized API error line (body would render a parsed headline)', () => {
    expect(shouldSuppressSystemErrorText(API_ERROR_400_THINKING)).toBe(true)
    const QUOTA = 'API Error: 429 {"error":{"type":"usage_limit_reached","plan_type":"plus","resets_in_seconds":72000}}'
    expect(shouldSuppressSystemErrorText(QUOTA)).toBe(true)
  })

  it('K.3: does NOT fire for context-overflow messages (no isContextOverflow exception needed)', () => {
    // These are the strings isContextOverflow matches in App.tsx — none are
    // "API Error: NNN {json}" lines, so parseApiErrorText returns undefined.
    expect(shouldSuppressSystemErrorText('Error: prompt is too long — context window exceeded')).toBe(false)
    expect(shouldSuppressSystemErrorText('This model has a maximum context length of 200000 tokens.')).toBe(false)
    expect(shouldSuppressSystemErrorText('too many tokens in the request')).toBe(false)
  })

  it('does NOT fire for empty or plain assistant text', () => {
    expect(shouldSuppressSystemErrorText('')).toBe(false)
    expect(shouldSuppressSystemErrorText('Trabalhou')).toBe(false)
    expect(shouldSuppressSystemErrorText('Let me check that for you.')).toBe(false)
  })
})
