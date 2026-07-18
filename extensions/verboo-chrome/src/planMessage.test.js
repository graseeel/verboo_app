/**
 * planMessage.test.js — unit tests for the agent planner heuristic.
 *
 * Run with: node --test src/planMessage.test.js
 *
 * Pure-function tests — no chrome.* shim required.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  planForMessage,
  extractUrl,
  matchSiteToken,
  isControllableUrl,
  nonControllablePageMessage,
} from './planMessage.js'

// ── isControllableUrl ───────────────────────────────────────

test('isControllableUrl: accepts https and http', () => {
  assert.equal(isControllableUrl('https://example.com'), true)
  assert.equal(isControllableUrl('http://example.com/path'), true)
  assert.equal(isControllableUrl('HTTPS://Example.Com'), true) // case-insensitive
})

test('isControllableUrl: rejects chrome / about / edge / file', () => {
  assert.equal(isControllableUrl('chrome://extensions'), false)
  assert.equal(isControllableUrl('chrome-extension://abcdef/options.html'), false)
  assert.equal(isControllableUrl('about:blank'), false)
  assert.equal(isControllableUrl('edge://settings'), false)
  assert.equal(isControllableUrl('file:///Users/x/index.html'), false)
  assert.equal(isControllableUrl('view-source:https://example.com'), false)
})

test('isControllableUrl: rejects empty / null / undefined / ftp', () => {
  assert.equal(isControllableUrl(''), false)
  assert.equal(isControllableUrl(null), false)
  assert.equal(isControllableUrl(undefined), false)
  assert.equal(isControllableUrl('ftp://example.com'), false)
})

// ── extractUrl ──────────────────────────────────────────────

test('extractUrl: returns first http(s) match', () => {
  assert.equal(extractUrl('open https://example.com for me'), 'https://example.com')
  assert.equal(extractUrl('go to http://foo.bar/path?x=1'), 'http://foo.bar/path?x=1')
})

test('extractUrl: falls back to a known site token', () => {
  assert.equal(extractUrl('open youtube for me'), 'https://www.youtube.com')
  assert.equal(extractUrl('go to github'), 'https://github.com')
  assert.equal(extractUrl('abra o gmail'), 'https://mail.google.com')
})

test('extractUrl: does NOT invent an arbitrary domain', () => {
  assert.equal(extractUrl('open myblog'), null)
  assert.equal(extractUrl('go to the thing'), null)
})

test('extractUrl: returns null for empty / non-string input', () => {
  assert.equal(extractUrl(''), null)
  assert.equal(extractUrl(null), null)
  assert.equal(extractUrl(undefined), null)
  assert.equal(extractUrl(42), null)
})

// ── matchSiteToken ──────────────────────────────────────────

test('matchSiteToken: returns canonical URL for first hit', () => {
  assert.equal(matchSiteToken('search youtube for cats'), 'https://www.youtube.com')
  assert.equal(matchSiteToken('check my github'), 'https://github.com')
  assert.equal(matchSiteToken('open x.com'), 'https://x.com')
})

test('matchSiteToken: prefers multi-word tokens over single-word', () => {
  const result = matchSiteToken('look at stack overflow')
  assert.equal(result, 'https://stackoverflow.com')
})

test('matchSiteToken: returns null when nothing matches', () => {
  assert.equal(matchSiteToken('hello world'), null)
})

// ── planForMessage — navigate intent (EN + PT) ──────────────

test('planForMessage: EN "open <url>" produces a navigate', () => {
  const r = planForMessage('open https://example.com', 'https://example.com')
  assert.equal(r.assistantMessage, undefined)
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'navigate')
  assert.equal(r.plan[0].url, 'https://example.com')
  assert.equal(r.plan[0].params.url, 'https://example.com') // back-compat
  assert.equal(r.plan[0].risk, 'mutate')
})

test('planForMessage: PT "abra o youtube" navigates from chrome:// page', () => {
  // The exact bug from the owner video: "abra o youtube para mim" on
  // chrome://extensions. Planner must NOT fall back to read_page.
  const r = planForMessage('abra o youtube para mim', 'chrome://extensions')
  assert.equal(r.assistantMessage, undefined)
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'navigate')
  assert.equal(r.plan[0].url, 'https://www.youtube.com')
})

test('planForMessage: EN "go to <site>" with site token', () => {
  const r = planForMessage('go to github', 'https://example.com')
  assert.equal(r.assistantMessage, undefined)
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'navigate')
  assert.equal(r.plan[0].url, 'https://github.com')
})

test('planForMessage: PT intent verbs (abrir, abre, ir para, acessar)', () => {
  const cases = [
    ['abrir gmail', 'https://mail.google.com'],
    ['abre o twitter', 'https://x.com'],
    ['vai para o google', 'https://www.google.com'],
    ['ir para reddit', 'https://www.reddit.com'],
    ['acessar wikipedia', 'https://www.wikipedia.org'],
    ['acesso chatgpt', 'https://chatgpt.com'],
  ]
  for (const [msg, expected] of cases) {
    const r = planForMessage(msg, 'chrome://extensions')
    assert.equal(r.plan.length, 1, `expected 1 tool for "${msg}"`)
    assert.equal(r.plan[0].name, 'navigate', `expected navigate for "${msg}"`)
    assert.equal(r.plan[0].url, expected, `expected ${expected} for "${msg}"`)
  }
})

test('planForMessage: navigate intent without site/URL returns empty + friendly hint', () => {
  const r = planForMessage('open myblog', 'chrome://extensions')
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
  assert.match(r.assistantMessage, /name or URL/i)
})

// ── planForMessage — internal-page fallback ─────────────────

test('planForMessage: internal page + no intent returns friendly error', () => {
  const r = planForMessage('read this for me', 'chrome://extensions')
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
  assert.match(r.assistantMessage, /cannot be controlled/i)
})

test('planForMessage: internal page + navigate intent falls through to navigate', () => {
  const r = planForMessage('abra o youtube', 'chrome://extensions')
  assert.equal(r.assistantMessage, undefined)
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'navigate')
})

test('planForMessage: about:blank also blocks read_page fallback', () => {
  const r = planForMessage('summarise this page', 'about:blank')
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
  assert.match(r.assistantMessage, /cannot be controlled/i)
})

test('planForMessage: edge:// also blocks read_page fallback', () => {
  const r = planForMessage('summarise this page', 'edge://settings')
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
})

// ── planForMessage — purchase / read fallback ───────────────

test('planForMessage: "buy" produces a click on buy-now (Hard Block target)', () => {
  const r = planForMessage('buy me a laptop', 'https://example.com')
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'click')
  assert.equal(r.plan[0].params.selector, 'button#buy-now')
})

test('planForMessage: unknown request on controllable page falls back to read_page', () => {
  const r = planForMessage('what does this page say?', 'https://example.com')
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'read_page')
})

test('planForMessage: empty message returns empty plan + assistant message', () => {
  const r = planForMessage('', 'https://example.com')
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
})

test('planForMessage: handles missing/undefined active tab URL safely', () => {
  const r = planForMessage('what does this say?', undefined)
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
})

// ── nonControllablePageMessage ──────────────────────────────

test('nonControllablePageMessage: surfaces scheme name', () => {
  const msg = nonControllablePageMessage('chrome://extensions')
  assert.match(msg, /chrome:\/\//)
  assert.match(msg, /Open a normal website/)
})

test('nonControllablePageMessage: works without URL', () => {
  const msg = nonControllablePageMessage(undefined)
  assert.match(msg, /cannot be controlled/i)
})