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
  hasImperativeWithObject,
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
// ── L2: imperative with concrete object (fall-open with a page) ────

test('L2: imperative with concrete object matches (no verb list)', () => {
  assert.equal(hasImperativeWithObject('crie o produto ethos'), true)
  assert.equal(hasImperativeWithObject('salve o produto com o nome ethos'), true)
  assert.equal(hasImperativeWithObject('preencha o formulário de contato'), true)
  assert.equal(hasImperativeWithObject('envie um e-mail para maria'), true)
  assert.equal(hasImperativeWithObject('create a new product'), true)
  assert.equal(hasImperativeWithObject('fill the form'), true)
})

test('L2: pure questions are excluded by the interrogative gate', () => {
  assert.equal(hasImperativeWithObject('o que é um produto?'), false)
  assert.equal(hasImperativeWithObject('como crio um produto?'), false)
  assert.equal(hasImperativeWithObject('qual é a capital do brasil?'), false)
  assert.equal(hasImperativeWithObject('when does the sale start?'), false)
  assert.equal(hasImperativeWithObject('o que é ethos?'), false)
})

test('L2: "me conte sobre esta página" stays out (sobre is not an article)', () => {
  assert.equal(hasImperativeWithObject('me conte sobre esta página'), false)
  assert.equal(hasImperativeWithObject('me explique sobre o assunto'), false)
})

// ── L2 PÓS-GATE: explanation + desire gates (Farol contra-examples) ─

test('L2 PÓS-GATE: direct explanation forms stay conversation (PT/EN)', () => {
  assert.equal(hasImperativeWithObject('explique a teoria'), false)
  assert.equal(hasImperativeWithObject('explique a teoria da relatividade'), false)
  assert.equal(hasImperativeWithObject('descreva o produto'), false)
  assert.equal(hasImperativeWithObject('defina o conceito'), false)
  assert.equal(hasImperativeWithObject('explain the theory'), false)
  assert.equal(hasImperativeWithObject('describe the product'), false)
  assert.equal(hasImperativeWithObject('define the concept'), false)
})

test('L2 PÓS-GATE: indirect explanation forms stay conversation', () => {
  assert.equal(hasImperativeWithObject('me conte uma história'), false)
  assert.equal(hasImperativeWithObject('me conte sobre esta página'), false)
  assert.equal(hasImperativeWithObject('me explique sobre o assunto'), false)
  assert.equal(hasImperativeWithObject('me diga o que é um produto'), false)
  assert.equal(hasImperativeWithObject('tell me a story'), false)
  assert.equal(hasImperativeWithObject('tell me about this page'), false)
})

test('L2 PÓS-GATE: declarative desires stay conversation (PT/EN)', () => {
  assert.equal(hasImperativeWithObject('preciso de um café'), false)
  assert.equal(hasImperativeWithObject('eu quero um produto'), false)
  assert.equal(hasImperativeWithObject('quero um produto'), false)
  assert.equal(hasImperativeWithObject('queria uma xícara de chá'), false)
  assert.equal(hasImperativeWithObject('gostaria de um livro'), false)
  assert.equal(hasImperativeWithObject('gostaria de saber o que é um produto'), false)
  assert.equal(hasImperativeWithObject('i need a coffee'), false)
  assert.equal(hasImperativeWithObject('i want a product'), false)
  assert.equal(hasImperativeWithObject("i'd like a coffee"), false)
  // …but a desire followed by an ACTION VERB is a declared action → browser.
  assert.equal(hasImperativeWithObject('quero criar um produto'), true)
  assert.equal(hasImperativeWithObject('preciso criar um produto'), true)
  assert.equal(hasImperativeWithObject('i want to create a product'), true)
})

test('L2 PÓS-GATE: page-anchored explanation is NOT an L2 imperative (inspection decides)', () => {
  // "explicar ESTA página" uses a demonstrative, not an article — L2 does
  // not fire on it (and the explanation gate does not swallow it). The
  // page-anchored explanation is turned BROWSER by hasPageInspectionIntent
  // in loop.js — both sides are proven in loop.test.js.
  assert.equal(hasImperativeWithObject('explique esta página'), false)
  assert.equal(hasImperativeWithObject('explain this page'), false)
})

test('L2 PÓS-GATE: COMMUNICATION imperatives stay browser (product decision)', () => {
  // PRODUCT DECISION (Maestro): "mande/envie e-mail/mensagem" imply an
  // external action the tools can fulfill — intentionally NOT gated.
  assert.equal(hasImperativeWithObject('mande um e-mail para maria'), true)
  assert.equal(hasImperativeWithObject('envie uma mensagem para joão'), true)
  assert.equal(hasImperativeWithObject('send a message to joão'), true)
})

// ── L2 PÓS-RE-GATE: knowledge family — 'de' optional + EN to know ──

test('L2 PÓS-RE-GATE: literal Farol forms — saber/conhecer stay conversation', () => {
  assert.equal(hasImperativeWithObject('quero saber o que é ethos'), false)
  assert.equal(hasImperativeWithObject('preciso saber o preço'), false)
  assert.equal(hasImperativeWithObject('preciso conhecer o produto'), false)
  assert.equal(hasImperativeWithObject('quero conhecer o produto'), false)
  // 'de' remains optional in the same family.
  assert.equal(hasImperativeWithObject('gostaria de saber o que é um produto'), false)
  assert.equal(hasImperativeWithObject('queria saber o preço'), false)
})

// ── T6-B (Ciclo dos Achados de Campo): dêitico vence o gate de conhecimento ──

test('T6-B: âncora dêitica de página (deste/desta/this + substantivo) vence o DESIRE_GATE — a pergunta é sobre a página', () => {
  assert.equal(hasImperativeWithObject('quero saber o preço deste produto'), true)
  assert.equal(hasImperativeWithObject('preciso saber o valor desta página'), true)
  assert.equal(hasImperativeWithObject('i want to know the price of this product'), true)
})

test('T6-B anti-FP: sem dêitico, o desejo de conhecimento segue conversa', () => {
  assert.equal(hasImperativeWithObject('quero saber o preço do iPhone 15'), false)
  assert.equal(hasImperativeWithObject('preciso saber o preço do produto'), false)
  assert.equal(hasImperativeWithObject('i want to know the price of the product'), false)
  // "está" (verbo) vira "esta" após NFD strip — NÃO é dêitico.
  assert.equal(hasImperativeWithObject('quero saber se o preço está caro'), false)
})

test('T6-B anti-FP R2: "deste" como verbo dar (pronome pessoal antes) NÃO é âncora dêitica', () => {
  assert.equal(hasImperativeWithObject('quero saber se tu deste o livro'), false)
  assert.equal(hasImperativeWithObject('quero saber se você deste o livro'), false)
  // O dêitico legítimo continua funcionando (substantivo imediatamente após).
  assert.equal(hasImperativeWithObject('quero saber o preço deste produto'), true)
})

test('L2 PÓS-RE-GATE: EN to know / to find out stay conversation', () => {
  assert.equal(hasImperativeWithObject('i want to know the price'), false)
  assert.equal(hasImperativeWithObject('need to know the price'), false)
  assert.equal(hasImperativeWithObject('i need to know the price'), false)
  assert.equal(hasImperativeWithObject('i want to find out the price'), false)
})

test('L2 PÓS-RE-GATE: declared ACTION stays browser (not gated)', () => {
  assert.equal(hasImperativeWithObject('quero criar um produto'), true)
  assert.equal(hasImperativeWithObject('quero salvar o documento'), true)
  assert.equal(hasImperativeWithObject('preciso criar um produto'), true)
  assert.equal(hasImperativeWithObject('i want to create a product'), true)
})
