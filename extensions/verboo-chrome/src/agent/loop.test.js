/**
 * loop.test.js — tests for the LLM agent loop.
 * Run: node --test src/agent/loop.test.js
 *
 * Mocks fetch to simulate one tool-call round-trip (navigate → OK → text reply).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── Save/restore original fetch ─────────────────────────────
const origFetch = globalThis.fetch

// Mock fetch: two sequential responses — first returns tool_call, second returns text.
let callIndex = 0
const MOCK_RESPONSES = [
  // Step 1: LLM calls navigate
  { ok: true, status: 200, json: async () => ({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [
      { id: 'tc_1', function: { name: 'navigate', arguments: '{"url":"https://example.com"}' } },
    ] } }],
  }) },
  // Step 2: LLM returns final text
  { ok: true, status: 200, json: async () => ({
    choices: [{ message: { role: 'assistant', content: 'Done navigating to example.com!' } }],
  }) },
]

globalThis.fetch = async () => {
  const resp = MOCK_RESPONSES[callIndex] ?? MOCK_RESPONSES[1]
  callIndex++
  return resp
}

let loopModule
try {
  loopModule = await import('./loop.js')
} finally {
  globalThis.fetch = origFetch
}

const { runLlmAgentTurn } = loopModule

test('runLlmAgentTurn: one tool-call round-trip (navigate then text)', async () => {
  callIndex = 0
  globalThis.fetch = async () => {
    const resp = MOCK_RESPONSES[callIndex] ?? MOCK_RESPONSES[1]
    callIndex++
    return resp
  }

  const broadcastCalls = []
  const executeCalls = []
  try {
    const result = await runLlmAgentTurn({
      turnId: 'turn_1',
      userMessage: 'open example.com',
      apiKey: 'test-key',
      modelId: 'test-model',
      broadcast: (msg) => broadcastCalls.push(msg),
      executeTool: async (tc) => {
        executeCalls.push(tc)
        return { ok: true, result: { text: 'page loaded' }, policy: { allowed: true, needsApproval: false } }
      },
      getActiveTabMeta: async () => ({ url: 'https://other.com', title: 'Other' }),
    })

    assert.equal(result.assistantMessage, 'Done navigating to example.com!')
    assert.equal(result.toolResults.length, 1)
    assert.equal(result.toolResults[0].toolCallId, 'tc_1')
    assert.equal(result.toolResults[0].success, true)
    assert.equal(executeCalls.length, 1)
    assert.equal(executeCalls[0].name, 'navigate')
    assert.equal(executeCalls[0].params.url, 'https://example.com')

    // Verify broadcast shapes match panel contract:
    // AGENT_TOOL_EXECUTING: { toolCallId, toolName }
    const executing = broadcastCalls.find(b => b.type === 'agent:tool_executing')
    assert.ok(executing)
    assert.equal(executing.toolCallId, 'tc_1')
    assert.equal(executing.toolName, 'navigate')

    // AGENT_TOOL_RESULT: { toolResult: { toolCallId, success, data, error, durationMs } }
    const resultBroadcast = broadcastCalls.find(b => b.type === 'agent:tool_result')
    assert.ok(resultBroadcast)
    assert.ok(resultBroadcast.toolResult)
    assert.equal(resultBroadcast.toolResult.toolCallId, 'tc_1')
    assert.equal(resultBroadcast.toolResult.success, true)
    assert.equal(typeof resultBroadcast.toolResult.durationMs, 'number')

    // AGENT_THOUGHT broadcasts present.
    const thoughts = broadcastCalls.filter(b => b.type === 'agent:thought')
    assert.ok(thoughts.length >= 2) // Analyzing + Calling navigate
    assert.ok(thoughts.every(t => typeof t.text === 'string'))
  } finally {
    globalThis.fetch = origFetch
  }
})

test('runLlmAgentTurn: text-only response (no tool calls)', async () => {
  callIndex = 0
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => ({
      choices: [{ message: { role: 'assistant', content: 'Just a question answer.' } }],
    }),
  })

  try {
    const result = await runLlmAgentTurn({
      turnId: 'turn_2',
      userMessage: 'what is 2+2?',
      apiKey: 'test-key',
      modelId: 'test-model',
      broadcast: () => {},
      executeTool: async () => { throw new Error('should not be called') },
      getActiveTabMeta: async () => null,
    })

    assert.equal(result.assistantMessage, 'Just a question answer.')
    assert.deepEqual(result.toolResults, [])
  } finally {
    globalThis.fetch = origFetch
  }
})

test('runLlmAgentTurn: internal-page active tab does NOT seed context', async () => {
  callIndex = 0
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => ({
      choices: [{ message: { role: 'assistant', content: 'Open a website first.' } }],
    }),
  })

  try {
    const result = await runLlmAgentTurn({
      turnId: 'turn_3',
      userMessage: 'help',
      apiKey: 'test-key',
      modelId: 'test-model',
      broadcast: () => {},
      executeTool: async () => { throw new Error('should not be called') },
      getActiveTabMeta: async () => ({ url: 'chrome://extensions', title: 'Extensions' }),
    })

    assert.equal(result.assistantMessage, 'Open a website first.')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('runLlmAgentTurn: throws when apiKey is missing', async () => {
  await assert.rejects(
    () => runLlmAgentTurn({
      turnId: 'x', userMessage: 'hi', apiKey: '', modelId: 'm',
      broadcast: () => {}, executeTool: async () => ({}), getActiveTabMeta: async () => null,
    }),
    /apiKey is required/,
  )
})

test('runLlmAgentTurn: throws when modelId is missing', async () => {
  await assert.rejects(
    () => runLlmAgentTurn({
      turnId: 'x', userMessage: 'hi', apiKey: 'k', modelId: '',
      broadcast: () => {}, executeTool: async () => ({}), getActiveTabMeta: async () => null,
    }),
    /modelId is required/,
  )
})

test('runLlmAgentTurn: propagates fetch errors so background can fallback', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down')
  }

  try {
    await assert.rejects(
      () => runLlmAgentTurn({
        turnId: 'turn_4',
        userMessage: 'do stuff',
        apiKey: 'test-key',
        modelId: 'test-model',
        broadcast: () => {},
        executeTool: async () => ({ ok: true, result: '', policy: {} }),
        getActiveTabMeta: async () => null,
      }),
      /network down/,
    )
  } finally {
    globalThis.fetch = origFetch
  }
})
