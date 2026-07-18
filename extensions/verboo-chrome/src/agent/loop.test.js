/**
 * loop.test.js — tests for the LLM agent loop.
 * Run: node --test src/agent/loop.test.js
 *
 * Mocks fetch to simulate one tool-call round-trip (navigate → OK → text reply).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MSG } from '../controller/protocol.js'

// ── Save/restore original fetch ─────────────────────────────
const origFetch = globalThis.fetch

// Mock fetch: two sequential responses — first returns tool_call, second returns text.
let callIndex = 0
/** @type {Array<object>} */
let capturedBodies = []
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

function installMockFetch() {
  callIndex = 0
  capturedBodies = []
  globalThis.fetch = async (_url, init) => {
    if (init?.body) {
      try {
        capturedBodies.push(JSON.parse(init.body))
      } catch {
        // ignore
      }
    }
    const resp = MOCK_RESPONSES[callIndex] ?? MOCK_RESPONSES[1]
    callIndex++
    return resp
  }
}

let loopModule
try {
  installMockFetch()
  loopModule = await import('./loop.js')
} finally {
  globalThis.fetch = origFetch
}

const { runLlmAgentTurn } = loopModule

test('runLlmAgentTurn: one tool-call round-trip (navigate then text)', async () => {
  installMockFetch()

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
    assert.equal(result.toolResults[0].ok, true)
    assert.equal(executeCalls.length, 1)
    assert.equal(executeCalls[0].name, 'navigate')
    assert.equal(executeCalls[0].params.url, 'https://example.com')

    // Broadcasts use MSG constants and panel-friendly shapes.
    const thoughts = broadcastCalls.filter((b) => b.type === MSG.AGENT_THOUGHT)
    assert.ok(thoughts.length >= 1)

    const executing = broadcastCalls.filter((b) => b.type === MSG.AGENT_TOOL_EXECUTING)
    assert.equal(executing.length, 1)
    assert.equal(executing[0].toolCallId, 'tc_1')
    assert.equal(executing[0].toolName, 'navigate')

    const results = broadcastCalls.filter((b) => b.type === MSG.AGENT_TOOL_RESULT)
    assert.equal(results.length, 1)
    assert.equal(results[0].toolResult.toolCallId, 'tc_1')
    assert.equal(results[0].toolResult.success, true)
    assert.ok(typeof results[0].toolResult.data === 'string')

    // Second LLM call must receive OpenAI-protocol tool message (string content).
    assert.ok(capturedBodies.length >= 2)
    const secondMsgs = capturedBodies[1].messages
    const toolMsgs = secondMsgs.filter((m) => m.role === 'tool')
    assert.equal(toolMsgs.length, 1)
    assert.equal(toolMsgs[0].tool_call_id, 'tc_1')
    assert.equal(typeof toolMsgs[0].content, 'string')

    // No fake seed assistant tool_calls for read_page.
    const fakeSeed = secondMsgs.filter(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls)
        && m.tool_calls.some((tc) => tc.id === 'ctx_read' || tc.function?.name === 'read_page'),
    )
    assert.equal(fakeSeed.length, 0)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('runLlmAgentTurn: text-only response (no tool calls)', async () => {
  callIndex = 0
  capturedBodies = []
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

test('runLlmAgentTurn: screenshot tool result is string; image is separate user message', async () => {
  callIndex = 0
  capturedBodies = []
  const dataUrl = 'data:image/png;base64,AAAA'
  globalThis.fetch = async (_url, init) => {
    if (init?.body) {
      try {
        capturedBodies.push(JSON.parse(init.body))
      } catch { /* ignore */ }
    }
    // First call: screenshot tool; second: final text
    if (callIndex++ === 0) {
      return {
        ok: true, status: 200, json: async () => ({
          choices: [{ message: { role: 'assistant', content: null, tool_calls: [
            { id: 'tc_shot', function: { name: 'screenshot', arguments: '{}' } },
          ] } }],
        }),
      }
    }
    return {
      ok: true, status: 200, json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'I can see the page.' } }],
      }),
    }
  }

  try {
    const result = await runLlmAgentTurn({
      turnId: 'turn_shot',
      userMessage: 'take a screenshot',
      apiKey: 'test-key',
      modelId: 'test-model',
      broadcast: () => {},
      executeTool: async () => ({
        ok: true,
        result: { dataUrl, width: 100, height: 50 },
        policy: { allowed: true, needsApproval: false },
      }),
      getActiveTabMeta: async () => null,
    })

    assert.equal(result.assistantMessage, 'I can see the page.')
    assert.ok(capturedBodies.length >= 2)
    const msgs = capturedBodies[1].messages
    const toolMsg = msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'tc_shot')
    assert.ok(toolMsg)
    assert.equal(typeof toolMsg.content, 'string')
    assert.ok(!Array.isArray(toolMsg.content))

    const imageUser = msgs.find(
      (m) => m.role === 'user' && Array.isArray(m.content)
        && m.content.some((p) => p.type === 'image_url'),
    )
    assert.ok(imageUser)
    assert.equal(imageUser.content[1].image_url.url, dataUrl)
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
