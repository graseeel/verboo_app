/**
 * intentSignals.js — intent signals for the browser-tools decision
 * (ciclo Intenção+UX, FRENTE classificador).
 *
 * Two NEW signals complement shouldOfferBrowserTools's verb list WITHOUT
 * adding verbs (the verb list is whack-a-mole: every new verb a user
 * types outside it is a new miss):
 *
 *   1. hasDeicticImperativeIntent — STRUCTURAL, any language: a
 *      verb-first clause whose object is anchored to the CURRENT page
 *      (deictic anchor + page noun). No verb list at all.
 *
 *   2. hasBrowserUnavailableAdmission — SEMANTIC: the ASSISTANT's own
 *      reply admits it has no browser access ("o navegador não está
 *      disponível", "I don't have access to the browser"). Used to
 *      reclassify a conversation turn into a browser turn (L3).
 *
 * Pure — no chrome.*. Unit-tested in intentSignals.test.js.
 */

// ── L1: deictic imperative ─────────────────────────────────────────
//
// Verb-first clause + article + object + deictic anchor + page noun.
// The ANCHOR + PAGE NOUN are load-bearing (same philosophy as
// hasPageInspectionIntent's pageReference): "crie o produto desta
// página" offers browser tools, while "explique a teoria", "o que é
// ethos?" and "me conte sobre esta página" (knowledge questions) stay
// conversation. The article between the verb and the anchor keeps
// "tell me about this page" / "me conte sobre esta página" out.
//
// Expects RAW text; normalization (NFD strip, lowercase, oque→o que)
// happens here, mirroring loop.js's normalizeIntentText.
const DEICTIC_IMPERATIVE_RE =
  /^(?:(?:por\s+favor|please)\s+)?[a-z]+\s+(?:[a-z]+\s+){0,4}(?:o|a|os|as|um|uma|uns|umas|the|an)\s+(?:[a-z]+\s+){0,4}(?:esta|essa|desta|dessa|nesta|nessa|neste|nesse|deste|desse|this|that|here|there)\s+(?:pagina|page|aba|tab|site|tela|screen|janela|window|lista|list|formulario|form|secao|section|campo|field|planilha|spreadsheet)\b/i

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasDeicticImperativeIntent(value) {
  const text = normalizeIntentText(value)
  if (!text) return false
  return DEICTIC_IMPERATIVE_RE.test(text)
}

// ── L3: browser-unavailability admission (assistant reply) ─────────
//
// CENTRALIZED, extensible: patterns for a NEW language are appended to
// BROWSER_UNAVAILABLE_ADMISSION_PATTERNS — nothing else changes. Only
// the ASSISTANT's own reply is ever tested (the hook in loop.js passes
// completion.content), so a user question like "por que o navegador
// não está disponível?" can never trigger it.
//
// Only the reply's OPENING is scanned (first 300 chars): the admission
// typically leads the answer, and a passing mention deeper in a long
// reply should not reclassify a genuine conversation.
const BROWSER_UNAVAILABLE_ADMISSION_PATTERNS = Object.freeze([
  // ── PT-BR ──
  // "o navegador não está/estava disponível/acessível"
  /\bnavegador\b[^.\n]{0,60}\bn[ãa]o\s+est[áa](?:va)?\s+(?:dispon[ií]vel|acess[ií]vel)\b/i,
  // "não tenho acesso ao navegador" / "não posso/consigo acessar|controlar o navegador"
  /\bn[ãa]o\s+(?:tenho|possuo|tem|possui)\s+acesso\s+(?:ao|a|o)\s+navegador\b/i,
  /\bn[ãa]o\s+(?:posso|consigo)\s+(?:acessar|controlar|usar|operar)\s+(?:o\s+|a\s+)?navegador\b/i,
  // "estou sem acesso ao navegador" / "sem ferramentas de navegador"
  /\bsem\s+(?:acesso|ferramentas?)\s+(?:ao|a|de|do)\s+navegador\b/i,
  // ── EN ──
  // "the browser is not/isn't available/accessible", "browser unavailable"
  /\bbrowser\b[^.\n]{0,60}\b(?:isn'?t|is\s+not|not)\s+(?:available|accessible)\b/i,
  /\bbrowser\b[^.\n]{0,60}\bunavailable\b/i,
  // "I don't have access to the browser" / "can't access/control/use the browser"
  /\b(?:i\s+)?(?:don'?t|do\s+not|cannot|can'?t|have\s+no|havent)\s+(?:have\s+)?(?:access\s+to\s+|access|control|use|operate)\s*(?:the\s+)?(?:browser|chrome)\b/i,
  // "browser tools are not available / unavailable / disabled"
  /\bbrowser\s+tools?\b[^.\n]{0,40}\b(?:are\s+)?(?:not\s+)?(?:available|unavailable|disabled)\b/i,
])

/**
 * @param {unknown} value — the assistant's reply text (never the user message)
 * @returns {boolean}
 */
export function hasBrowserUnavailableAdmission(value) {
  const text = String(value ?? '').slice(0, 300)
  if (!text) return false
  return BROWSER_UNAVAILABLE_ADMISSION_PATTERNS.some((re) => re.test(text))
}

/** @param {unknown} value */
function normalizeIntentText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\boque\b/g, 'o que')
    .trim()
    .toLowerCase()
}