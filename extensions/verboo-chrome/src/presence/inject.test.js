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
} from './inject.js'

test('Verboo tab group title is "Verboo"', () => {
  assert.equal(VERBOO_TAB_GROUP_TITLE, 'Verboo')
})

test('Verboo tab group color is chrome.tabGroups purple', () => {
  // chrome.tabGroups.Color enum includes 'purple'
  assert.equal(VERBOO_TAB_GROUP_COLOR, 'purple')
})

test('presence action delay is brief (120–200ms range)', () => {
  assert.ok(PRESENCE_ACTION_DELAY_MS >= 120)
  assert.ok(PRESENCE_ACTION_DELAY_MS <= 200)
})
