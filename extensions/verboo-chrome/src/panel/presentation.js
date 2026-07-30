/**
 * Small, pure presentation helpers shared by the side-panel UI and tests.
 * Model labels stay catalog-driven; no provider or model IDs are hardcoded.
 */

/**
 * @param {{ id?: string, name?: string, displayName?: string }} model
 * @returns {string}
 */
export function modelDisplayName(model) {
  const id = String(model?.id ?? '').trim()
  const supplied = String(model?.displayName || model?.name || '').trim()
  if (supplied && supplied !== id) return supplied
  return humanizeModelId(id) || supplied || 'Model'
}

/** @param {string} id */
export function humanizeModelId(id) {
  return String(id ?? '')
    .trim()
    .split(/[\s/_-]+/)
    .filter(Boolean)
    .map((token) => {
      if (/^[a-z]{1,3}$/i.test(token)) return token.toUpperCase()
      if (/^[a-z]\d/i.test(token)) return token.toUpperCase()
      if (/^\d+[a-z]$/i.test(token)) return token.toUpperCase()
      const match = token.match(/^([a-z]+)(\d.*)$/i)
      if (match) return `${capitalize(match[1])} ${match[2].toUpperCase()}`
      return capitalize(token)
    })
    .join(' ')
}

/**
 * Render the deliberately small Markdown subset used in assistant summaries.
 * Input is escaped first, so assigning the result to innerHTML cannot execute
 * model-provided markup. Supported: bold, inline code, and line breaks.
 * @param {unknown} value
 * @returns {string}
 */
export function safeMarkdownToHtml(value) {
  return escapeHtml(String(value ?? ''))
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/\r?\n/g, '<br>')
}

/**
 * Translate a backend error code without leaking unknown internal codes.
 * @param {unknown} errorCode
 * @param {string} fallbackKey
 * @param {(key: string) => string} translate
 * @returns {string}
 */
export function translatedErrorMessage(errorCode, fallbackKey, translate) {
  const code = String(errorCode ?? '').trim()
  if (!code) return translate(fallbackKey)
  const translated = translate(code)
  return translated && translated !== code ? translated : translate(fallbackKey)
}

/**
 * Avoid stacking the same error twice when the user repeats an action.
 * @param {unknown} previousError
 * @param {unknown} nextError
 * @returns {boolean}
 */
export function shouldAppendError(previousError, nextError) {
  const previous = String(previousError ?? '')
  const next = String(nextError ?? '')
  return !previous || previous !== next
}

/**
 * Submit only for an unmodified Enter that was not already handled by
 * another interaction, such as the slash menu or an IME composition.
 * @param {{key?: string, shiftKey?: boolean, isComposing?: boolean, defaultPrevented?: boolean}} event
 * @returns {boolean}
 */
export function shouldSubmitComposerKey(event) {
  return event?.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && !event.defaultPrevented
}

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function capitalize(value) {
  const text = String(value ?? '')
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}
