/**
 * routerClient.js — HTTP client for the Verboo Router chat/completions endpoint.
 *
 * POST https://code.verboo.ai/router/v1/chat/completions
 * OpenAI-compatible: { messages, model, tools, tool_choice: 'auto' }.
 * Response parsed as OpenAI-style: { choices: [{ message }] }.
 *
 * Pure — no chrome.*. Only fetch() + AbortSignal. 60s timeout default.
 */

const CHAT_URL = 'https://code.verboo.ai/router/v1/chat/completions'
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Send a chat completion request to the Verboo Router.
 *
 * @param {{ apiKey: string, model: string, messages: Array<object>, tools?: Array<object>, signal?: AbortSignal, timeoutMs?: number }} params
 * @returns {Promise<{ content: string|null, toolCalls: Array<{id:string,name:string,arguments:string}> }>}
 */
export async function chatCompletion({
  apiKey,
  model,
  messages,
  tools,
  signal: externalSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!apiKey) throw new Error('chatCompletion: apiKey is required')
  if (!model) throw new Error('chatCompletion: model is required')
  if (!Array.isArray(messages)) throw new Error('chatCompletion: messages is required')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  if (externalSignal?.aborted) { clearTimeout(timer); controller.abort() }
  const onExternalAbort = () => controller.abort()
  if (externalSignal?.addEventListener) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: tools && tools.length > 0 ? tools : undefined,
        tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Router returned HTTP ${res.status}: ${body.slice(0, 200)}`)
    }

    const json = await res.json()
    return parseCompletionResponse(json)
  } finally {
    clearTimeout(timer)
    if (externalSignal?.removeEventListener) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }
}

/**
 * Parse an OpenAI-style chat completion response.
 * @param {unknown} json
 * @returns {{ content: string|null, toolCalls: Array<{id:string,name:string,arguments:string}> }}
 */
export function parseCompletionResponse(json) {
  if (!json || typeof json !== 'object') throw new Error('Router returned an unreadable response')
  const obj = /** @type {Record<string, unknown>} */ (json)
  let choices = Array.isArray(obj.choices) ? obj.choices : null
  if (!choices?.length && obj.message && typeof obj.message === 'object') {
    choices = [{ message: obj.message }]
  }
  if (!choices?.length) throw new Error('No choices in response')

  const message = /** @type {Record<string, unknown>|undefined} */ (choices[0].message)
  if (!message) throw new Error('No message in first choice')

  const content = typeof message.content === 'string' ? message.content : null
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const toolCalls = []
  for (const tc of rawToolCalls) {
    if (!tc || typeof tc !== 'object') continue
    const fn = /** @type {Record<string, unknown>|undefined} */ (tc.function)
    if (!fn || typeof fn !== 'object') continue
    const id = typeof tc.id === 'string' ? tc.id : `tc_${Math.random().toString(36).slice(2, 10)}`
    const name = typeof fn.name === 'string' ? fn.name : null
    const args = typeof fn.arguments === 'string' ? fn.arguments : '{}'
    if (name) toolCalls.push({ id, name, arguments: args })
  }
  return { content, toolCalls }
}
