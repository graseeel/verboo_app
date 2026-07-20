/**
 * routerClient.test.js — tests for parseCompletionResponse.
 * Run: node --test src/agent/routerClient.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCompletionResponse } from './routerClient.js'

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
