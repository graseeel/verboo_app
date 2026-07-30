/**
 * routerClient.test.js — tests for parseCompletionResponse.
 * Run: node --test src/agent/routerClient.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatCompletion, parseCompletionResponse } from './routerClient.js'

test('parseCompletionResponse: standard OpenAI shape with text only', () => {
  const res = parseCompletionResponse({
    choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
  })
  assert.equal(res.content, 'Hello!')
  assert.deepEqual(res.toolCalls, [])
})

test('parseCompletionResponse: standard shape with tool_calls', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            function: { name: 'navigate', arguments: '{"url":"https://x.com"}' },
          },
        ],
      },
    }],
  })
  assert.equal(res.content, null)
  assert.equal(res.toolCalls.length, 1)
  assert.equal(res.toolCalls[0].id, 'call_1')
  assert.equal(res.toolCalls[0].name, 'navigate')
  assert.equal(res.toolCalls[0].arguments, '{"url":"https://x.com"}')
})

test('parseCompletionResponse: multiple tool_calls', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', function: { name: 'navigate', arguments: '{"url":"https://a.com"}' } },
          { id: 'c2', function: { name: 'read_page', arguments: '{"selector":"body"}' } },
        ],
      },
    }],
  })
  assert.equal(res.toolCalls.length, 2)
  assert.equal(res.toolCalls[0].name, 'navigate')
  assert.equal(res.toolCalls[1].name, 'read_page')
})

test('parseCompletionResponse: generates fallback id when id missing', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { function: { name: 'screenshot', arguments: '{}' } },
        ],
      },
    }],
  })
  assert.match(res.toolCalls[0].id, /^tc_/)
})

test('parseCompletionResponse: skips tool_calls with missing function', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', function: { name: 'navigate', arguments: '{}' } },
          { id: 'c2', function: null },
          { id: 'c3', no_function: true },
        ],
      },
    }],
  })
  assert.equal(res.toolCalls.length, 1)
  assert.equal(res.toolCalls[0].id, 'c1')
})

test('parseCompletionResponse: null content with no tool_calls is valid', () => {
  const res = parseCompletionResponse({
    choices: [{ message: { role: 'assistant', content: null } }],
  })
  assert.equal(res.content, null)
  assert.deepEqual(res.toolCalls, [])
})

test('parseCompletionResponse: throws on empty choices', () => {
  assert.throws(() => parseCompletionResponse({ choices: [] }), /No choices/)
})

test('parseCompletionResponse: throws on null input', () => {
  assert.throws(() => parseCompletionResponse(null), /unreadable/)
})

test('parseCompletionResponse: handles flat message shape (some routers)', () => {
  const res = parseCompletionResponse({
    message: { role: 'assistant', content: 'flat response' },
  })
  assert.equal(res.content, 'flat response')
  assert.deepEqual(res.toolCalls, [])
})

test('parseCompletionResponse: normalizes browser XML tool calls instead of exposing markup', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: '<tool_call><function=browser><parameter=action>navigate</parameter><parameter=url>https://example.com</parameter></tool_call>',
      },
    }],
  }, { allowTextToolCalls: true })

  assert.equal(res.content, null)
  assert.equal(res.toolCalls.length, 1)
  assert.equal(res.toolCalls[0].name, 'navigate')
  assert.deepEqual(JSON.parse(res.toolCalls[0].arguments), { url: 'https://example.com' })
})

test('parseCompletionResponse: normalizes MiniMax invoke tool markup shown by the extension', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: [
          'Vou abrir diretamente. 🚀',
          '<minimax:tool_call>',
          '<invoke name="browser_navigate">',
          '<parameter name="url">https://www.reddit.com</parameter>',
          '</invoke>',
          '</minimax:tool_call>',
        ].join('\n'),
      },
    }],
  }, { allowTextToolCalls: true })

  assert.equal(res.content, 'Vou abrir diretamente. 🚀')
  assert.equal(res.toolCalls.length, 1)
  assert.equal(res.toolCalls[0].name, 'navigate')
  assert.deepEqual(JSON.parse(res.toolCalls[0].arguments), {
    url: 'https://www.reddit.com',
  })
})

test('parseCompletionResponse: normalizes Anthropic tool_use content', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_page', input: { selector: 'h1' } },
        ],
      },
    }],
  })

  assert.equal(res.content, 'I will inspect it.')
  assert.deepEqual(res.toolCalls, [
    { id: 'toolu_1', name: 'read_page', arguments: '{"selector":"h1"}' },
  ])
})

test('chatCompletion retries one unauthorized request with a refreshed access token', async () => {
  const originalFetch = globalThis.fetch
  const authorizations = []
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    authorizations.push(init.headers.Authorization)
    calls += 1
    if (calls === 1) {
      return { ok: false, status: 401, text: async () => 'expired' }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    }
  }
  try {
    const result = await chatCompletion({
      accessToken: 'old-token',
      model: 'model',
      messages: [{ role: 'user', content: 'hello' }],
      refreshAccessToken: async () => 'new-token',
    })
    assert.equal(result.content, 'ok')
    assert.deepEqual(authorizations, ['Bearer old-token', 'Bearer new-token'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('chatCompletion accepts a complete OpenAI response delivered as SSE', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"message":{"role":"assistant","content":"Tudo certo."}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
  try {
    const result = await chatCompletion({
      accessToken: 'token',
      model: 'visual-model',
      messages: [{ role: 'user', content: 'teste' }],
    })
    assert.equal(result.content, 'Tudo certo.')
    assert.deepEqual(result.toolCalls, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('chatCompletion assembles streamed tool-call argument fragments', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"navigate","arguments":"{\\"url\\":\\"https://"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"example.com\\"}"}}]}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
  try {
    const result = await chatCompletion({
      accessToken: 'token',
      model: 'visual-model',
      messages: [{ role: 'user', content: 'abra o exemplo' }],
      tools: [{ type: 'function', function: { name: 'navigate' } }],
    })
    assert.deepEqual(result.toolCalls, [{
      id: 'call_1',
      name: 'navigate',
      arguments: '{"url":"https://example.com"}',
    }])
  } finally {
    globalThis.fetch = originalFetch
  }
})
