/**
 * intentSignals.js — intent signals for the browser-tools decision
 * (ciclo Intenção+UX, FRENTE classificador).
 *
 * These signals complement shouldOfferBrowserTools's verb list WITHOUT
 * adding verbs (the verb list is whack-a-mole: every new verb a user
 * types outside it is a new miss):
 *
 *   - hasDeicticImperativeIntent — STRUCTURAL, any language: a
 *      verb-first clause whose object is anchored to the CURRENT page
 *      (deictic anchor + page noun). No verb list at all.
 *
 *   - hasImperativeWithObject — STRUCTURAL fall-open when the turn has a
 *      controllable page under the panel: verb-first clause + article +
 *      concrete object, gated against questions/explanations/desires.
 *
 *   - hasBrowserUnavailableAdmission — SEMANTIC: the ASSISTANT's own
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

export function hasDeicticImperativeIntent(value) {
  const text = normalizeIntentText(value)
  if (!text) return false
  return DEICTIC_IMPERATIVE_RE.test(text)
}

// ── L2: imperative with concrete object (fall-open with a page) ────
//
// The L1 skeleton WITHOUT the deictic anchor: verb-first clause +
// article + concrete object ("crie o produto ethos", "save the file").
// L2 only fires when the turn has a CONTROLLABLE page under the panel
// (shouldOfferBrowserTools receives activeTabUrl) — the page makes the
// imperative actionable. Still no verb list.
//
// The interrogative gate is structural (NOT a verb list): questions
// starting with o que/qual/como/what/how/… never match, so "o que é um
// produto?" and "como crio um produto?" stay conversation. "me conte
// sobre esta página" is excluded structurally by the article gate
// ("sobre" is a preposition, not an article).
const INTERROGATIVE_GATE_RE =
  /^(?:o\s+que|qual|quais|como|quando|onde|por\s+que|quem|quanto|quanta|que\s+tipo|what|which|how|why|when|where|who|whose)\b/i

// Explanation forms (PÓS-GATE Farol decision): explain/describe/define
// + article + object, and indirect "me conte/fale/diga …" — "explique a
// teoria", "descreva o produto", "tell me a story" stay CONVERSATION
// even with a controllable URL. The article/preposition is load-bearing:
// "explique ESTA página" (demonstrative, not article) is NOT gated —
// the page-anchored explanation path stays browser via the existing
// page-inspection detector in loop.js (both sides tested in loop.test.js).
//
// PRODUCT DECISION (Maestro, PÓS-GATE): COMMUNICATION imperatives
// ("mande um e-mail", "envie uma mensagem") are INTENTIONALLY browser —
// they imply an external action the tools can fulfill (compose/send in
// the mail app); do NOT gate them.
const EXPLANATION_GATE_RE =
  /^(?:(?:explique|descreva|defina|explain|describe|define)\s+(?:o|a|os|as|um|uma|uns|umas|the|an|sobre|about)\b|me\s+(?:conte|fale|diga|explique)\s+(?:o|a|os|as|um|uma|uns|umas|the|an|sobre|about|o\s+que|como|qual|quais|quando|onde|por\s+que|what|how|why)\b|tell\s+me\s+(?:a|an|the|about|what|how|why)\b)/i

// Declarative DESIRE (PÓS-GATE Farol decision): "preciso de um café",
// "eu quero um produto", "i need a coffee" stay CONVERSATION even with
// a URL. Only ENTITY desires are gated (desire + article/preposition +
// noun) plus the KNOWLEDGE family — saber/conhecer/to know/to find out,
// with the PT preposition 'de' OPTIONAL (PÓS-RE-GATE): "quero saber o
// que é ethos", "preciso saber o preço", "preciso conhecer o produto",
// "i want to know the price", "need to know…" stay conversation.
// A desire followed by an ACTION VERB is NOT gated: "quero criar um
// produto", "quero salvar o documento", "i want to create a product"
// stay browser — the user declared an action.
const DESIRE_GATE_RE =
  /^(?:(?:eu\s+)?(?:preciso|quero|queria|gostaria)\s+(?:de\s+)?(?:o|a|os|as|um|uma|uns|umas)\b|(?:eu\s+)?(?:preciso|quero|queria|gostaria)\s+(?:de\s+)?(?:saber|conhecer)\b|(?:i\s+)?(?:need|want)\s+(?:a|an|the|to\s+have|to\s+know|to\s+find\s+out)\b|i\s+would\s+like\s+(?:a|an|the|to\s+have|to\s+know|to\s+find\s+out)\b|i['’]?d\s+like\s+(?:a|an|the|to\s+have|to\s+know|to\s+find\s+out)\b)/i

// T6-B (Ciclo dos Achados de Campo): âncora dêitica de página — dêitico
// inequívoco + substantivo (o vocabulário de âncoras do L1). Quando o
// desejo de conhecimento aponta para a PÁGINA ("quero saber o preço deste
// produto"), o DESIRE_GATE NÃO se aplica — a pergunta é sobre o que está
// na tela, não uma pergunta geral. "quero saber o preço do iPhone 15"
// (sem dêitico) segue conversa. "este/esta/esse/essa" ficam de fora:
// após NFD strip, "está" vira "esta" (verbo) — falso positivo.
// R2 (gate ACHADOS-CAMPO): o dêitico deve ser DETERMINANTE de substantivo
// de página — (a) substantivo IMEDIATAMENTE após (não artigo/preposição/
// pronome/conjunção: "deste o livro" é verbo dar + artigo, não dêitico) e
// (b) sem pronome pessoal antes ("tu deste o livro" = verbo dar conjugado).
const DEICTIC_PAGE_ANCHOR_RE =
  /(?<!(?:eu|tu|voce|ele|ela|eles|elas|nos|vos|voces)\s+)(?:deste|desta|desse|dessa|neste|nesta|nesse|nessa|this)\s+(?!(?:o|a|os|as|um|uma|uns|umas|de|do|da|dos|das|no|na|nos|nas|em|para|com|por|que|se|e|ou|mas|me|te|lhe)\b)[a-z]+\b/i

const IMPERATIVE_WITH_OBJECT_RE =
  /^[a-z]+\s+(?:[a-z]+\s+){0,4}(?:o|a|os|as|um|uma|uns|umas|the|an)\s+[a-z]+\b/i

export function hasImperativeWithObject(value) {
  const text = normalizeIntentText(value)
  if (!text) return false
  if (INTERROGATIVE_GATE_RE.test(text)) return false
  if (EXPLANATION_GATE_RE.test(text)) return false
  // T6-B: o gate de desejo-de-conhecimento NÃO se aplica quando há âncora
  // dêitica de página — a pergunta é sobre a tela, não uma pergunta geral.
  if (DESIRE_GATE_RE.test(text) && !DEICTIC_PAGE_ANCHOR_RE.test(text)) return false
  return IMPERATIVE_WITH_OBJECT_RE.test(text)
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

function normalizeIntentText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\boque\b/g, 'o que')
    .trim()
    .toLowerCase()
}