/**
 * Hard Block definitions — non-bypassable action classes the agent must
 * never execute, including under Skip mode.
 *
 * Each Hard Block has a `match` predicate (pure function) and an optional
 * `riskLabel` for display.
 *
 * Multi-user: zero hardcoded paths, users, tokens.
 */

/** @typedef {{ label: string; match: (input: string) => boolean }} HardBlockRule */

/** @type {HardBlockRule[]} */
export const HARD_BLOCKS = [
  {
    label: 'purchase',
    match(input) {
      const keywords = [
        /purchase/i, /buy\b/i, /checkout/i, /add-to-cart/i,
        /place\s*order/i, /confirm\s*purchase/i, /complete\s*purchase/i,
        /pay\b/i, /payment/i, /charge/i, /transaction/i,
      ]
      return keywords.some((re) => re.test(input))
    },
  },
  {
    label: 'create_account',
    match(input) {
      const keywords = [
        /create\s*account/i, /sign\s*up/i, /register/i,
        /create\s*profile/i, /create\s*user/i,
      ]
      return keywords.some((re) => re.test(input))
    },
  },
  {
    label: 'financial_trade',
    match(input) {
      // FRENTE-B (B-3): money movement is a hard block regardless of the
      // channel — PIX (PT-BR instant transfer), bank transfers (en + pt),
      // wire transfers, and Brazilian boletos.
      //
      // PÓS-GATE (Farol): a bare "transfer"/"transferir"/"wire" is NOT
      // enough — legitimate non-financial uses exist ("transfer to another
      // tab", "transferir o arquivo", "wire the data"). Unambiguous terms
      // and explicit money-movement compounds block standalone; bare
      // transfer verbs only block when a money-context word appears in the
      // same input (amount, bank/account, payment…).
      const keywords = [
        /trade/i, /invest/i, /buy\s*stock/i, /sell\s*stock/i,
        /place\s*trade/i, /execute\s*trade/i, /crypto/i,
        /swap\b/i, /stake/i,
        // Unambiguous instruments / compounds — intrinsically financial.
        /pix\b/i, /boleto/i,
        /bank\s*transfer/i, /wire\s*transfer/i,
        /transfer\s*(money|funds|payment|balance|cash)/i,
        /(money|funds|payment)\s*transfer/i,
        /transfer\s*(to|between)\s*(my\s+)?(account|bank)/i,
        /transferencia\s*bancaria/i,
        /transferir\s*dinheiro/i, /mandar\s*dinheiro/i, /enviar\s*dinheiro/i,
        /pagar\s*(um\s+)?(pix|boleto)/i,
      ]
      if (keywords.some((re) => re.test(input))) return true

      // Bare transfer verbs: blocked ONLY in a financial context.
      const moneyContext = [
        /money\b/i, /payment/i, /pay\b/i, /paid\b/i,
        /amount\b/i, /value\b/i, /valor\b/i, /quantia/i,
        /dinheiro/i, /funds/i, /cash\b/i, /saldo/i,
        /bank\b/i, /account\b/i, /conta\b/i, /banco\b/i,
        /deposit/i, /withdraw/i, /remessa/i,
        /fee\b/i, /taxa/i, /juros/i, /interest/i, /percent/i,
        /reais\b/i, /real\b/i, /dolares?/i, /dollars?/i, /euros?/i, /usd\b/i,
        /(\$|€|£)\s*\d|\d+\s*(usd|dol|reais|euro|eur|brl)/i,
      ]
      if (moneyContext.some((re) => re.test(input))
        && /transfer\b|transferir|transferencia|wire\b/i.test(input)) {
        return true
      }
      return false
    },
  },
  {
    label: 'mass_permanent_deletion',
    match(input) {
      const keywords = [
        /delete\s*(all|every|entire)\s/i, /remove\s*(all|every|entire)\s/i,
        /clear\s*(all|every|entire)\s/i, /wipe\s/i, /purge\s/i,
        /destroy\s/i, /nuke\s/i,
      ]
      return keywords.some((re) => re.test(input))
    },
  },
  {
    label: 'secret_exposure',
    match(input) {
      const keywords = [
        /paste\s*secret/i, /reveal\s*password/i, /show\s*api.?key/i,
        /expose\s*token/i, /leak\s*credential/i, /dump\s*env/i,
        /print\s*secret/i, /display\s*password/i, /output\s*.env/i,
      ]
      return keywords.some((re) => re.test(input))
    },
  },
  {
    label: 'prompt_injection_obedience',
    match(input) {
      const keywords = [
        /ignore\s*(your|system|user)\s*(instructions|policy|rules)/i,
        /disregard\s*(your|prior|previous)\s*(instructions|directives)/i,
        /override\s*system\s*prompt/i, /you\s*must\s*obey/i,
        /you\s*must\s*ignore/i,
      ]
      return keywords.some((re) => re.test(input))
    },
  },
]

/**
 * Check if a tool/action description matches any Hard Block.
 * @param {string} input — tool name + params as a single string to check
 * @returns {{ blocked: boolean; matchedLabel?: string }}
 */
export function checkHardBlock(input) {
  const subject = hardBlockSubject(input)
  const match = HARD_BLOCKS.find((rule) => rule.match(subject))
  return match
    ? { blocked: true, matchedLabel: match.label }
    : { blocked: false }
}

function hardBlockSubject(input) {
  if (!input || typeof input !== 'object') return String(input ?? '')
  const name = typeof input.name === 'string' ? input.name : ''
  const params = input.params && typeof input.params === 'object' ? input.params : {}
  if (name === 'click') {
    return params.selector == null
      ? String(input.input ?? name)
      : `click selector=${String(params.selector)}`
  }
  if (name === 'type') {
    if (params.selector == null && params.text == null) return String(input.input ?? name)
    return `type selector=${String(params.selector ?? '')} text=${String(params.text ?? '')}`
  }
  // URLs are destinations, not proof of a purchase/account/trade action.
  // Navigating to /buy or /register may be needed for harmless inspection.
  return name
}
