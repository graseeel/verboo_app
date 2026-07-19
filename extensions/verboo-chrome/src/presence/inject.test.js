/**
 * inject.test.js — pure-logic unit tests for presence constants/helpers.
 *
 * Does not exercise chrome.* (those require the extension runtime).
 * Run with: node --test src/presence/inject.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VERBOO_TAB_GROUP_TITLE,
  VERBOO_TAB_GROUP_COLOR,
  PRESENCE_ACTION_DELAY_MS,
  PRESENCE_ACTION_DELAY_MS_MIN,
  PRESENCE_ACTION_DELAY_MS_MAX,
  randomBetween,
  clearPresence,
  clearPresenceBestEffort,
  clearPresenceOnAllTabs,
} from './inject.js'

test('Verboo tab group title is "Verboo"', () => {
  assert.equal(VERBOO_TAB_GROUP_TITLE, 'Verboo')
})

test('Verboo tab group color is chrome.tabGroups purple', () => {
  assert.equal(VERBOO_TAB_GROUP_COLOR, 'purple')
})

test('presence action delay is visible long enough (cursor dwell)', () => {
  assert.equal(PRESENCE_ACTION_DELAY_MS_MIN, 420)
  assert.equal(PRESENCE_ACTION_DELAY_MS_MAX, 580)
  assert.ok(PRESENCE_ACTION_DELAY_MS >= 420)
  assert.ok(PRESENCE_ACTION_DELAY_MS <= 580)
})

test('randomBetween stays within [min, max]', () => {
  for (let i = 0; i < 40; i++) {
    const n = randomBetween(420, 580)
    assert.ok(n >= 420 && n <= 580, `got ${n}`)
  }
})

test('clearPresence and clearPresenceBestEffort are exported functions', () => {
  assert.equal(typeof clearPresence, 'function')
  assert.equal(typeof clearPresenceBestEffort, 'function')
  assert.equal(typeof clearPresenceOnAllTabs, 'function')
})

test('ensureAgentPresence and pulseAgentCursor are exported', async () => {
  const mod = await import('./inject.js')
  assert.equal(typeof mod.ensureAgentPresence, 'function')
  assert.equal(typeof mod.pulseAgentCursor, 'function')
  assert.equal(typeof mod.preparePresenceForAction, 'function')
  assert.equal(typeof mod.showAgentCursor, 'function')
})

test('clearPresence no-ops without a numeric tabId', async () => {
  await assert.doesNotReject(() => clearPresence(/** @type {any} */ (undefined)))
  await assert.doesNotReject(() => clearPresence(/** @type {any} */ (null)))
})
