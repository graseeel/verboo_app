import { describe, it, expect, vi } from 'vitest'
import {
  composeVoiceAppend,
  createVoiceInput,
  detectSupport,
  getSpeechRecognitionCtor,
  type RecognitionLike,
} from './voiceInput'

class MockRecognition implements RecognitionLike {
  lang = ''
  continuous = false
  interimResults = false
  started = false
  stopped = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onresult: ((event: any) => void) | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((event: any) => void) | null = null
  onend: (() => void) | null = null

  start(): void {
    this.started = true
  }

  stop(): void {
    this.stopped = true
    this.onend?.()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  triggerResult(event: any): void {
    this.onresult?.(event)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  triggerError(error: any): void {
    this.onerror?.(error)
  }

  fireEnd(): void {
    this.onend?.()
  }
}

function makeResultEvent(resultIndex: number, items: Array<[string, boolean]>): {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any = items.map(([text, isFinal]) => ({ isFinal, 0: { transcript: text } }))
  return { resultIndex, results }
}

describe('detectSupport', () => {
  it('returns false in a Node/jsdom env with no constructor registered', () => {
    expect(getSpeechRecognitionCtor()).toBeUndefined()
    expect(detectSupport()).toBe(false)
  })
})

describe('createVoiceInput — lifecycle', () => {
  it('start() returns false when not supported and no factory is provided', () => {
    const onError = vi.fn()
    const handle = createVoiceInput({ onError })
    expect(handle.isSupported).toBe(false)
    expect(handle.start()).toBe(false)
    expect(handle.isListening()).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  it('start() throws inside factory → onError fires and listening stays false', () => {
    const onError = vi.fn()
    const handle = createVoiceInput({
      recognitionFactory: () => {
        throw new Error('boom')
      },
      onError,
    })
    expect(handle.start()).toBe(false)
    expect(handle.isListening()).toBe(false)
    expect(onError).toHaveBeenCalledWith({ message: 'boom' })
  })

  it('start() wires language/continuous/interimResults and calls onStart', () => {
    const mock = new MockRecognition()
    const onStart = vi.fn()
    const handle = createVoiceInput({
      recognitionFactory: () => mock,
      lang: 'pt-BR',
      onStart,
    })
    expect(handle.start()).toBe(true)
    expect(mock.started).toBe(true)
    expect(mock.lang).toBe('pt-BR')
    expect(mock.continuous).toBe(true)
    // No onInterim subscriber → interimResults should be false.
    expect(mock.interimResults).toBe(false)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(handle.isListening()).toBe(true)
  })

  it('start() enables interimResults only when onInterim is provided', () => {
    const mock = new MockRecognition()
    createVoiceInput({
      recognitionFactory: () => mock,
      onInterim: () => {},
    }).start()
    expect(mock.interimResults).toBe(true)
  })

  it('start() is idempotent — second call returns false without re-invoking the factory', () => {
    const factory = vi.fn(() => new MockRecognition())
    const handle = createVoiceInput({ recognitionFactory: factory })
    expect(handle.start()).toBe(true)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(handle.start()).toBe(false)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('stop() calls underlying stop() and stays safe after end fires', () => {
    const mock = new MockRecognition()
    const handle = createVoiceInput({ recognitionFactory: () => mock })
    handle.start()
    handle.stop()
    expect(mock.stopped).toBe(true)
    expect(() => handle.stop()).not.toThrow()
  })

  it('onEnd fires when the browser ends the session', () => {
    const mock = new MockRecognition()
    const onEnd = vi.fn()
    const handle = createVoiceInput({ recognitionFactory: () => mock, onEnd })
    handle.start()
    mock.fireEnd()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(handle.isListening()).toBe(false)
  })

  it('stop() swallow underlying exception (e.g. after natural end)', () => {
    const mock = new MockRecognition()
    mock.stop = () => {
      throw new Error('already ended')
    }
    const handle = createVoiceInput({ recognitionFactory: () => mock })
    handle.start()
    expect(() => handle.stop()).not.toThrow()
  })
})

describe('createVoiceInput — onresult', () => {
  it('trims a final transcript and forwards to onFinal', () => {
    const mock = new MockRecognition()
    const onFinal = vi.fn()
    createVoiceInput({ recognitionFactory: () => mock, onFinal }).start()
    mock.triggerResult(makeResultEvent(0, [['  hello world  ', true]]))
    expect(onFinal).toHaveBeenCalledWith('hello world')
  })

  it('skips final transcripts that are only whitespace', () => {
    const mock = new MockRecognition()
    const onFinal = vi.fn()
    createVoiceInput({ recognitionFactory: () => mock, onFinal }).start()
    mock.triggerResult(makeResultEvent(0, [['   \n  ', true]]))
    expect(onFinal).not.toHaveBeenCalled()
  })

  it('concatenates non-final fragments into one interim emission', () => {
    const mock = new MockRecognition()
    const onInterim = vi.fn()
    createVoiceInput({ recognitionFactory: () => mock, onInterim }).start()
    // Single event with two interim results → accumulated.
    mock.triggerResult(makeResultEvent(0, [
      ['hello ', false],
      ['world', false],
    ]))
    expect(onInterim).toHaveBeenCalledTimes(1)
    expect(onInterim).toHaveBeenCalledWith('hello world')
  })

  it('does not call onInterim when there are no interim segments', () => {
    const mock = new MockRecognition()
    const onInterim = vi.fn()
    const onFinal = vi.fn()
    createVoiceInput({ recognitionFactory: () => mock, onInterim, onFinal }).start()
    mock.triggerResult(makeResultEvent(0, [['done', true]]))
    expect(onFinal).toHaveBeenCalledWith('done')
    expect(onInterim).not.toHaveBeenCalled()
  })

  it('mixes finals + interims in a single event', () => {
    const mock = new MockRecognition()
    const onFinal = vi.fn()
    const onInterim = vi.fn()
    createVoiceInput({ recognitionFactory: () => mock, onInterim, onFinal }).start()
    mock.triggerResult(makeResultEvent(0, [
      ['first part ', true],
      ['still going', false],
    ]))
    expect(onFinal).toHaveBeenCalledWith('first part')
    expect(onInterim).toHaveBeenCalledWith('still going')
  })

  it('respects event.resultIndex — replays only new results', () => {
    const mock = new MockRecognition()
    const onFinal = vi.fn()
    createVoiceInput({ recognitionFactory: () => mock, onFinal }).start()
    // First event with resultIndex=0 replays just 'old'.
    mock.triggerResult(makeResultEvent(0, [['old', true]]))
    // Second event re-uses the same `results` collection but starts at 1,
    // so the loop iterates from index 1 onwards. results.length must be > 1
    // for the new final 'new' to be picked up.
    mock.triggerResult({ resultIndex: 1, results: [
      { isFinal: true, 0: { transcript: 'old' } },
      { isFinal: true, 0: { transcript: 'new' } },
    ] })
    expect(onFinal).toHaveBeenNthCalledWith(1, 'old')
    expect(onFinal).toHaveBeenNthCalledWith(2, 'new')
  })
})

describe('createVoiceInput — onerror', () => {
  it('passes through error event message and code', () => {
    const mock = new MockRecognition()
    const onError = vi.fn()
    createVoiceInput({ recognitionFactory: () => mock, onError }).start()
    mock.triggerError({ error: 'no-speech', message: 'No speech detected' })
    expect(onError).toHaveBeenCalledWith({ message: 'No speech detected', code: 'no-speech' })
  })

  it('falls back to a synthesized message when the error has no payload', () => {
    const mock = new MockRecognition()
    const onError = vi.fn()
    createVoiceInput({ recognitionFactory: () => mock, onError }).start()
    mock.triggerError({})
    expect(onError).toHaveBeenCalledTimes(1)
    const arg = onError.mock.calls[0]?.[0] as { message: string }
    expect(typeof arg.message).toBe('string')
    expect(arg.message.length).toBeGreaterThan(0)
  })
})

// Bug fix coverage for the QW1 Maestro review: 2+ consecutive finals from
// the SAME recognition session must accumulate against the freshest value,
// not against the closure-captured `value` from the render where the
// handle was created. composeVoiceAppend is the pure piece; the integration
// between consecutive onFinals (driven by valueRef in Composer.tsx) is
// asserted by the second test below which simulates the React lifecycle.
describe('composeVoiceAppend', () => {
  it('inserts exactly one space when previous has no trailing whitespace', () => {
    expect(composeVoiceAppend('hello', 'world')).toBe('hello world')
  })

  it('skips the separator when previous already ends in a space', () => {
    expect(composeVoiceAppend('hello ', 'world')).toBe('hello world')
  })

  it('skips the separator when previous ends in a newline', () => {
    expect(composeVoiceAppend('hello\n', 'world')).toBe('hello\nworld')
  })

  it('skips the separator when previous ends in a tab', () => {
    expect(composeVoiceAppend('hello\t', 'world')).toBe('hello\tworld')
  })

  it('returns previous unchanged when addition is only whitespace', () => {
    expect(composeVoiceAppend('hello', '   \n  ')).toBe('hello')
  })

  it('returns previous unchanged when addition is empty', () => {
    expect(composeVoiceAppend('hello', '')).toBe('hello')
  })

  it('returns addition alone when previous is empty (first chunk)', () => {
    expect(composeVoiceAppend('', 'hello')).toBe('hello')
  })

  it('preserves punctuation in the addition (no implicit trimming past word edges)', () => {
    expect(composeVoiceAppend('hello', 'world.')).toBe('hello world.')
  })

  it('CHAIN of three appends accumulates correctly (the actual gap scenario)', () => {
    let v = 'hi there'
    v = composeVoiceAppend(v, 'world')
    v = composeVoiceAppend(v, 'how are')
    v = composeVoiceAppend(v, 'you')
    expect(v).toBe('hi there world how are you')
  })
})

describe('voiceInput — valueRef chain integration', () => {
  it('two consecutive onFinal events compose against the latest value (via simulated ref sync)', () => {
    // Simulates the React lifecycle: `setValue` schedules a state update;
    // `valueRef.current` is updated synchronously inside the handler so
    // the NEXT onFinal in the same tick reads the latest base text. This
    // is exactly what Composer.tsx does after the QW1 review fix.
    const mock = new MockRecognition()
    const observed: string[] = []
    const valueRef = { current: 'hi' }
    const setValue = (next: string) => {
      observed.push(next)
      valueRef.current = next
    }
    const append = (text: string) => {
      const base = valueRef.current
      const trimmed = text.trim()
      if (!trimmed) return
      const sep = base && !base.endsWith(' ') && !base.endsWith('\n') ? ' ' : ''
      const next = base + sep + trimmed
      setValue(next)
    }

    createVoiceInput({ recognitionFactory: () => mock, onFinal: append }).start()
    mock.triggerResult(makeResultEvent(0, [['world', true]]))
    mock.triggerResult(makeResultEvent(0, [['foo', true]]))
    mock.triggerResult(makeResultEvent(0, [['bar', true]]))

    expect(observed).toEqual(['hi world', 'hi world foo', 'hi world foo bar'])
  })

  it('demonstrates the OLD bug shape would have produced wrong cumulative text', () => {
    // Counter-test (negative): shows that closing over a STALE `value`
    // (i.e. NOT using a ref) loses the accumulation. With ref pattern,
    // cumulative is preserved; without it (simulated here by ignoring
    // the ref and always reading 'hi'), every chunk resets to 'hi'.
    const captured = 'hi' as string
    const observed: string[] = []
    const appendBuggy = (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const sep = captured && !captured.endsWith(' ') && !captured.endsWith('\n') ? ' ' : ''
      const next = captured + sep + trimmed
      observed.push(next)
      // Note: NOT updating valueRef → next call still sees 'hi'.
    }
    appendBuggy('world')
    appendBuggy('foo')
    expect(observed).toEqual(['hi world', 'hi foo']) // WRONG: lost 'world'
  })
})
