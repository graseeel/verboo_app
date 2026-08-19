/**
 * background.test.js — behavioral tests for the service worker's
 * sender gate (FRENTE-B / B-2). The gate lives in a pure module
 * (src/controller/senderGate.js) applied by the onMessage listener in
 * background.js; these tests exercise the gate decision for every
 * sensitive message class and for the legitimate content-script traffic.
 *
 * Run: node --test src/background.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MSG } from './controller/protocol.js'
import {
  checkMessageSender,
  CONTENT_SCRIPT_ALLOWED_TYPES,
  isExtensionPageSender,
} from './controller/senderGate.js'

const RUNTIME_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const extensionPageSender = {
  id: RUNTIME_ID,
  url: `chrome-extension://${RUNTIME_ID}/src/panel/panel.html`,
}

const contentScriptSender = {
  id: RUNTIME_ID,
  url: 'https://example.com/some-page',
  tab: { id: 7 },
}

// Every message class the gate must protect: agent turns, approvals,
// auth, selection context, models, policy, routines (run/simulate/
// recovery, CRUD, schedule, drafts, recording controls, assets) and the
// legacy browserTool envelope. record_event is NOT in this list — it is
// the single type a content script may send.
const SENSITIVE_TYPES = [
  'browserTool',
  MSG.AGENT_TURN_START,
  MSG.AGENT_TURN_CANCEL,
  MSG.SELECTION_CONTEXT_GET,
  MSG.SELECTION_CONTEXT_DISCARD,
  MSG.TOOL_PENDING_LIST,
  MSG.TOOL_APPROVE,
  MSG.TOOL_DENY,
  MSG.AUTH_LOGIN,
  MSG.AUTH_LOGOUT,
  MSG.AUTH_REFRESH,
  MSG.AUTH_STATE_REQUEST,
  MSG.MODELS_LIST,
  MSG.MODELS_SELECT,
  MSG.POLICY_MODE_SET,
  MSG.POLICY_GRANT_UPSERT,
  MSG.POLICY_GRANT_REMOVE,
  MSG.ROUTINE_LIST,
  MSG.ROUTINE_GET,
  MSG.ROUTINE_CREATE,
  MSG.ROUTINE_UPDATE,
  MSG.ROUTINE_DUPLICATE,
  MSG.ROUTINE_DELETE,
  MSG.ROUTINE_RUN,
  MSG.ROUTINE_SIMULATE,
  MSG.ROUTINE_CANCEL,
  MSG.ROUTINE_PAUSE,
  MSG.ROUTINE_RESUME,
  MSG.ROUTINE_RUN_LIST,
  MSG.ROUTINE_RECOVERY_APPLY,
  MSG.ROUTINE_DRAFT_FROM_MESSAGE,
  MSG.ROUTINE_DRAFT_FROM_CONVERSATION,
  MSG.ROUTINE_DRAFT_GET,
  MSG.ROUTINE_ASSET_ADD,
  MSG.ROUTINE_ASSET_DELETE,
  MSG.ROUTINE_RECORD_START,
  MSG.ROUTINE_RECORD_STOP,
  MSG.ROUTINE_RECORD_CANCEL,
  MSG.ROUTINE_RECORD_STATE_REQUEST,
  MSG.ROUTINE_SCHEDULE_UPSERT,
  MSG.ROUTINE_SCHEDULE_REMOVE,
]

// Every MSG type in existence — used to prove the allowlist is
// exhaustive: NO message outside CONTENT_SCRIPT_ALLOWED_TYPES may come
// from a content script.
const ALL_MESSAGE_TYPES = [...new Set(Object.values(MSG))]

test('extension-page sender passes every sensitive message class', () => {
  for (const type of SENSITIVE_TYPES) {
    const gate = checkMessageSender(RUNTIME_ID, type, extensionPageSender)
    assert.equal(
      gate,
      'allowed',
      `extension page must pass ${type}, got ${JSON.stringify(gate)}`,
    )
  }
})

test('content script is rejected for EVERY sensitive message class', () => {
  for (const type of SENSITIVE_TYPES) {
    const gate = checkMessageSender(RUNTIME_ID, type, contentScriptSender)
    assert.deepEqual(
      gate,
      { rejected: true, reason: 'content_script_not_allowlisted' },
      `content script must be rejected for ${type}`,
    )
  }
})

test('allowlist is exhaustive: no message type outside it passes from a content script', () => {
  for (const type of ALL_MESSAGE_TYPES) {
    const gate = checkMessageSender(RUNTIME_ID, type, contentScriptSender)
    if (CONTENT_SCRIPT_ALLOWED_TYPES.has(type)) {
      assert.equal(gate, 'allowed', `allowlisted type must pass: ${type}`)
    } else {
      assert.equal(
        gate.rejected,
        true,
        `non-allowlisted type must be rejected from a content script: ${type}`,
      )
    }
  }
})

test('content script legitimately sends routine:record_event and passes', () => {
  const gate = checkMessageSender(RUNTIME_ID, MSG.ROUTINE_RECORD_EVENT, contentScriptSender)
  assert.equal(gate, 'allowed')
})

test('record_event from ANOTHER extension is rejected', () => {
  const foreignSender = {
    id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    url: 'https://example.com/other',
    tab: { id: 3 },
  }
  const gate = checkMessageSender(RUNTIME_ID, MSG.ROUTINE_RECORD_EVENT, foreignSender)
  assert.deepEqual(gate, { rejected: true, reason: 'not_our_extension' })
})

test('a page with no extension id at all is rejected', () => {
  const gate = checkMessageSender(RUNTIME_ID, MSG.AGENT_TURN_START, {
    url: 'https://evil.example.com/x',
  })
  assert.deepEqual(gate, { rejected: true, reason: 'not_our_extension' })
})

test('undefined sender is rejected', () => {
  const gate = checkMessageSender(RUNTIME_ID, MSG.AUTH_LOGIN, undefined)
  assert.deepEqual(gate, { rejected: true, reason: 'not_our_extension' })
})

test('extension-page URL under a DIFFERENT extension id is rejected', () => {
  const foreignPage = {
    id: 'cccccccccccccccccccccccccccccccc',
    url: `chrome-extension://${'cccccccccccccccccccccccccccccccc'}/src/panel/panel.html`,
  }
  const gate = checkMessageSender(RUNTIME_ID, MSG.MODELS_SELECT, foreignPage)
  assert.deepEqual(gate, { rejected: true, reason: 'not_our_extension' })
})

test('extension page passes for every message type (panel drives the whole surface)', () => {
  for (const type of ALL_MESSAGE_TYPES) {
    const gate = checkMessageSender(RUNTIME_ID, type, extensionPageSender)
    assert.equal(
      gate,
      'allowed',
      `extension page must pass ${type}, got ${JSON.stringify(gate)}`,
    )
  }
})

test('isExtensionPageSender distinguishes pages from content scripts', () => {
  assert.equal(isExtensionPageSender(RUNTIME_ID, extensionPageSender), true)
  assert.equal(isExtensionPageSender(RUNTIME_ID, contentScriptSender), false)
  assert.equal(isExtensionPageSender(RUNTIME_ID, undefined), false)
})
