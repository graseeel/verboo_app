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
 * @param {{ accessToken: string, model: string, messages: Array<object>, tools?: Array<object>, signal?: AbortSignal, timeoutMs?: number, refreshAccessToken?: () => Promise<string|null> }} params
 * @returns {Promise<{ content: string|null, toolCalls: Array<{id:string,name:string,arguments:string}> }>}
 */
export async function chatCompletion({
  accessToken,
  model,
  messages,
  tools,
  signal: externalSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  refreshAccessToken,
}) {
  if (!accessToken) throw new Error('chatCompletion: accessToken is required')
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
    let token = accessToken
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
        }),
        signal: controller.signal,
      })

      if (res.status === 401 && attempt === 0 && typeof refreshAccessToken === 'function') {
        const refreshed = await refreshAccessToken()
        if (typeof refreshed === 'string' && refreshed) {
          token = refreshed
          continue
        }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Router returned HTTP ${res.status}: ${body.slice(0, 200)}`)
      }

      const json = await readCompletionPayload(res)
      return parseCompletionResponse(json, { allowTextToolCalls: Boolean(tools?.length) })
    }
    throw new Error('Router authorization retry exhausted')
  } catch (err) {
    // Surface timeouts/cancels as plain Errors so the agent loop / fallback
    // can recover instead of leaving the panel stuck on "Working…".
    if (controller.signal.aborted) {
      if (externalSignal?.aborted) {
        throw new Error('Router request cancelled')
      }
      throw new Error(`Router timed out after ${timeoutMs}ms`)
    }
    throw err
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
export function parseCompletionResponse(json, options = {}) {
  if (!json || typeof json !== 'object') throw new Error('Router returned an unreadable response')
  const obj = /** @type {Record<string, unknown>} */ (json)
  let choices = Array.isArray(obj.choices) ? obj.choices : null
  if (!choices?.length && obj.message && typeof obj.message === 'object') {
    choices = [{ message: obj.message }]
  }
  if (!choices?.length) throw new Error('No choices in response')

  const message = /** @type {Record<string, unknown>|undefined} */ (choices[0].message)
  if (!message) throw new Error('No message in first choice')

  let content = typeof message.content === 'string' ? message.content : null
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

  if (Array.isArray(message.content)) {
    const textParts = []
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'text' && typeof part.text === 'string') textParts.push(part.text)
      if (part.type === 'tool_use' && typeof part.name === 'string') {
        toolCalls.push({
          id: typeof part.id === 'string' ? part.id : fallbackToolCallId(),
          name: part.name,
          arguments: JSON.stringify(part.input && typeof part.input === 'object' ? part.input : {}),
        })
      }
    }
    content = textParts.join('\n').trim() || null
  }

  if (
    toolCalls.length === 0 &&
    options.allowTextToolCalls &&
    /<(?:minimax:)?tool_call>/i.test(content ?? '')
  ) {
    const parsed = parseXmlToolCalls(content)
    if (parsed.length === 0) throw new Error('Router returned a malformed text tool call')
    toolCalls.push(...parsed)
    const remaining = content
      .replace(/<(?:minimax:)?tool_call>[\s\S]*?<\/(?:minimax:)?tool_call>/gi, '')
      .trim()
    content = remaining || null
  }
  return { content, toolCalls }
}

function parseXmlToolCalls(content) {
  const calls = []
  for (const match of content.matchAll(
    /<(?:minimax:)?tool_call>([\s\S]*?)<\/(?:minimax:)?tool_call>/gi,
  )) {
    const body = match[1]
    const invokes = [...body.matchAll(
      /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi,
    )]
    if (invokes.length > 0) {
      for (const invoke of invokes) {
        const params = parseNamedParameters(invoke[2])
        const name = normalizeTextToolName(decodeXml(invoke[1].trim()))
        if (name) {
          calls.push({
            id: fallbackToolCallId(),
            name,
            arguments: JSON.stringify(params),
          })
        }
      }
      continue
    }

    const rawFunction =
      body.match(/<function=([^>]+)>/i)?.[1] ??
      body.match(/<function>([^<]+)<\/function>/i)?.[1]
    if (!rawFunction) continue
    const params = {}
    for (const parameter of body.matchAll(/<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi)) {
      params[decodeXml(parameter[1].trim())] = decodeXml(parameter[2].trim())
    }
    Object.assign(params, parseNamedParameters(body))
    const functionName = decodeXml(rawFunction.trim())
    const name = functionName === 'browser' && typeof params.action === 'string'
      ? params.action
      : normalizeTextToolName(functionName)
    if (functionName === 'browser') delete params.action
    if (name) calls.push({ id: fallbackToolCallId(), name, arguments: JSON.stringify(params) })
  }
  return calls
}

function parseNamedParameters(body) {
  const params = {}
  for (const parameter of body.matchAll(
    /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi,
  )) {
    params[decodeXml(parameter[1].trim())] = decodeXml(parameter[2].trim())
  }
  return params
}

function normalizeTextToolName(name) {
  const value = String(name).trim()
  const browserToolNames = new Set([
    'click',
    'navigate',
    'read_page',
    'screenshot',
    'tab_group',
    'tabs',
    'type',
  ])
  if (value.startsWith('browser_')) {
    const unprefixed = value.slice('browser_'.length)
    if (browserToolNames.has(unprefixed)) return unprefixed
  }
  return value
}

async function readCompletionPayload(response) {
  if (typeof response.text !== 'function') {
    return response.json()
  }

  const body = await response.text()
  const contentType = response.headers?.get?.('content-type') ?? ''
  if (contentType.includes('text/event-stream') || /^\s*data:/m.test(body)) {
    return parseSseCompletion(body)
  }

  try {
    return JSON.parse(body)
  } catch {
    throw new Error('Router returned invalid JSON')
  }
}

function parseSseCompletion(body) {
  let completeMessage = null
  let content = ''
  const toolCalls = new Map()

  for (const event of String(body).split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') continue

    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      throw new Error('Router returned an unreadable SSE response')
    }
    if (payload?.error) {
      throw new Error(payload.error.message ?? String(payload.error))
    }

    const choice = payload?.choices?.[0]
    if (choice?.message && typeof choice.message === 'object') {
      completeMessage = choice.message
      continue
    }

    const delta = choice?.delta
    if (!delta || typeof delta !== 'object') continue
    if (typeof delta.content === 'string') content += delta.content
    for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(fragment?.index) ? fragment.index : toolCalls.size
      const current = toolCalls.get(index) ?? {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      }
      if (typeof fragment?.id === 'string') current.id = fragment.id
      if (typeof fragment?.function?.name === 'string') {
        current.function.name += fragment.function.name
      }
      if (typeof fragment?.function?.arguments === 'string') {
        current.function.arguments += fragment.function.arguments
      }
      toolCalls.set(index, current)
    }
  }

  if (completeMessage) {
    return { choices: [{ message: completeMessage }] }
  }
  if (!content && toolCalls.size === 0) {
    throw new Error('Router returned an unreadable SSE response')
  }
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.size > 0
          ? { tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) }
          : {}),
      },
    }],
  }
}

function decodeXml(value) {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

function fallbackToolCallId() {
  return `tc_${Math.random().toString(36).slice(2, 10)}`
}
