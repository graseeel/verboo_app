/**
 * intentSignals.test.js — L1 (deictic imperative) and L3 (browser-
 * unavailability admission) intent signals (ciclo Intenção+UX).
 *
 * L1 is tested in BOTH directions: a deictic imperative opens the
 * browser tools, and genuine conversation stays conversation.
 * L3 patterns are centralized in intentSignals.js — a new language is
 * added there, and this file locks the PT/EN coverage.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasBrowserUnavailableAdmission,
  hasDeicticImperativeIntent,
} from './intentSignals.js'

// ── L1: deictic imperative → browser tools ─────────────────────────

test('L1: deictic imperative opens browser tools (any language, no verb list)', () => {
  assert.equal(hasDeicticImperativeIntent('crie o produto desta página'), true)
  assert.equal(hasDeicticImperativeIntent('salve a alteração nesta aba'), true)
  assert.equal(hasDeicticImperativeIntent('adicione o item a esta lista'), true)
  assert.equal(hasDeicticImperativeIntent('preencha os dados nesta planilha'), true)
  assert.equal(hasDeicticImperativeIntent('create the product on this page'), true)
  assert.equal(hasDeicticImperativeIntent('add the item to this list'), true)
  // Page-inspection asks that the verb list also misses today.
  assert.equal(hasDeicticImperativeIntent('explique o que está nesta página'), true)
  assert.equal(hasDeicticImperativeIntent('me diga o que tem nesta aba'), true)
})

test('L1: genuine conversation stays conversation (no anchor / no page noun)', () => {
  // The literal field case: no deictic anchor — L1 must NOT catch it
  // (L3 handles it via the model admission).
  assert.equal(hasDeicticImperativeIntent('crie o produto ethos'), false)
  assert.equal(hasDeicticImperativeIntent('explique a teoria'), false)
  assert.equal(hasDeicticImperativeIntent('o que é ethos?'), false)
  // Knowledge question about "this page" — the article gate keeps it out.
  assert.equal(hasDeicticImperativeIntent('me conte sobre esta página'), false)
  assert.equal(hasDeicticImperativeIntent('conte sobre este assunto'), false)
  assert.equal(hasDeicticImperativeIntent('como crio um produto'), false)
  assert.equal(hasDeicticImperativeIntent('me explique como funciona o whatsapp'), false)
  assert.equal(hasDeicticImperativeIntent('mande uma mensagem para ela'), false)
})

// ── L3: browser-unavailability admission (assistant reply) ─────────

test('L3: PT-BR admissions are detected (case-insensitive)', () => {
  assert.equal(hasBrowserUnavailableAdmission('O navegador não está disponível neste momento.'), true)
  assert.equal(hasBrowserUnavailableAdmission('o navegador não estava disponível e pedi esclarecimentos.'), true)
  assert.equal(hasBrowserUnavailableAdmission('não tenho acesso ao navegador.'), true)
  assert.equal(hasBrowserUnavailableAdmission('não posso acessar o navegador agora.'), true)
  assert.equal(hasBrowserUnavailableAdmission('não consigo controlar o navegador.'), true)
  assert.equal(hasBrowserUnavailableAdmission('estou sem acesso ao navegador.'), true)
  assert.equal(hasBrowserUnavailableAdmission('estou sem ferramentas de navegador.'), true)
})

test('L3: EN admissions are detected (case-insensitive)', () => {
  assert.equal(hasBrowserUnavailableAdmission('The browser is not available right now.'), true)
  assert.equal(hasBrowserUnavailableAdmission('the browser is unavailable.'), true)
  assert.equal(hasBrowserUnavailableAdmission("I don't have access to the browser."), true)
  assert.equal(hasBrowserUnavailableAdmission("I can't access the browser."), true)
  assert.equal(hasBrowserUnavailableAdmission('I cannot control the browser.'), true)
  assert.equal(hasBrowserUnavailableAdmission('browser tools are not available for this turn.'), true)
  assert.equal(hasBrowserUnavailableAdmission('browser tools are unavailable.'), true)
})

test('L3: non-admissions do not match', () => {
  assert.equal(hasBrowserUnavailableAdmission('Posso explicar como o navegador funciona.'), false)
  assert.equal(hasBrowserUnavailableAdmission('o navegador está disponível.'), false)
  assert.equal(hasBrowserUnavailableAdmission('the browser is available.'), false)
  assert.equal(hasBrowserUnavailableAdmission('Aqui está a explicação completa sobre o assunto.'), false)
  assert.equal(hasBrowserUnavailableAdmission(''), false)
})

test('L3: only the reply opening is scanned (300 chars)', () => {
  const longReply = 'Aqui vai a resposta completa. '.repeat(30)
    + 'o navegador não está disponível no final do texto.'
  assert.equal(hasBrowserUnavailableAdmission(longReply), false)
  const leadingAdmission = 'o navegador não está disponível. ' + 'contexto. '.repeat(40)
  assert.equal(hasBrowserUnavailableAdmission(leadingAdmission), true)
})