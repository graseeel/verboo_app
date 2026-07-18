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
} from './inject.js'

test('Verboo tab group title is "Verboo"', () => {
  assert.equal(VERBOO_TAB_GROUP_TITLE, 'Verboo')
})

test('Verboo tab group color is chrome.tabGroups purple', () => {
  // chrome.tabGroups.Color enum includes 'purple'
  assert.equal(VERBOO_TAB_GROUP_COLOR, 'purple')
})

test('presence action delay is brief (280–380ms range)', () => {
  assert.equal(PRESENCE_ACTION_DELAY_MS_MIN, 280)
  assert.equal(PRESENCE_ACTION_DELAY_MS_MAX, 380)
  assert.ok(PRESENCE_ACTION_DELAY_MS >= 280)
  assert.ok(PRESENCE_ACTION_DELAY_MS <= 380)
})

test('randomBetween stays within [min, max]', () => {
  for (let i = 0; i < 40; i++) {
    const n = randomBetween(280, 380)
    assert.ok(n >= 280 && n <= 380, `got ${n}`)
  }
})

test('clearPresence and clearPresenceBestEffort are exported functions', () => {
  assert.equal(typeof clearPresence, 'function')
  assert.equal(typeof clearPresenceBestEffort, 'function')
})

test('clearPresence no-ops without a numeric tabId', async () => {
  // No chrome.scripting in node — non-numeric ids must not throw.
  await assert.doesNotReject(() => clearPresence(/** @type {any} */ (undefined)))
  await assert.doesNotReject(() => clearPresence(/** @type {any} */ (null)))
})
